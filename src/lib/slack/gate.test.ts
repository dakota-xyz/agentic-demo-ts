import { beforeEach, describe, expect, it } from 'vitest'
import {
  THREAD_IDLE_MS,
  addressedToSomeoneElse,
  followThread,
  followingThread,
  forThisBot,
  resetFollowedThreads,
  stripLeadingMention,
} from './gate'

beforeEach(() => resetFollowedThreads())

describe('forThisBot', () => {
  it('answers a mention anywhere', () => {
    expect(forThisBot({ type: 'app_mention', channel: 'C', ts: '1' })).toBe(true)
  })

  it('answers every message in a DM', () => {
    expect(
      forThisBot({ type: 'message', channel_type: 'im', channel: 'D', ts: '1' })
    ).toBe(true)
  })

  it('ignores a plain channel message that did not mention the bot', () => {
    expect(
      forThisBot({ type: 'message', channel_type: 'channel', channel: 'C', ts: '1', text: 'lunch?' })
    ).toBe(false)
  })

  it('ignores message subtypes — joins, edits, pins', () => {
    for (const subtype of ['channel_join', 'message_changed', 'pinned_item']) {
      expect(
        forThisBot({ type: 'message', subtype, channel: 'C', ts: '1' })
      ).toBe(false)
    }
  })

  it('ignores a reply in a thread the bot never joined', () => {
    expect(
      forThisBot({ type: 'message', channel: 'C', ts: '2', thread_ts: '1', text: 'ok' })
    ).toBe(false)
  })

  it('follows a plain reply once the bot has spoken in the thread', () => {
    followThread('C', '1')
    expect(
      forThisBot({ type: 'message', channel: 'C', ts: '2', thread_ts: '1', text: 'ok do it' })
    ).toBe(true)
  })

  it('ignores a followed-thread reply that opens by naming someone else', () => {
    followThread('C', '1')
    expect(
      forThisBot({ type: 'message', channel: 'C', ts: '2', thread_ts: '1', text: '<@U999> take a look' })
    ).toBe(false)
  })

  it('stops following a thread after the idle window', () => {
    const t0 = 1_000_000
    followThread('C', '1', t0)
    expect(followingThread('C', '1', t0 + THREAD_IDLE_MS - 1)).toBe(true)
    expect(followingThread('C', '1', t0 + THREAD_IDLE_MS + 1)).toBe(false)
  })

  it('keeps threads separate across channels with the same ts', () => {
    followThread('C1', '1')
    expect(followingThread('C2', '1')).toBe(false)
  })
})

describe('addressedToSomeoneElse', () => {
  it('is true only when a mention opens the message', () => {
    expect(addressedToSomeoneElse('<@U1> hey')).toBe(true)
    expect(addressedToSomeoneElse('  <@U1> hey')).toBe(true)
    expect(addressedToSomeoneElse('pay <@U1> 50')).toBe(false)
    expect(addressedToSomeoneElse('hello')).toBe(false)
  })
})

describe('stripLeadingMention', () => {
  it('strips only the leading bot mention', () => {
    expect(stripLeadingMention('<@U1> pay this invoice')).toBe('pay this invoice')
  })

  it('keeps a mention that is content later in the sentence', () => {
    expect(stripLeadingMention('<@U1> pay <@U2> 50')).toBe('pay <@U2> 50')
  })

  it('leaves a message with no mention untouched', () => {
    expect(stripLeadingMention('  what is the balance?  ')).toBe('what is the balance?')
  })
})
