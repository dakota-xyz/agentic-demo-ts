# CLAUDE.md

Working notes for anyone — human or AI — changing this repo. The product story
lives in [README.md](./README.md) and [docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md);
this file is what you need in your head before you touch the code.

---

## The one invariant

**The agent drafts. A person signs. The platform enforces.**

Nothing in this repo may weaken that. The app never holds a signing key, never
approves on a user's behalf, and never decides that a payment is within a limit
— the Dakota platform re-derives the canonical bytes and checks the mandate at
fire time. If a change would make "the model decided not to" the thing standing
between a user and their money, the change is wrong.

Practical consequences you will hit:

- A Slack button **links into the app**; it cannot approve. There is no browser,
  no origin and no secure enclave inside an HTTP callback.
- `POST /api/mandates/[id]/…` builds a challenge and forwards an assertion. If
  you find yourself wanting a private key server-side, stop.
- Agents cannot mint their own authority: the client is registered with
  `agenticPolicy.set({ mandate_strategy: 'external_only' })`.

---

## Running it locally

```sh
# No registry auth needed — every dependency is public. (The UI once came from a
# private GitHub Packages scope; it now lives in src/theme over plain Mantine.)

# 1. Postgres
brew install postgresql@17 && brew services start postgresql@17
createdb agentic_demo_ts

# 2. Config
cp .env.example .env.local     # or use the sandbox file you were given

# 3. Go
npm install
npm run dev                    # http://localhost:3000
```

**Sign-in on localhost does not use Google.** The shared OAuth client is a
public browser-token client, and Google refuses to issue a token to an origin
that is not on that client's authorized list — `http://localhost:3000` is not on
it. Set `DEMO_DEV_LOGIN=true` and the sign-in page takes a typed address and
trusts it. (Alternative: add localhost to the OAuth client's authorized
JavaScript origins.)

**First run provisions itself.** Tables are created on demand
(`CREATE TABLE IF NOT EXISTS` in `src/lib/store.ts`), and the first sign-in
creates a platform customer, signer group, policies and two wallets. No
migrations, no seed script, no manual provisioning.

| Command | |
|---|---|
| `npm run dev` | Next dev server |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run build` | production build |

**The live test is the one that matters.** `src/lib/sandbox.live.test.ts` runs
against the real sandbox platform — provisioning, idempotency, agent creation, a
chat turn. It skips itself unless `DAKOTA_API_KEY` and `DATABASE_URL` are both
set, so CI stays green without mocks:

```sh
npx vitest run src/lib/sandbox.live.test.ts
```

It catches what types cannot — e.g. a freshly created agent is `pending` and
refuses to talk until it is attached to a wallet.

---

## Environment

### How config reaches the app

There is no config file, no profile, and no "local vs production" mode. One
chain, and it is worth knowing because every setup failure is somewhere on it:

```
npm run dev
  → next dev            Next reads .env.local into process.env at boot
    → src/lib/store.ts  pool() = new Pool({ connectionString: process.env.DATABASE_URL })
    → src/lib/dakota.ts new DakotaClient({ apiKey: process.env.DAKOTA_API_KEY,
                                           environment: dakotaEnvironment() })
