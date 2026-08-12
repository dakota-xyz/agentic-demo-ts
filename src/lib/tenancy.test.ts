import { describe, it, expect, afterEach } from 'vitest'
import { tenancyMode, isTeamMode, TeamNotProvisionedError } from './tenancy'

// The property under test is a safety one, not a feature one. Getting this
// wrong in the permissive direction puts every visitor to the PUBLIC demo into
// one shared account together — able to see each other's payees, payments and
// treasury. So the default must be visitor, and only an exact opt-in changes it.

describe('tenancyMode', () => {
  const saved = process.env.TENANCY_MODE
  afterEach(() => {
    if (saved === undefined) delete process.env.TENANCY_MODE
    else process.env.TENANCY_MODE = saved
  })

  it('is visitor when unset — the public demo must not need configuring to stay isolated', () => {
    delete process.env.TENANCY_MODE
    expect(tenancyMode()).toBe('visitor')
    expect(isTeamMode()).toBe(false)
  })

  it('only the exact string "team" opts in', () => {
    for (const v of ['TEAM', 'Team', 'true', '1', 'shared', '', ' team']) {
      process.env.TENANCY_MODE = v
      expect(tenancyMode(), v).toBe('visitor')
    }
  })

  it('switches on "team"', () => {
    process.env.TENANCY_MODE = 'team'
    expect(tenancyMode()).toBe('team')
    expect(isTeamMode()).toBe(true)
  })
})

describe('TeamNotProvisionedError', () => {
  it('names the script to run, because that is the only fix', () => {
    const e = new TeamNotProvisionedError()
    expect(e.code).toBe('team_not_provisioned')
    expect(e.message).toContain('provision-team')
  })
})
