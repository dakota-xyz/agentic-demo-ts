// Slack does not render Markdown. It renders "mrkdwn", which looks similar and
// is not: bold is *one* asterisk, italic is underscores, links are <url|text>,
// and a leading "-" is just a hyphen. The agent replies in real Markdown — the
// web transcript renders it properly — so a reply pasted straight into Slack
// arrives full of literal ** and dashes.
//
// This converts one to the other. It is deliberately small: the agent's replies
// are prose, bullets, bold and the occasional link, so that is what it handles.

const RE_FENCE = /```[\s\S]*?```/g
const RE_INLINE = /`[^`\n]+`/g

const RE_BOLD = /\*\*([^*\n]+)\*\*/g
const RE_ITALIC_U = /(^|[\s(])_([^_\n]+)_($|[\s).,!?;:])/g
const RE_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const RE_HEADING = /^#{1,6}\s+(.+)$/gm
const RE_BULLET = /^(\s*)[-*+]\s+/gm
const RE_HR = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm

/**
 * A placeholder that cannot appear in agent prose.
 *
 * The Go build used NUL bytes for this. Here a private-use codepoint does the
 * same job and survives JSON round-tripping, which a raw control character does
 * not reliably do.
 */
const MARK = ''

/** Rewrite Markdown as Slack mrkdwn. */
export function toMrkdwn(md: string): string {
  // Lift code out, convert, put it back — otherwise a ** inside a snippet gets
  // mangled and the snippet stops being literal.
  const vault: string[] = []
  const stash = (re: RegExp, s: string) =>
    s.replace(re, (m) => {
      vault.push(m)
      return `${MARK}${vault.length - 1}${MARK}`
    })

  let out = stash(RE_FENCE, md)
  out = stash(RE_INLINE, out)

  out = out.replace(RE_HEADING, '*$1*') // no headings in Slack; bold the line
  out = out.replace(RE_HR, '') // rules render as literal dashes
  out = out.replace(RE_LINK, '<$2|$1>')
  out = out.replace(RE_BOLD, '*$1*') // ** -> * BEFORE single-asterisk rules
  out = out.replace(RE_ITALIC_U, '$1_$2_$3')
  out = out.replace(RE_BULLET, '$1• ')

  // Restore code spans in place.
  vault.forEach((v, i) => {
    out = out.split(`${MARK}${i}${MARK}`).join(v)
  })
  return out.trim()
}
