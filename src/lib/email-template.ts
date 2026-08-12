import type { Step } from './proposal'

// The reply an invoice gets back.
//
// Plain text was showing the agent's markdown as markdown — literal asterisks
// around the one number the reader cares about. Worse, the reply is the ENTIRE
// interface for someone using this by email: they never see a screen, so this
// is where "what happened to my invoice" is answered, and it should look like
// an answer rather than a log line.
//
// Written as a table-based email, inline styles only, because that is what mail
// clients render reliably. Gmail strips <style> blocks, Outlook ignores most of
// flexbox, and a layout that depends on either arrives as a stack of unstyled
// paragraphs.
//
// Both bodies are always sent. HTML is the one people see; the text part is not
// a fallback nobody reads — it is what a screen reader, a plain-text client and
// a spam filter all look at, and a message with no text part scores worse.

/** Dakota's palette, hardcoded. CSS variables do not survive an email client. */
const INK = '#232222'
const MUTED = '#585654'
const LINE = '#e6e4e2'
const ACCENT = '#8e4410'
const GOOD_BG = '#eef1ed'
const GOOD_INK = '#3c4938'
const STOP_BG = '#f7eeee'
const STOP_INK = '#7b181d'

export type Outcome =
  | { kind: 'paid'; line: string }
  | { kind: 'blocked'; line: string; limits: string; grant?: string }
  | { kind: 'failed'; line: string }
  | { kind: 'none' }

export interface EmailParts {
  /** The agent's own words. Markdown. */
  reply: string
  /** What the plan actually does, if it drafted one. */
  steps: Step[]
  outcome: Outcome
  /** Where to go to see or finish it. */
  link: string
  agentName: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The small slice of markdown an agent actually writes.
 *
 * Bold, italics, inline code and links — not a parser. Anything else is escaped
 * and left alone, which is the right failure: an unrendered asterisk is a blemish,
 * a mis-parsed one could swallow the amount.
 */
export function inlineMarkdown(md: string): string {
  return esc(md)
    .replace(/`([^`]+)`/g, `<code style="font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f4f3f2;padding:1px 4px;border-radius:3px">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `<a href="$2" style="color:${ACCENT}">$1</a>`)
}

/** Markdown paragraphs and simple lists, as email-safe HTML. */
function prose(md: string): string {
  const blocks = md.trim().split(/\n{2,}/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li style="margin:0 0 4px">${inlineMarkdown(l.replace(/^\s*[-*•]\s+/, ''))}</li>`)
          .join('')
        return `<ul style="margin:0 0 14px;padding-left:20px;color:${INK}">${items}</ul>`
      }
      return `<p style="margin:0 0 14px;line-height:1.55;color:${INK}">${inlineMarkdown(block).replace(/\n/g, '<br>')}</p>`
    })
    .join('')
}

/** The plan, as an indented list that survives Outlook. */
function planBlock(steps: Step[]): string {
  if (steps.length === 0) return ''
  const rows = steps
    .map((s) => {
      const pad = s.sub ? 'padding-left:18px' : ''
      const note = s.note
        ? `<div style="font-size:12px;color:${MUTED};margin-top:2px">${esc(s.note)}</div>`
        : ''
      return `<tr><td style="padding:7px 0;${pad}">
        <span style="color:${MUTED}">${s.sub ? '↳' : '•'}</span>
        <strong style="color:${INK}">${esc(s.title)}</strong>${s.detail ? `<span style="color:${INK}"> — ${esc(s.detail)}</span>` : ''}
        ${note}
      </td></tr>`
    })
    .join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
    style="margin:4px 0 18px;border-left:2px solid ${LINE};padding-left:14px;font-size:14px">
    ${rows}</table>`
}

/** The verdict, as the one thing the eye should land on. */
function outcomeBlock(o: Outcome): string {
  if (o.kind === 'none') return ''
  const [bg, ink] =
    o.kind === 'paid' ? [GOOD_BG, GOOD_INK] : o.kind === 'blocked' ? [STOP_BG, STOP_INK] : ['#faf6f0', ACCENT]

  const extra =
    o.kind === 'blocked'
      ? `<div style="font-size:13px;color:${INK};margin-top:8px;white-space:pre-line">${esc(o.limits)}${o.grant ? `\n${esc(o.grant)}` : ''}</div>`
      : ''

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px">
    <tr><td style="background:${bg};border-radius:8px;padding:14px 16px">
      <div style="font-size:15px;font-weight:600;color:${ink}">${esc(o.line)}</div>${extra}
    </td></tr></table>`
}

/** The whole message. */
export function renderEmail(p: EmailParts): { html: string; text: string } {
  const cta =
    p.outcome.kind === 'paid' ? 'See the payment' : p.outcome.kind === 'none' ? 'Open the app' : 'Open the app'

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#faf9f8">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#faf9f8;padding:28px 12px">
<tr><td align="center">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
    <tr><td style="padding:18px 24px;border-bottom:1px solid ${LINE}">
      <span style="font-size:13px;font-weight:600;color:${INK};letter-spacing:0.02em">${esc(p.agentName)}</span>
      <span style="font-size:13px;color:${MUTED}"> · agentic payments</span>
    </td></tr>
    <tr><td style="padding:22px 24px 6px;font-size:15px">
      ${prose(p.reply)}
      ${planBlock(p.steps)}
      ${outcomeBlock(p.outcome)}
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${ACCENT}">
        <a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${cta} →</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:16px 24px 22px;font-size:12px;color:${MUTED};line-height:1.5">
      You are getting this because you forwarded an invoice to this agent. It can only ever spend
      inside the limit you signed.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`

  // The text part is not a lesser copy — it is what a screen reader and a spam
  // filter read, so it carries the same facts in the same order.
  const lines = [p.reply.trim()]
  if (p.steps.length) {
    lines.push(
      p.steps.map((s) => `${s.sub ? '   ↳' : '-'} ${s.title}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')
    )
  }
  if (p.outcome.kind !== 'none') {
    lines.push(p.outcome.line)
    if (p.outcome.kind === 'blocked') {
      lines.push(p.outcome.limits + (p.outcome.grant ? `\n${p.outcome.grant}` : ''))
    }
  }
  lines.push(`${cta}: ${p.link}`)

  return { html, text: lines.join('\n\n') }
}
