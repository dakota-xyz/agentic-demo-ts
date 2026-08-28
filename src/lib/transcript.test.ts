import { describe, expect, it } from 'vitest'
import { withoutAttachments } from './transcript'

describe('withoutAttachments', () => {
  it('drops attachments in both casings', () => {
    // Lowercase is ours; capitalised comes from transcripts adopted out of the
    // Go build. Both break the SDK, in the same place, for the same reason.
    const out = withoutAttachments([
      { role: 'user', content: 'pay this', attachments: [{ mediaType: 'application/pdf', data: {} }] },
      { role: 'user', content: 'and this', Attachments: [{ Data: 'JVBER...' }] },
      { role: 'assistant', content: 'drafted' },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'pay this' },
      { role: 'user', content: 'and this' },
      { role: 'assistant', content: 'drafted' },
    ])
  })

  it('leaves an ordinary transcript untouched', () => {
    const clean = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
    expect(withoutAttachments(clean)).toEqual(clean)
  })

  it('survives junk in the array', () => {
    expect(withoutAttachments([null, undefined, 'x'] as unknown[])).toEqual([null, undefined, 'x'])
  })
})
