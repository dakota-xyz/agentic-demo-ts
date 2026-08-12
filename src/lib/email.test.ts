import { describe, it, expect } from 'vitest'
import { senderVerdict, senderAddress, agentTag, slugify, bodyFor, attachmentsFrom } from './email'

// An invoice is exactly the thing worth forging, so the parsing that decides
// "who sent this" is the security boundary. These pin it.

const base = { From: 'a@b.com' }

describe('senderVerdict', () => {
  it('reads a pass', () => {
    expect(
      senderVerdict({ ...base, Headers: [{ Name: 'Authentication-Results', Value: 'mx.google.com; dkim=pass header.i=@acme.com; spf=pass' }] })
    ).toEqual({ dkim: true, spf: true })
  })

  it('reads a fail — this is the forged-invoice case', () => {
    expect(
      senderVerdict({ ...base, Headers: [{ Name: 'Authentication-Results', Value: 'mx.google.com; dkim=fail; spf=softfail' }] }).dkim
    ).toBe(false)
  })

  it('reports null when the header is absent, which is NOT a failure', () => {
    // Internal relays often strip it. Treating absent as failed would reject
    // legitimate mail; treating failed as absent would accept forgeries. They
    // must stay distinguishable.
    expect(senderVerdict(base)).toEqual({ dkim: null, spf: null })
  })

  it('is case-insensitive about the header name', () => {
    expect(
      senderVerdict({ ...base, Headers: [{ Name: 'authentication-results', Value: 'dkim=PASS' }] }).dkim
    ).toBe(true)
  })
})

describe('senderAddress', () => {
  it('prefers the parsed address and lowercases it', () => {
    expect(senderAddress({ From: 'Ada <Ada@Example.COM>', FromFull: { Email: 'Ada@Example.com' } })).toBe('ada@example.com')
  })
  it('falls back to From', () => {
    expect(senderAddress({ From: 'A@B.com' })).toBe('a@b.com')
  })
})

describe('agentTag', () => {
  it('extracts the +tag that picks an agent', () => {
    expect(agentTag({ ...base, OriginalRecipient: '6776abc+payroll@inbound.postmarkapp.com' })).toBe('payroll')
  })
  it('is empty with no tag, which means the default agent', () => {
    expect(agentTag({ ...base, OriginalRecipient: '6776abc@inbound.postmarkapp.com' })).toBe('')
  })
  it('falls back to the To header', () => {
    expect(agentTag({ ...base, ToFull: [{ Email: 'x+ops@inbound.postmarkapp.com' }] })).toBe('ops')
  })
})

describe('slugify', () => {
  it.each([
    ['Accounts payable', 'accountspayable'],
    ['Payroll', 'payroll'],
    ['R&D — EU', 'rdeu'],
  ])('%s -> %s', (a, b) => expect(slugify(a)).toBe(b))
})

describe('bodyFor', () => {
  it('uses the subject and what the person actually wrote', () => {
    expect(bodyFor({ ...base, Subject: 'FW: Invoice 42', StrippedTextReply: 'please pay this' })).toBe('FW: Invoice 42\n\nplease pay this')
  })
  it('still produces an instruction for an empty forward', () => {
    // An invoice with no covering note means "pay this".
    expect(bodyFor({ ...base })).toBe('Draft a payment from the attached document.')
  })
})

describe('attachmentsFrom', () => {
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64')

  it('decodes a readable attachment', () => {
    const out = attachmentsFrom({ ...base, Attachments: [{ Name: 'i.pdf', ContentType: 'application/pdf', Content: pdf }] })
    expect(out).toHaveLength(1)
    expect(out[0].filename).toBe('i.pdf')
    expect(Buffer.from(out[0].data).toString()).toContain('%PDF')
  })

  it('tolerates a charset on the content type', () => {
    expect(attachmentsFrom({ ...base, Attachments: [{ Name: 'i.pdf', ContentType: 'application/pdf; charset=binary', Content: pdf }] })).toHaveLength(1)
  })

  it('skips what the agent cannot read rather than failing', () => {
    // A signature image or a .docx should not cost someone their invoice.
    const out = attachmentsFrom({ ...base, Attachments: [
      { Name: 'sig.docx', ContentType: 'application/msword', Content: pdf },
      { Name: 'i.pdf', ContentType: 'application/pdf', Content: pdf },
    ] })
    expect(out.map((a) => a.filename)).toEqual(['i.pdf'])
  })
})

