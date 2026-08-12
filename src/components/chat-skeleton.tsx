'use client'

import { Group, Skeleton, Stack } from '@mantine/core'
import { BrandMark } from './brand-mark'

// What the transcript looks like while it loads.
//
// A spinner says "something is happening"; this says "a conversation is about
// to be here", which is the more useful thing to know — the layout does not
// jump when the real turns arrive, and a returning visitor recognises their own
// chat before they can read it.
//
// The widths are irregular on purpose. Uniform bars read as a loading graphic;
// ragged ones read as speech.
const LINES: { role: 'agent' | 'user'; widths: number[] }[] = [
  { role: 'agent', widths: [92, 78, 46] },
  { role: 'user', widths: [58] },
  { role: 'agent', widths: [84, 69] },
  { role: 'user', widths: [37] },
  { role: 'agent', widths: [88, 74, 52] },
]

export function ChatSkeleton() {
  return (
    <Stack gap="md" maw={772} mx="auto" w="100%" py="lg" px="lg" aria-hidden>
      {LINES.map((turn, i) => (
        <Group
          key={i}
          justify={turn.role === 'user' ? 'flex-end' : 'flex-start'}
          align="flex-start"
          gap="sm"
          wrap="nowrap"
        >
          {turn.role === 'agent' && (
            <div style={{ opacity: 0.25, flexShrink: 0, paddingTop: 2 }}>
              <BrandMark size={18} />
            </div>
          )}
          {/* Always a full-width track, with alignItems choosing the side. The
              bar widths are percentages, and a percentage inside an auto-width
              container resolves to nothing — which silently collapsed every
              user-side row. */}
          <Stack
            gap={7}
            style={{
              width: '100%',
              alignItems: turn.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {turn.widths.map((w, j) => (
              <Skeleton
                key={j}
                height={13}
                radius="sm"
                width={`${w}%`}
                // Staggered so the block breathes rather than pulsing as one
                // slab, which is what makes a skeleton read as loading at all.
                style={{ animationDelay: `${(i * 3 + j) * 90}ms` }}
              />
            ))}
          </Stack>
        </Group>
      ))}
    </Stack>
  )
}