```

So "it uses the local database" is not a default the app chose — it is whatever
string `DATABASE_URL` holds. Point it at localhost and it is local; point it at
Neon and it is Neon. There is **no fallback**: `pool()` throws
`DATABASE_URL is not set` rather than quietly connecting somewhere, which is
deliberate — a demo that silently writes to the wrong database is worse than one
that will not start.

Two consequences that catch people:

- **The file must be named `.env.local`.** Next loads `.env.local`,
  `.env.development.local`, `.env.development`, `.env` — and nothing else. A
  file called `.env.sandbox.local` or `.env.prod.local` is never read; rename it
  on the way in.
- **Shell variables win over the file.** `DATABASE_URL=… npm run dev` overrides
  `.env.local` for that run, which is how the live test is pointed at a scratch
  database without editing anything.

Use **npm**, not yarn or pnpm — `package-lock.json` is the lockfile in the repo.
There is no `.npmrc`: every dependency is public, so `npm install` and `npm ci`
need no token, no registry config, and no peer-dep flag.

### The variables

`.env.example` is the authoritative list with reasoning inline. The short
version:

| Required | Why |
|---|---|
| `DAKOTA_API_KEY` | the only external credential in the whole app |
| `DATABASE_URL` | users, tenancy, transcripts, channel links |
| `AUTH_SECRET` | signs the session cookie |
| `DEMO_KEY_SALT` | derives the service signer — see the trap below |
| `GOOGLE_CLIENT_ID` | not a secret; ships to every browser |

| Optional | Absent ⇒ |
|---|---|
| `DAKOTA_ENV` | `sandbox`. Only `sandbox` or `production` are accepted, and `isSandbox()` gates the KYB overrides on it |
| `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` | Slack integration is off |
| `POSTMARK_*` | invoices still parse; no email reply is sent |
| `SALESFORCE_*` | no lead capture; sign-in is never affected |
| `CRON_SECRET` | settlement sweep route is unguarded/unused locally |
| `TENANCY_MODE=team` | defaults to `visitor` — one account per person |

Traps, each learned the hard way:

- **`DEMO_KEY_SALT` can never change.** It derives the service signer seeding
  every wallet's signer group. A new value orphans every existing wallet.
- **`DATABASE_URL` must be pooled** on serverless (Neon `-pooler`, not
  `DATABASE_URL_UNPOOLED`).
- **`DEMO_DEV_LOGIN` must be absent on any deployment.** The credentials
  provider is not even constructed unless the value is exactly `true`.
- **No LLM key exists.** The agent runs on the platform; `instructions.create`
  and `resumeAgentConversation` are the calls. Do not add one.
- **`DAKOTA_ENV` selects the environment, and nothing passes a `baseURL`.** The
  SDK owns a URL per environment; `isSandbox()` in `src/lib/dakota.ts` is what
  guards the KYB overrides, so that question is answered by a declared value
  rather than by pattern-matching a host.

---

## Shape of the code

```
src/
  app/api/
    chat/            one agent turn; transcript persisted and resent each turn
    proposals/       accept a plan → scheduled payments (+ an UNSIGNED mandate)
    mandates/[id]/   §8 challenge out, passkey assertion back
    passkey/         enrol; attaches the key to every wallet's signer group
    slack/events/    Slack → agent, acknowledged in under 3s
    email/inbound/   Postmark → agent, invoice parsed by the platform
    cron/settlements settlement announcements with nobody watching
  lib/
    dakota.ts        the SDK client — read its comments before editing
    store.ts         Postgres; one JSONB document per user, plus `teams`
    tenancy.ts       team vs visitor; who owns which customer
    provision.ts     customer, signer group, policies, wallets
    webauthn.ts      the passkey seam — this server holds no user key
    work-domain.ts   who gets in
    slack/           HMAC verification, which messages to answer, Markdown → mrkdwn
  theme/             the Mantine theme + the few custom components (was @dakota-xyz/ui)
  components/        the UI (Mantine 8 via src/theme)
