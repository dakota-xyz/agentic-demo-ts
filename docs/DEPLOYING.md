<!-- Split out of the README so the front page can stay about the product. -->

# Deploying to Vercel

### 1. Install needs no token

Every dependency is public, so Vercel installs with no config — no `.npmrc`, no
`NPM_RC`, no PAT, no private registry. The UI is plain Mantine themed in
`src/theme`, and the fonts (Inter, JetBrains Mono) come from next/font at build
time.

### 2. Environment variables

From `.env.example`. Vercel sets `AUTH_URL` for you; `AUTH_SECRET` it does not.

| Variable | Notes |
|---|---|
| `DAKOTA_API_KEY` | sandbox key |
| `DAKOTA_ENV` | optional; `sandbox` or `production`, and `sandbox` unless set — anything else throws at startup. **`production` moves real money** — and the testnet `DEMO_NETWORKS` default and the test-funds faucet both assume sandbox, so they change together |
| `DATABASE_URL` | a **pooled** connection string (Neon `-pooler`, Supabase pgBouncer) — serverless opens many short-lived connections |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` | see below — no secret needed |
| `DEMO_KEY_SALT` | **must be stable forever** — it derives the service signer, and a new value orphans every existing wallet |
| `CRON_SECRET` | guards the settlement cron. **Required** — the route refuses to run without it. Vercel sets it for you when the project has a cron, and this one does (`vercel.json`) |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | optional |
| `APP_BASE_URL` | the deployment URL, for Slack's deep links |
| `POSTMARK_WEBHOOK_SECRET` | **required if you want inbound email at all** — `/api/email/inbound` returns 503 without it. Postmark sends no signature, so this is the only thing proving a request came from Postmark rather than from anyone who guessed the URL. Put it in the webhook URL: `https://<deployment>/api/email/inbound?secret=<value>` |
| `NEXT_PUBLIC_POSTMARK_INBOUND_ADDRESS` | the address the Integrations tab tells people to forward to |
| `POSTMARK_SERVER_TOKEN` / `POSTMARK_FROM` | optional — replying by email. Without them an invoice is still read and drafted, it just lands in the app |

**`DEMO_DEV_LOGIN` must be absent.** It turns the front door into "type any
address". The provider is not constructed unless it is exactly `true`, so the
check is simply that the variable is not there.

### 3. Google OAuth

One line of config, because the token client needs no secret and no redirect
URI — only the origin:

| Field | Value |
|---|---|
| Authorized JavaScript origins | `https://<deployment>` (and `http://localhost:3000` for local work) |
| Authorized redirect URIs | *(none)* |

`GOOGLE_CLIENT_ID` is the only variable. It is not a secret — it ships to every
browser that loads the sign-in page.

Preview deployments get their own URL each time, so either add them as you go or
test auth on production only.

### 4. Slack

Point Event Subscriptions at `https://<deployment>/api/slack/events`, with
Socket Mode **off**.

Bot scopes: `app_mentions:read`, `chat:write`, `channels:history`,
`channels:read`, `files:read` — and for a **private** channel also
`groups:history` and `groups:read`, because Slack's `channels:*` scopes cover
public channels only. Events: `app_mention` and `message.channels`, plus
`message.groups` for private channels.

Missing `channels:read` / `groups:read` is not fatal: everything works and the
card shows the channel id where its name should be.

---

Two things the Go build did with a long-running process, which serverless
cannot, and where they land here:

| | Go build | Here |
|---|---|---|
| Slack ack-first, work-after | goroutine outliving the response | `waitUntil` from `@vercel/functions` |
| Settlement watcher (60s) | ticker goroutine | Vercel Cron (`vercel.json`) |

Note the cron runs **every 15 minutes**, which needs a Vercel plan that allows
sub-daily cron — on Hobby, cron is limited to once a day and settlements will
announce late.


## After the first deploy

| | |
|---|---|
| Add the deployment origin to the OAuth client | otherwise sign-in fails in the browser before anything reaches the app |
| Turn off Deployment Protection | Slack cannot authenticate through Vercel SSO, so `/api/slack/events` is unreachable while it is on |
| Point the Slack app's Request URL at `https://<deployment>/api/slack/events` | Socket Mode **off** — with it on the URL verifies and then nothing is ever delivered |
| Connect the channel **on the deployment** | the channel→agent link lives in the database, and the deployment's is not your laptop's |

## Things that will bite

**`DEMO_KEY_SALT` can never change.** It derives the service signer that seeds
every wallet's signer group. A new value derives a different key, and every
existing wallet suddenly references a signer the platform has never seen — the
whole tenancy is orphaned.

**`DEMO_DEV_LOGIN` must be absent.** It turns the front door into "type any
address and get that person's sandbox". The provider is not constructed unless
it is exactly `true`, so the check is simply that the variable is not there.

**`DATABASE_URL` must be pooled.** Serverless opens many short-lived
connections; a direct Postgres endpoint runs out of backends long before Vercel
runs out of concurrency. Neon's `DATABASE_URL` is already the pooled one —
`DATABASE_URL_UNPOOLED` is the direct one, and is not what this app wants.

**The settlement cron runs every 15 minutes.** Two limits pin that number from
opposite sides. Hobby plans cap cron at once per day, which would make Slack
settlement announcements hours late. In the other direction, Neon suspends an
idle compute after 5 minutes, so any interval under that keeps the database
awake around the clock for a sweep that usually finds nothing. A once-a-minute
cron is what exhausted this deployment's compute quota: Postgres began
answering `53000` (`configuration_limit_exceeded`), and because the signed-in
home page reads Postgres before it renders, every login turned into a 500.