describe('agentTag — MailboxHash', () => {
  it("prefers Postmark own parse over re-reading the address", () => {
    expect(agentTag({ ...base, MailboxHash: 'Payroll', OriginalRecipient: 'x+wrong@inbound.postmarkapp.com' })).toBe('payroll')
  })
  it('falls back to the address when the field is absent', () => {
    expect(agentTag({ ...base, OriginalRecipient: 'x+ops@inbound.postmarkapp.com' })).toBe('ops')
  })
  it('is empty for the plain address, meaning the first agent', () => {
    expect(agentTag({ ...base, MailboxHash: '', OriginalRecipient: 'x@inbound.postmarkapp.com' })).toBe('')
  })
})

describe('bodyFor with an attachment', () => {
  // The natural way to forward an invoice — subject "invoice", nothing typed,
  // PDF attached — used to send the agent the single word "invoice". A bare
  // noun with no request read as off-topic to the platform's boundary screen,
  // which TERMINATED the conversation. So an attachment always leads with the
  // ask, and the person's words follow as context.

  it('asks for a payment even when only a subject was given', () => {
    const out = bodyFor({ From: 'a@b.com', Subject: 'invoice', TextBody: '' }, true)
    expect(out).toMatch(/^Draft a payment from the attached invoice\./)
    expect(out).toContain('Subject: invoice')
  })

  it('asks for a payment when NOTHING was given', () => {
    expect(bodyFor({ From: 'a@b.com' }, true)).toBe('Draft a payment from the attached invoice.')
  })

  it('keeps what the person wrote, underneath the ask', () => {
    const out = bodyFor(
      { From: 'a@b.com', Subject: 'Acme invoice', TextBody: 'pay this by Friday please' },
      true
    )
    expect(out).toMatch(/^Draft a payment from the attached invoice\./)
    expect(out).toContain('pay this by Friday please')
  })

  it('is unchanged for mail with no attachment', () => {
    expect(bodyFor({ From: 'a@b.com', Subject: 'pay Acme 25 USDC' }, false)).toBe('pay Acme 25 USDC')
  })
})

describe('attachmentsFrom media-type detection', () => {
  const b64 = Buffer.from('%PDF-1.4 hello').toString('base64')

  it('takes the declared type when it is one we read', () => {
    const out = attachmentsFrom({
      From: 'a@b.com',
      Attachments: [{ Name: 'inv.pdf', ContentType: 'application/pdf', Content: b64 }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].mediaType).toBe('application/pdf')
  })

  it('falls back to the FILENAME when the type is generic', () => {
    // Gmail routinely labels a forwarded PDF application/octet-stream. Trusting
    // the header alone dropped the attachment, the agent got a bare subject
    // line, and the boundary screen terminated the conversation for it.
    const out = attachmentsFrom({
      From: 'a@b.com',
      Attachments: [{ Name: 'invoice.pdf', ContentType: 'application/octet-stream', Content: b64 }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].mediaType).toBe('application/pdf')
  })

  it('handles a parameterised or padded content type', () => {
    const out = attachmentsFrom({
      From: 'a@b.com',
      Attachments: [{ Name: 'x', ContentType: ' application/pdf; name="inv.pdf" ', Content: b64 }],
    })
    expect(out).toHaveLength(1)
  })

  it('still skips something it genuinely cannot read', () => {
    expect(
      attachmentsFrom({
        From: 'a@b.com',
        Attachments: [{ Name: 'notes.docx', ContentType: 'application/octet-stream', Content: b64 }],
      })
    ).toHaveLength(0)
  })
})
