// Auth.js mounts its own routes here: sign-in, the Google callback, sign-out,
// and the session endpoint.
import { handlers } from '@/lib/auth'

export const { GET, POST } = handlers
