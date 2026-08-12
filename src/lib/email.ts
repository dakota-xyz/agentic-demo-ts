// Inbound email: forward an invoice, get a drafted payment.
//
// Invoices already arrive by email. Every other channel makes someone retype
// what is already in their inbox — this one does not, which is why it is the
// integration people ask for.
//
// Postmark receives the mail and POSTs it here already parsed, attachments
// decoded. From that point it is the same call Slack makes.

/** The subset of Postmark's inbound payload we read. */
export interface InboundEmail {
  From: string
  FromFull?: { Email?: string; Name?: string }
  Subject?: string
  TextBody?: string
  StrippedTextReply?: string
  ToFull?: { Email?: string; MailboxHash?: string }[]
  OriginalRecipient?: string
  /** Postmark's own parse of the `+tag` portion. */
  MailboxHash?: string
  Attachments?: {
    Name?: string
    Content?: string
    ContentType?: string
    ContentLength?: number
  }[]
  Headers?: { Name?: string; Value?: string }[]
}

/**
 * Whether the sending domain actually authorised this mail.
 *
 * A "From" address is a claim, not a fact — anyone can put anything there, and
 * an invoice is exactly the thing worth forging. Postmark forwards the
 * receiving server's Authentication-Results, so DKIM and SPF verdicts are
 * available; this reads them rather than trusting the envelope.
 *
 * Returns null when no verdict is present at all, which is different from a
 * failure and must be handled as such by the caller.
 */
export function senderVerdict(email: InboundEmail): { dkim: boolean | null; spf: boolean | null } {
  const header = (email.Headers ?? []).find(
    (h) => (h.Name ?? '').toLowerCase() === 'authentication-results'
  )?.Value
  if (!header) return { dkim: null, spf: null }

  const read = (mech: string): boolean | null => {
    const m = new RegExp(`${mech}=(\\w+)`, 'i').exec(header)
    if (!m) return null
    return m[1].toLowerCase() === 'pass'
  }
  return { dkim: read('dkim'), spf: read('spf') }
}

/** The address that actually sent this, lowercased. */
export function senderAddress(email: InboundEmail): string {
  return (email.FromFull?.Email ?? email.From ?? '').trim().toLowerCase()
}

/**
 * Which agent the mail was addressed to, if it said.
 *
 * Postmark splits `<hash>+payroll@…` and hands back the tag as MailboxHash, so
 * that field is preferred — it is Postmark's own parse rather than ours. The
 * address is only re-parsed as a fallback, for payloads that predate the field
 * or come from a different relay.
 *
 * Empty means "no preference", which is the normal case: the plain address is
 * what people are given, and it goes to their first agent.
 */
export function agentTag(email: InboundEmail): string {
  if (email.MailboxHash) return email.MailboxHash.trim().toLowerCase()
  const to = email.OriginalRecipient ?? email.ToFull?.[0]?.Email ?? ''
  const m = /\+([^@]+)@/.exec(to)
  return (m?.[1] ?? '').trim().toLowerCase()
}

/** A name reduced to something typeable in an email address. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40)
}

/**
 * The text the agent should act on.
 *
 * A forward carries the original mail quoted underneath whatever the sender
 * typed, and the quoted part is usually the invoice email itself — useful
 * context, so it is kept. What matters more is that an EMPTY forward still
 * works: an invoice with no covering note means "pay this", exactly as it does
 * in Slack.
 */
export function bodyFor(email: InboundEmail, hasAttachment = false): string {
  const written = (email.StrippedTextReply ?? '').trim()
  const full = (email.TextBody ?? '').trim()
  const subject = (email.Subject ?? '').trim()
  const body = written || full

  // An attachment ALWAYS leads with the instruction.
  //
  // Forwarding an invoice with subject "invoice" and no body used to send the
  // agent the single word "invoice" — a bare noun, no request — and the
  // platform's boundary screen read that as off-topic and TERMINATED the
  // conversation. The most natural way anyone forwards an invoice was the one
  // way that broke.
  //
  // The person's own words are kept as context beneath it, because "pay this by
  // Friday" in the covering note still matters. They are just no longer asked
  // to carry the request on their own.
  if (hasAttachment) {
    const context = [subject && `Subject: ${subject}`, body].filter(Boolean).join('\n\n')
    const ask = 'Draft a payment from the attached invoice.'
    return context ? `${ask}\n\n${context}` : ask
  }

  if (body) return subject ? `${subject}\n\n${body}` : body
  return subject || 'Draft a payment from the attached document.'
}

/** Attachment media types the agent can read. */
const READABLE: Record<string, string> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** 8 MiB, matching the Slack and web paths. */
const MAX_BYTES = 8 << 20

/** Readable attachments, decoded. Anything else is skipped, not fatal. */
/** Extension → media type, for senders that do not label their attachments. */
const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * What an attachment actually is.
 *
 * The declared Content-Type is preferred, but plenty of senders label a PDF
 * `application/octet-stream` — Gmail does it routinely for forwards — and
 * trusting the label alone silently dropped the attachment. The mail then
 * reached the agent as a bare subject line with nothing attached, which the
 * boundary screen read as off-topic and eventually terminated the conversation
 * for. A blocked chat, from a correctly-formed invoice, because of a header.
 *
 * So: fall back to the filename. It is the sender's own description of the
 * file, and for this purpose it is better evidence than a generic type.
 */
function mediaTypeOf(a: { ContentType?: string; Name?: string }): string | null {
  const declared = (a.ContentType ?? '').toLowerCase().split(';')[0].trim()
  if (READABLE[declared]) return READABLE[declared]

  const ext = (a.Name ?? '').toLowerCase().split('.').pop() ?? ''
  return BY_EXTENSION[ext] ?? null
}

export function attachmentsFrom(email: InboundEmail) {
  const out: { mediaType: string; data: Uint8Array; filename?: string }[] = []
  const skipped: string[] = []

  for (const a of email.Attachments ?? []) {
    const mediaType = mediaTypeOf(a)
    if (!mediaType || !a.Content) {
      skipped.push(`${a.Name ?? '(unnamed)'} [${a.ContentType ?? 'no type'}]`)
      continue
    }
    const bytes = Buffer.from(a.Content, 'base64')
    if (bytes.length > MAX_BYTES) {
      skipped.push(`${a.Name ?? '(unnamed)'} [too large: ${bytes.length} bytes]`)
      continue
    }
    out.push({ mediaType, data: new Uint8Array(bytes), filename: a.Name })
  }

  // Named, because a silently dropped attachment is indistinguishable from an
  // agent that could not read the invoice — and the two need opposite fixes.
  if (skipped.length) console.warn('[email] attachments skipped:', skipped.join(', '))
  return out
}