```

**Tenancy.** `TENANCY_MODE=team` puts everyone in one shared account; the
mapping lives in the `teams` table, and `TEAM_CUSTOMER_ID` is read only by
`scripts/provision-team.mjs`, never by the app. Otherwise each signed-in address
gets its own customer and wallets. In team mode, passkey enrolment calls
`tenancyFor` — **not** `ensureTenancy` — or a second person would get a private
account instead of joining the team.

### The data model

Two tables, both `(id/email text PRIMARY KEY, data jsonb, updated_at)`, created
on demand by `ensureSchema()`. **All state is one JSONB document per user** (or
per team) — there is no relational schema to migrate, and adding a field means
adding it to the `Tenancy`/`User` interface in `src/lib/store.ts`.

| Field on the document | What it holds |
|---|---|
| `customerId`, `wallets[]`, `agents[]` | the platform objects this account owns |
| `conversations{agentId → messages[]}` | transcripts, resent to the stateless endpoint each turn |
| `proposals{agentId → plan}` | the last drafted, unaccepted plan, so a reload restores it |
| `proposalThreads` / `proposalEmails` | where a *plan* came from — Slack thread, sender address |
| `paymentThreads` / `paymentEmails` | where a *payment* came from, keyed per payment id |
| `publicKey`, `webauthnCredId`, `webauthnTransports` | passkey enrolment |
| `attachedAt`, `attachedWallets[]` | which wallet signer groups this key is in |
| `history[]` | the human-facing event log the UI renders |

`proposalThreads` and `paymentThreads` are separate on purpose, and both are
keyed **per object rather than per agent**: an agent-level "last thread" sends
every confirmation to whichever conversation spoke most recently — right amount,
wrong question, and hardest to spot when two requests are in flight.

### Where each flow lives

| Flow | Entry point | Then |
|---|---|---|
| Ask for a payment | `api/chat/route.ts` | `resumeAgentConversation().send()` |
| Ask *about* the account | same route | the same `send()` — the converser answers both |
| Invoice attached | same route | `sendWithAttachments()`, 8 MiB cap, PDF/PNG/JPEG/WebP/GIF |
| Accept a plan | `api/proposals/` → `lib/accept.ts` | `instructions.create()` |
| Sign a mandate | `api/mandates/[id]/challenge` → `/sign` | `mandateSignPayload()` → `mandates.approve()` |
| Enrol a passkey | `api/passkey/register/finish` | `signers.create()` + `attachUserToWallet()` per wallet |
| Slack message | `api/slack/events` | HMAC → ack < 3s → `waitUntil` → same `send()` |
| Forwarded invoice | `api/email/inbound` | `?secret=` guard → same `send()` |
| Settlement announce | `api/cron/settlements` | `scheduledPayments.list()`, every minute |

**There is no client-side routing any more.** This app used to keyword-match
each turn (`routeTurn()` in `src/lib/insights.ts`) to decide whether it was a
payment instruction for the agent or a question for a separate read-only
insight chat. Platform folded account-insight Q&A into the payment converser
(ENG-3407) and removed the insight chat endpoint (ENG-3153), so both now go to
one `send()` and the server decides with the account in front of it. If you are
tempted to reintroduce a matcher here, do not: the old one defaulted to
PAYMENTS on every ambiguous turn precisely because it could not tell.

The deterministic insight REPORT is unaffected — `insights.get()`, behind the
Insights panel via `api/insights/route.ts`.

---

## Non-obvious rules

**SDK**

- Set **no client-wide `timeout`**. An explicit one outranks the SDK's
  per-endpoint deadlines and re-imposes a read-sized deadline on agent turns.
- Pass **either** `baseURL` **or** `environment`, never both — `baseURL` wins
  silently.
- Conversations are stateless: persist `convo.messages()` and rebuild with
  `resumeAgentConversation`. **Strip attachments before persisting**
  (`withoutAttachments()` in `src/lib/transcript.ts`).
- Handle errors off `APIError` (`statusCode`, `code`, `requestId`, `retryable`),
  never off message text.
- List endpoints answer either `{ data, meta }` or a bare array.

**Money and mandates**

- **Limits stack; they do not replace.** A new 5/month mandate does not narrow
  an old 500/week one. That is why signing a new limit revokes the ones it
  supersedes — and each revocation is **its own passkey signature**, because the
  platform will not retire a mandate without one.
- A mandate a person can't restate is one they shouldn't sign: limits render as
  English sentences, never as JSON.
- Amounts are USD-denominated in the UI. Which stablecoin on which chain is how
  the deployment is plumbed, not a choice the reader made — see `lib/money.ts`.

**Passkeys**

- `rpId` is the **origin's hostname**, so a passkey enrolled on localhost is a
  different credential from one enrolled on the deployment, and enrolling
  replaces the stored key for that account.
- Enrolment does two things: `signers.create`, then `attachUserToWallet` for
  every treasury wallet. Membership of the signer group *is* the permission —
  policies are threshold-1.

**Channels (Slack, email)**

- Acknowledge Slack in **under 3 seconds**, then continue in `waitUntil`.
  Answering synchronously makes Slack retry and drafts the same payment twice.
- The Slack thread is recorded **per payment** at accept time. An agent-level
  "last thread" answers the wrong conversation the moment two are in flight.
- One inbound email address exists for the whole workspace and exactly one agent
  owns it. That is a workspace fact — do not render it per agent.
- Adding a channel is "receive a message, call `convo.send()`, post the reply".
  No payment logic belongs in a channel adapter.
- **Decide what is the bot's business before answering it** (`lib/slack/gate.ts`).
  With `message.channels` granted, Slack delivers every message in the channel,
  so the bot answers only a mention, a DM, or a reply in a thread it has spoken
  in — the invariant is *if the bot speaks in a thread, the bot listens in it*,
  for `THREAD_IDLE_MS`. A plain channel message, a reply in a thread it never
  joined, a message that opens `@someone-else`, and every message *subtype* (a
  join, an edit, a pin) are left alone. The gate runs **before** the `(channel,
  ts)` deduper, or an ignored delivery claims the slot the paired
  file-with-mention needs. Strip only the **leading** bot mention — a later
  `@name` is content.
- **Slack's `channels:*` scopes are public-only.** A private channel is a
  *group*: `groups:read` / `groups:history` / `message.groups`. A card stuck
  showing a channel id with `channels:read` already granted is this, every
  time — and Slack names the scope it wanted in `needed` on the error, so read
  that rather than guessing.

**UI**

- The UI is **Mantine 8, forced dark**, themed in `src/theme` and imported
  through the `@/theme/ui` barrel (never `@mantine/core` directly, and never the
  old `@dakota-xyz/ui` — that private package is gone; its theme, provider, and
  the few custom components (`Modal`, `Table`, `Amount`, `LabeledRow`,
  `AppLayout`) now live in `src/theme`). The typeface is Inter, wired via
  next/font in `layout.tsx`. **Never a raw hex in app code** — everything
  resolves to Dakota's scales: `slate` neutrals, `sierra` brand, `evergreen`
  settled, `canyon` in flight, `blaze` failed. (Raw hex is confined to
  `src/theme`, which *defines* those scales, and to `ui-overrides.css`.)
- `ui-overrides.css` pins `Button[data-variant="subtle"]` to **28px with
  `!important`**, whatever `size` you pass. A footer's secondary button must be
  `variant="default"` or it stands 8px shorter than its primary.
- One padding source per card: if the `Card` owns the inset, rows carry none.
  Two paddings stacking is how two stacked cards end up with two left edges.
- Motion vocabulary lives in `globals.css` (`--fast`, `--base`, `--ease`, the
  `rise` keyframe). Reuse it rather than inventing a tempo.

**Repo hygiene**

- `.gitignore` carries a blanket `*.png` for visual-diff scratch, with
  `!public/*.png` excepted. An asset the app serves must live under `public/`,
  or it 404s on deployment while looking fine locally.
- There is **no `.npmrc`, no private registry, no token** — every dependency is
  public, so `npm install` and `npm ci` work for anyone. Keep it that way: a
  private-scoped package would put a PAT back in everyone's setup and block a
  clean public clone.
- No secret has ever been committed; keep it that way. `.env*.local` is ignored.

---

## Reading order

If you are new here and want to understand the product rather than the code,
read in this order — it is roughly two hours, and each step assumes the last:

1. **[README.md](./README.md)** — what an agentic payment is, and the mandate
   idea the whole thing rests on.
2. **[docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md)** — every flow with sequence
   diagrams. The Slack section is the one to study if you are wondering what it
   costs to put an agent somewhere new.
3. **[SDK_GUIDE.md](./docs/SDK_GUIDE.md)** — the handful of SDK facts that are not
   guessable, all of which cost someone a day to learn.
4. `src/lib/dakota.ts`, then `src/lib/accept.ts`, then
   `src/app/api/chat/route.ts` — the client, the money, the loop.
5. **[DEPLOYING.md](./docs/DEPLOYING.md)** — only when deploying.

Every SDK call named in those docs was verified present in `src/` on
2026-08-04; if you find one that is not, the doc drifted and should be fixed
rather than worked around.

## Code style

Comments explain **why**, not what — the repo is meant to be read by people
evaluating Dakota, and a comment that restates the code is noise. Where a
decision looks odd, the comment says what broke without it. Match the density
and voice of the file you are in.

UI copy states the **consequence**, not the concept: "Nothing moves until you
sign" beats an explanation of what a mandate is.

## When something breaks

| Symptom | Cause |
|---|---|
| Fonts render as Helvetica/system | next/font failed to fetch at build (offline) — the theme falls back; see `layout.tsx` |
| Sign-in does nothing on localhost | Google can't issue tokens to localhost — set `DEMO_DEV_LOGIN=true` |
| `DAKOTA_API_KEY is not set` | `.env.local` missing or unnamed (`.env.sandbox.local` is **not** loaded by Next) |
| Agent replies but nothing schedules | agent is `pending` — it must be attached to a wallet |
| Signature verifies nowhere | you hand-rolled the bytes; use `mandateSignPayload` |
| Slack drafts everything twice | acknowledged too slowly; ack first, work in `waitUntil` |
| Passkey prompt times out | credential lives in another provider — `webauthnTransports` must be stored and replayed |
