import { getTeam, getUser, updateTeam, type Tenancy } from './store'
import { ensureTenancy, updateVisitorTenancy } from './provision'

// Whose account is this?
//
// The app answers that question in two ways, and every route that touches the
// platform should be indifferent to which.
//
//   visitor — the public demo. Each person who signs in gets their own
//             customer, wallets and agents, minted lazily on first need.
//   team    — an internal deployment. ONE account, provisioned upfront by
//             scripts/provision-team.mjs, that everyone signs into.
//
// The modes differ in exactly one thing: which document owns the platform state.
// Both satisfy `Tenancy`, so the routes below the seam read `t.agents` and
// `t.wallets` without knowing. That is why this is a scope swap rather than a
// rewrite.
//
// Team mode also removes a whole class of failure rather than reorganising it:
// nothing at request time creates a customer or a wallet, so the lazy-provision
// race — two parallel requests both deciding to mint — cannot happen at all.

export type TenancyMode = 'visitor' | 'team'

/**
 * Which mode this deployment runs in.
 *
 * Defaults to `visitor`, so the public demo is unaffected by anything here and
 * a half-configured deployment cannot silently put every visitor into a shared
 * account together. Only the exact string opts in.
 */
export function tenancyMode(): TenancyMode {
  return process.env.TENANCY_MODE === 'team' ? 'team' : 'visitor'
}

export const isTeamMode = () => tenancyMode() === 'team'

/** Thrown when team mode is on but nobody has run the provisioning script. */
export class TeamNotProvisionedError extends Error {
  readonly code = 'team_not_provisioned'
  constructor() {
    super(
      'This deployment runs in team mode but the shared account has not been provisioned. Run `node scripts/provision-team.mjs`.'
    )
    this.name = 'TeamNotProvisionedError'
  }
}

/**
 * The platform state this request should act on.
 *
 * In visitor mode this still provisions on first need — unchanged behaviour. In
 * team mode it only READS, and fails loudly when the team is missing rather
 * than helpfully creating one: a second customer minted by accident is the
 * expensive mistake here, and an error naming the script is cheap.
 *
 * @throws {TeamNotProvisionedError}
 */
export async function tenancyFor(email: string): Promise<Tenancy> {
  if (!isTeamMode()) return ensureTenancy(email)

  const team = await getTeam()
  if (!team?.customerId || !team.wallets?.length) throw new TeamNotProvisionedError()
  return team
}

/**
 * The platform state, WITHOUT provisioning anything.
 *
 * For the server component, which renders the workspace on first paint. It
 * must not provision: someone who signs in, looks around and leaves should
 * cost the platform nothing, and in team mode there is nothing to create
 * anyway. Null means "not set up yet", which renders as the empty state
 * rather than an error.
 */
export async function readTenancy(email: string): Promise<Tenancy | null> {
  return isTeamMode() ? await getTeam() : await getUser(email)
}

/**
 * Read-modify-write the platform state, under the right row lock.
 *
 * `email` names who is acting, not what is written — in team mode the write
 * lands on the shared document regardless. Callers that need to record WHO
 * should put it in the event (see ChatEvent.actor); the lock does not carry it.
 */
export async function updateTenancy(
  email: string,
  mutate: (t: Tenancy) => void | Promise<void>
): Promise<Tenancy> {
  return isTeamMode() ? updateTeam(mutate) : updateVisitorTenancy(email, mutate)
}
