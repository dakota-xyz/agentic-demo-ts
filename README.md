# Agentic Payments Demo

**Pay someone by asking.** Give an agent a spending limit, tell it what to pay in
plain language, and approve with your fingerprint. Nothing moves until you sign.

**What this is for:** showing what Dakota's agentic payments can do, and how
little code it takes to get there. Every capability below is the
[`@dakota-xyz/ts-sdk`](https://www.npmjs.com/package/@dakota-xyz/ts-sdk) doing
the work — the app around it is a thin shell. If you are evaluating Dakota, this
is the shortest path from "what is an agentic payment" to watching one execute.

Built on [Dakota's agentic payments](https://docs.dakota.xyz/documentation/agentic-payments),
running on Vercel. Testnets only — no real money exists here.

```
you    "pay Acme 25 USDC on ethereum-sepolia next Friday"
         │
agent   drafts the payment — names the payee, picks the wallet, sets the date
         │
you     Review & approve  →  Touch ID
         │
         the limit is signed ONCE; payments inside it run unattended
         │
agent   "✅ Payment executed — 25 USDC → Acme"      (days later, nobody watching)
```

---

## The one idea worth understanding

**The agent never has spending authority.** It drafts; you authorize. And what
you sign is not a payment — it is a **mandate**: a single rule bounding
everything the agent may ever do, enforced cryptographically by the platform.

> *Can pay Acme up to 25 USDC per payment on ethereum-sepolia, at most 3 times a month.*

Sign that once and the agent can execute payments inside it for weeks without
asking again. Ask it for 26 USDC and it is refused — not by the app, not by the
model's good judgement, but by the platform, at fire time.

That distinction is the whole point. *"The AI decided not to"* is not a control.
A signed cap is.

### What the agent can and cannot do

| ✅ Can | ❌ Cannot |
|---|---|
| Draft payment plans from text or an attached invoice (PDF/image) | Move money on its own |
| Answer questions about the account | Approve its own mandates — the bound signer can never sign §8 actions |
| Fire customer-approved payments on schedule | Exceed a mandate cap — the gate denies at fire time |
| Reuse one mandate across a whole recurring series | Outlive revocation — revoking the agent fails its future fires |

Read the model properly:
**[Agentic Payments](https://docs.dakota.xyz/documentation/agentic-payments)** ·
[Mandate signing](https://docs.dakota.xyz/documentation/agentic-payments/mandate-signing) ·
[Limits](https://docs.dakota.xyz/documentation/agentic-payments/limits) ·
[Quickstart](https://docs.dakota.xyz/documentation/agentic-payments/quickstart)

---

## What this demo shows

| | Where to look |
|---|---|
| **Ask → drafted plan** | Chat. The agent asks for what it lacks rather than guessing |
| **Invoice in, payment out** | Attach a PDF; it reads payee, amount and date from it |
| **§8 passkey signing** | *Sign with passkey* → Touch ID, over RFC 8785 canonical bytes |
| **Limits as sentences** | Spend limits renders each mandate in English, not JSON |
| **Unattended execution** | Schedule one, close the tab. It fires and reports back |
| **Slack** | Mention it in a channel, keep talking in the thread, approve in the app, receipt lands in the thread |
| **Timezone-aware scheduling** | "Friday at 10am" means *your* 10am, not UTC |

### How little it takes

Each capability, and the SDK call underneath it. This is the honest measure of
the integration cost:

| To do this | You call |
|---|---|
| Draft a payment from a sentence | `client.resumeAgentConversation(agentId, history).send(text)` |
| Draft from an invoice PDF | the same, `.sendWithAttachments(text, [{ mediaType, data }])` |
| Turn a plan into real payments | `client.instructions.create({ payment_agent_id, proposals })` |
| Build the exact bytes a passkey signs | `mandateSignPayload(mandate, 'approve')` |
| Authorize it | `client.mandates.approve(id, { approver_public_key, signature })` |
| Answer questions about the account | the same conversation — the converser handles both |
| Pull the deterministic account report | `client.insights.get(customerId)` |
| See what is queued | `client.scheduledPayments.list({ signer_id })` |

No hand-rolled HTTP, no hand-rolled RFC 8785 canonicalisation, no polling loop
to write. The conversation is stateless — you keep the transcript and resend it
— which is why this runs on serverless functions with nothing held between
requests.

**[docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md)** walks every flow with
diagrams: the payment loop, passkey signing, reading an invoice, account
questions, and the whole Slack integration — which is worth a look if you are
wondering what it costs to put an agent somewhere new.

### What it deliberately does not show

- **Real money.** Sandbox and testnets only, by design.
- **Fiat rails.** The platform does ACH, SEPA, wires and FedNow. This demo stays
  crypto-only so the story keeps to one beat.
- **Multi-signer approval.** Dakota supports approval thresholds and signer
  groups; here every wallet is one-of-one, because a demo needing two people in
  the room is not a demo.
- **Production identity.** Sign-in tells us which company is evaluating Dakota.
  It is not an identity system, and every visitor is sandboxed regardless.

---

## How it is built

```
src/
  app/api/
    chat/            a turn with an agent; transcript persisted, resent each turn
    proposals/       accept a plan → scheduled payments + an UNSIGNED mandate
    mandates/[id]/   the §8 challenge out, the passkey assertion back
    slack/events/    Slack → agent, acknowledged first
    cron/            settlement announcements, with nobody watching
  lib/
    dakota.ts        the SDK client
    work-domain.ts   who gets in
    webauthn.ts      the passkey seam — this server never holds a user key
    slack/           signature check, which messages to answer, Markdown → mrkdwn
  components/        the UI
```

---

## Running it

```sh
createdb agentic_demo_ts       # any empty Postgres; tables create themselves
npm install
cp .env.example .env.local     # fill it in
npm run dev                    # http://localhost:3000
```

You need a sandbox `DAKOTA_API_KEY` and a Postgres `DATABASE_URL`. That is the
only external credential in the app — the agent runs on the platform, so there
is no model key to obtain.

**Sign-in on localhost:** set `DEMO_DEV_LOGIN=true` and type any address. Google
cannot issue a token to `http://localhost:3000` unless that origin is on the
OAuth client's authorized-origins list, which is why the switch exists.

```sh
npm test          # unit tests
npm run typecheck
npm run build
```

`src/lib/sandbox.live.test.ts` exercises the real platform — provisioning,
idempotency, agent creation, a chat turn. It skips itself unless
`DAKOTA_API_KEY` and `DATABASE_URL` are both set, so CI stays green without
mocks. It is also the only thing that catches what types cannot: a freshly
created agent is `pending` and refuses to talk until it is attached to a wallet.

## Deploying

See **[docs/DEPLOYING.md](./docs/DEPLOYING.md)**.

## Built with

| | |
|---|---|
| [`@dakota-xyz/ts-sdk`](https://www.npmjs.com/package/@dakota-xyz/ts-sdk) | the platform — public on npm |
| Next.js 16 · React 19 | App Router, server components |
| Auth.js | sessions only; the identity step is ours |
| Postgres | one JSONB document per visitor |

## Documentation

- **[How it works](./docs/HOW_IT_WORKS.md)** — every flow, with diagrams
- [SDK guide](./docs/SDK_GUIDE.md) — practical notes for your own integration
- [Deploying](./docs/DEPLOYING.md) — Vercel, and the four things that bite

## Where to go next

- **[Agentic Payments](https://docs.dakota.xyz/documentation/agentic-payments)** — the trust model, the objects, the flow end to end
- **[Quickstart](https://docs.dakota.xyz/documentation/agentic-payments/quickstart)** — the smallest thing that works
- **[Mandate signing](https://docs.dakota.xyz/documentation/agentic-payments/mandate-signing)** — §8, canonical bytes, what a signature commits to
- **[Limits](https://docs.dakota.xyz/documentation/agentic-payments/limits)** — windows, per-target caps, aggregate caps
- **[Direct control](https://docs.dakota.xyz/documentation/agentic-payments/direct-control)** — the same primitives without an agent
- **[Webhooks](https://docs.dakota.xyz/documentation/agentic-payments/webhooks)** — reacting to fires and failures
- **[Signing guide](https://docs.dakota.xyz/documentation/signing-guide)** — the signature scheme itself

---

## License

MIT — see [LICENSE](./LICENSE). Use it, copy it, build your own on top of it.
