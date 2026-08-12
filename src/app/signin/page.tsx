import { redirect } from 'next/navigation'
import { Alert, Button, Card, Center, Divider, Group, Stack, Text, TextInput, Title } from '@/theme/ui'
import { auth, signIn, devLoginEnabled, googleClientId } from '@/lib/auth'
import { anyDomainAllowed } from '@/lib/work-domain'
import { BrandMark } from '@/components/brand-mark'
import { GoogleSignInButton } from '@/components/google-signin-button'

// The front door: sign in with a Google WORK account.
//
// Work accounts only, because the domain is the point — it names the company
// evaluating Dakota, which an address typed into a box never could. This screen
// only has to make a refusal legible: "personal account" is a rule the visitor
// can act on, not an error that should read as something being broken.
//
// A server component with a server action, so no client bundle is shipped to
// render a page whose only interaction is one button.

const MESSAGES: Record<string, { title: string; body: string }> = {
  work_account_required: {
    title: 'That’s a personal account',
    body: 'Sign in with the Google account your company issued you — the one ending in your company’s domain.',
  },
  unverified_email: {
    title: 'That address isn’t verified',
    body: 'Google hasn’t verified the email on that account, so we can’t use it to keep your demo separate from anyone else’s.',
  },
  no_email: {
    title: 'No email address',
    body: 'That Google account didn’t share an email address, which is what your demo is keyed to.',
  },
  Configuration: {
    title: 'Sign-in isn’t configured',
    body: 'This deployment is missing its Google credentials. Nothing you did — see the README.',
  },
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; domain?: string }>
}) {
  if (await auth()) redirect('/')

  const { error, domain } = await searchParams
  const notice = error ? (MESSAGES[error] ?? { title: 'Sign-in failed', body: error }) : null

  return (
    <Center mih="100vh" p="md">
      <Card w={440} p="xl" bg="slate.8" withBorder>
        <Stack gap="lg">
          <Stack gap="xs">
            <Group gap={9}>
              <BrandMark size={22} />
              <Text size="sm" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
                Dakota
              </Text>
            </Group>
            <Title order={2}>Pay someone by asking</Title>
            <Text size="sm" c="dimmed">
              Give an agent a spending limit, then tell it what to pay in plain language. It
              drafts the payment; you approve it with your fingerprint. Nothing moves until you
              do.
            </Text>
          </Stack>

          <GoogleSignInButton clientId={googleClientId()} anyDomain={anyDomainAllowed()} />

          {devLoginEnabled() && (
            <>
              <Divider label="local development" labelPosition="center" />
              <form
                action={async (data: FormData) => {
                  'use server'
                  await signIn('dev', {
                    email: String(data.get('email') ?? ''),
                    redirectTo: '/',
                  })
                }}
              >
                <Stack gap="xs">
                  <Text size="xs" c="dimmed">
                    DEMO_DEV_LOGIN is on — sign in as anyone, no Google. Never enabled on a
                    real deployment.
                  </Text>
                  <Group gap="xs" wrap="nowrap">
                    <TextInput
                      flex={1}
                      name="email"
                      type="email"
                      required
                      placeholder="you@example.com"
                      defaultValue="ada@example.com"
                    />
                    <Button type="submit" variant="default">
                      Go
                    </Button>
                  </Group>
                </Stack>
              </form>
            </>
          )}

          {notice && (
            <Alert color={error === 'work_account_required' ? 'canyon' : 'blaze'} title={notice.title}>
              <Stack gap={6}>
                {domain && (
                  <Text size="sm">
                    <Text span ff="var(--font-mono)">
                      {domain}
                    </Text>{' '}
                    is a personal email provider.
                  </Text>
                )}
                <Text size="sm" c="dimmed">
                  {notice.body}
                </Text>
              </Stack>
            </Alert>
          )}

          <Text size="sm" c="dimmed">
            Test funds only — no real money moves. We use your work email to keep your demo
            separate from everyone else’s, and so we know you stopped by.
          </Text>
        </Stack>
      </Card>
    </Center>
  )
}
