import 'next-auth'
import 'next-auth/jwt'

// The verified work domain, resolved once at sign-in and carried on the token.
// It is the lead the demo exists to produce, so it travels with the session
// rather than being re-derived per request.
declare module 'next-auth' {
  // Dev sign-in returns the domain on the user object (there is no Google
  // profile to read it from), so the User type has to carry it too.
  interface User {
    domain?: string
  }

  interface Session {
    user: {
      email?: string | null
      name?: string | null
      image?: string | null
      domain?: string
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    domain?: string
  }
}
