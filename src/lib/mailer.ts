/**
 * Outbound email, via Postmark.
 *
 * Optional on purpose. Sending requires a verified sender signature, which is
 * one more setup step than receiving — so the demo works without it: the
 * invoice is still read and the payment still drafted, it just lands in the app
 * rather than in a reply. Configure it and the loop closes in the inbox.
 */
export function mailConfigured(): boolean {
  return Boolean(process.env.POSTMARK_SERVER_TOKEN && process.env.POSTMARK_FROM)
}

export async function sendMail(msg: {
  to: string
  subject: string
  text: string
  /** Sent alongside the text part, never instead of it. See lib/email-template. */
  html?: string
}): Promise<void> {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN!,
    },
    body: JSON.stringify({
      From: process.env.POSTMARK_FROM,
      To: msg.to,
      Subject: msg.subject,
      TextBody: msg.text,
      ...(msg.html ? { HtmlBody: msg.html } : {}),
      MessageStream: process.env.POSTMARK_STREAM ?? 'outbound',
    }),
  })
  if (!res.ok) {
    throw new Error(`postmark send failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}
