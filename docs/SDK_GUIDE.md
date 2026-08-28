# Working with `@dakota-xyz/ts-sdk`

Practical notes from building this app — the handful of things worth knowing
before you write your own integration. Everything here is demonstrated
somewhere in `src/`.

## Let the endpoint defaults handle timeouts

Agent turns take much longer than a balance read: a single turn is a sequence
of model calls, and one carrying a PDF invoice is longer still. The SDK already
sizes its deadlines per endpoint, so the simplest correct thing is to set no
client-wide `timeout` at all.

An explicit client-wide `timeout` **outranks** those per-endpoint defaults, so a
single number on the client applies a read-sized deadline to agent
conversations too. If you need to override, do it per call — `RequestOptions`
and `AgentConversationOptions` both take a `timeout`.

```ts
// src/lib/dakota.ts — no client-wide timeout, deliberately
new DakotaClient({ apiKey, environment: Environment.Sandbox })
```

## Pass either `baseURL` or `environment`, not both

`baseURL` wins when both are set. Reading them from optional env vars makes it
easy to pass both by accident and wonder why the enum is ignored, so send
exactly one — and prefer `environment`, because the SDK already holds a URL per
environment and a name can be validated where a URL cannot:

```ts
// src/lib/dakota.ts — the environment, never a baseURL.
// Two values on purpose, not every one the enum carries.
const ENVIRONMENTS = [Environment.Sandbox, Environment.Production] as const
const name = (process.env.DAKOTA_ENV ?? '').trim().toLowerCase() || Environment.Sandbox
const environment = ENVIRONMENTS.find((e) => e === name)
if (!environment) throw new Error(`DAKOTA_ENV="${name}" is not a Dakota environment`)

new DakotaClient({ apiKey, environment })
```

Reach for `baseURL` only to hit a build the enum does not name — and then it is
the only one of the two you pass.

## Conversations are stateless — you hold the transcript

`AgentConversation` is built for serverless backends. Persist `messages()` after
each turn and rebuild with `resumeAgentConversation` on the next request; no
session affinity, no server-side state.

```ts
const convo = dakota().resumeAgentConversation(agentId, history, { timezone })
const turn = await convo.send(text)
await save(convo.messages())
```

One thing to handle yourself: **strip attachments before persisting.** Decoded
PDF bytes have no business in a transcript, and they do not survive a
round-trip through JSON. See `withoutAttachments()` in `src/lib/transcript.ts`.

## Keep a record of the wallets you create

Wallets are the one object here that holds value. Store the ids you get back
from `wallets.create` against your own user record, the way this app does in
its `treasury` array — a customer can be looked up by name, but your database
is the map from a customer to their wallets.

## Use the built-in signing helpers

`mandateSignPayload` produces the exact canonical bytes the platform re-derives
when it verifies — RFC 8785 (JCS), keys sorted, decimal amounts as strings.
Hand-rolling this is the easiest part of the flow to get subtly wrong, and the
failure mode is a signature that verifies nowhere with no useful error.

Same for `canonicalJSON`, whose docstring is worth reading before you assume
anything about number handling.

## Handle errors off `APIError`, not off message text

`APIError` carries `statusCode`, `code`, `requestId` and `retryable` — enough to
decide both what to show someone and whether to try again, without parsing
strings. `requestId` is what to quote when asking for help with a specific call.

## Two response shapes exist

Most list endpoints answer with `{ data, meta }`; a few answer with a bare
array. The SDK's paginator handles both as of **v2.1.1**, so `.list()` is the
right call everywhere — but if you are reading an endpoint directly rather than
through the SDK, accept either:

```ts
const rows = Array.isArray(body) ? body : (body.data ?? [])
```

## Pin at least v2.1.1

Earlier versions differ in both areas above. `2.1.1` also adds `mandates.amend`
with version-committed signatures, `getBudget`, DAILY windows, aggregate caps
and timezone-aware conversations.
