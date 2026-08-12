import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { salesforceConfigured } from './salesforce'

// The behaviour that matters most here is what happens when it is NOT set up,
// because that is the state every developer and every preview deploy is in.
// Lead capture must be invisible then, never an error.

describe('salesforceConfigured', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.SALESFORCE_INSTANCE_URL
    delete process.env.SALESFORCE_CONSUMER_KEY
    delete process.env.SALESFORCE_CONSUMER_SECRET
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('is off when nothing is set', () => {
    expect(salesforceConfigured()).toBe(false)
  })

  it('is off when only some of it is set — a half-configured CRM is not a CRM', () => {
    process.env.SALESFORCE_INSTANCE_URL = 'https://x.my.salesforce.com'
    expect(salesforceConfigured()).toBe(false)
    process.env.SALESFORCE_CONSUMER_KEY = 'key'
    expect(salesforceConfigured()).toBe(false)
  })

  it('is on only with all three', () => {
    process.env.SALESFORCE_INSTANCE_URL = 'https://x.my.salesforce.com'
    process.env.SALESFORCE_CONSUMER_KEY = 'key'
    process.env.SALESFORCE_CONSUMER_SECRET = 'secret'
    expect(salesforceConfigured()).toBe(true)
  })
})
