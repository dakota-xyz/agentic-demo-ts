import {
  createTheme,
  defaultVariantColorsResolver,
  type MantineColorsTuple,
  type VariantColorsResolverInput,
} from '@mantine/core'

/**
 * The Dakota Mantine theme.
 *
 * The app imports Mantine directly (MIT) and this file lays Dakota's brand over
 * it: the colour scales, the spacing and type scale, and the component defaults.
 * The typeface is Inter, wired in `layout.tsx` via next/font.
 *
 * Colour rule: never a raw hex in app code. Everything resolves to these named
 * scales — `slate` (neutrals), `sierra` (brand), `evergreen` (settled), `canyon`
 * (in flight), `blaze` (failed).
 */

const slate: MantineColorsTuple = [
  '#FFFFFF', '#cdcccb', '#b0afad', '#929190', '#757472',
  '#585654', '#464543', '#353432', '#232222', '#121111',
]
const sierra: MantineColorsTuple = [
  '#e4c0a6', '#cea181', '#b9825b', '#a36336', '#8e4410',
  '#72360d', '#55290a', '#391b06', '#2b1405', '#1c0e03',
]
const evergreen: MantineColorsTuple = [
  '#e0e4df', '#c1cabf', '#a2af9e', '#83957e', '#647a5e',
  '#50624b', '#3c4938', '#283126', '#1e251c', '#141813',
]
const canyon: MantineColorsTuple = [
  '#d1c3b4', '#b6a593', '#9c8873', '#816a52', '#674d31',
  '#523e27', '#3e2e1d', '#291f14', '#1f170f', '#150f0a',
]
const blaze: MantineColorsTuple = [
  '#dca4a7', '#c48184', '#ab5e62', '#933b3f', '#7b181d',
  '#621317', '#4a0e11', '#310a0c', '#250709', '#190506',
]

// The specific steps the button resolver reaches for, named as the design
// system named them (the alias is not always the array index — kept as literals
// so the mapping cannot drift).
const c = {
  slate0: '#FFFFFF',
  slate10: '#cdcccb',
  slate60: '#464543',
  slate70: '#353432',
  slate80: '#232222',
  sierra40: '#a36336',
  sierra50: '#8e4410',
  evergreen40: '#83957e',
  evergreen50: '#647a5e',
  blaze30: '#ab5e62',
  blaze40: '#933b3f',
  blaze50: '#7b181d',
  blaze70: '#4a0e11',
  blaze80: '#310a0c',
}
const borderWhite10 = '1px solid rgba(255,255,255, 0.1)'

/**
 * Buttons speak in neutrals, not brand tints.
 *
 * Mantine's default `light` and `subtle` variants tint with the primary colour;
 * the design system overrides them to slate so a secondary or tertiary button
 * reads as neutral, and only `filled` carries the brand. `blaze` keeps its own
 * resolution for destructive actions.
 */
function variantColorResolver(input: VariantColorsResolverInput) {
  const base = defaultVariantColorsResolver(input)

  if (input.variant === 'filled') {
    if (input.color === 'blaze') {
      return { background: c.blaze50, hover: c.blaze40, color: c.slate0, border: borderWhite10 }
    }
    if (input.color === 'evergreen') {
      return { background: c.evergreen50, hover: c.evergreen40, color: c.slate0, border: borderWhite10 }
    }
    return { background: c.sierra50, hover: c.sierra40, color: c.slate0, border: borderWhite10 }
  }

  if (input.variant === 'light') {
    if (input.color === 'blaze') {
      return { background: c.blaze80, hover: c.blaze70, color: c.blaze30, border: borderWhite10 }
    }
    return { background: c.slate70, hover: c.slate60, color: c.slate0, border: borderWhite10 }
  }

  if (input.variant === 'subtle') {
    if (input.color === 'blaze') {
      return { background: 'transparent', hover: c.blaze80, color: c.blaze50, border: '1px solid transparent' }
    }
    return { background: c.slate80, hover: c.slate70, color: c.slate10, border: borderWhite10 }
  }

  return base
}

// next/font exposes the families under these CSS variables (see layout.tsx).
const fontSans = 'var(--font-sans), system-ui, -apple-system, Helvetica, Arial, sans-serif'
const fontMono = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

const headingSizes = {
  h1: { fontSize: 'calc(2.5rem * var(--mantine-scale))', lineHeight: '1.2' },
  h2: { fontSize: 'calc(1.875rem * var(--mantine-scale))', lineHeight: '1.25' },
  h3: { fontSize: 'calc(1.4583333333333335rem * var(--mantine-scale))', lineHeight: '1.3' },
  h4: { fontSize: 'calc(1.25rem * var(--mantine-scale))', lineHeight: '1.35' },
  h5: { fontSize: 'calc(1.0416666666666667rem * var(--mantine-scale))', lineHeight: '1.4' },
  h6: { fontSize: 'calc(0.9375rem * var(--mantine-scale))', lineHeight: '1.45' },
}

export const theme = createTheme({
  variantColorResolver,
  defaultRadius: 'md',
  fontFamily: fontSans,
  fontFamilyMonospace: fontMono,

  colors: { blaze, canyon, evergreen, sierra, slate },
  primaryColor: 'sierra',
  primaryShade: { light: 4, dark: 4 },
  white: '#FFFFFF',
  black: '#000000',
  focusRing: 'auto',

  // A tighter type scale than Mantine's default — the app is built around it, so
  // size="sm" etc. must resolve to these, not Mantine's larger steps.
  fontSizes: {
    xs: 'calc(0.625rem * var(--mantine-scale))',
    sm: 'calc(0.75rem * var(--mantine-scale))',
    md: 'calc(0.8333333333333333rem * var(--mantine-scale))',
    lg: 'calc(0.9375rem * var(--mantine-scale))',
    xl: 'calc(1.0416666666666667rem * var(--mantine-scale))',
    xxl: 'calc(1.25rem * var(--mantine-scale))',
    xxxl: 'calc(1.6666666666666665rem * var(--mantine-scale))',
    xxxxl: 'calc(1.875rem * var(--mantine-scale))',
  },
  lineHeights: {
    xxs: '1.2', xs: '1.25', sm: '1.3', md: '1.35', lg: '1.4', xl: '1.45', xxl: '1.55',
  },
  spacing: {
    xs: 'calc(0.25rem * var(--mantine-scale))',
    sm: 'calc(0.5rem * var(--mantine-scale))',
    md: 'calc(1rem * var(--mantine-scale))',
    lg: 'calc(1.5rem * var(--mantine-scale))',
    xl: 'calc(2rem * var(--mantine-scale))',
  },
  radius: {
    xs: 'calc(0.125rem * var(--mantine-scale))',
    sm: 'calc(0.25rem * var(--mantine-scale))',
    md: 'calc(0.375rem * var(--mantine-scale))',
    lg: 'calc(0.5rem * var(--mantine-scale))',
    xl: 'calc(0.75rem * var(--mantine-scale))',
  },
  shadows: {
    xs: '0 1px 2px rgba(0, 0, 0, 0.3)',
    sm: '0 2px 4px rgba(0, 0, 0, 0.4)',
    md: '0 4px 8px rgba(0, 0, 0, 0.5)',
    lg: '0 8px 16px rgba(0, 0, 0, 0.6)',
    xl: '0 16px 32px rgba(0, 0, 0, 0.7)',
  },
  headings: {
    fontFamily: fontSans,
    fontWeight: '600',
    textWrap: 'balance',
    sizes: headingSizes,
  },

  components: {
    AppShell: {
      styles: {
        header: { backgroundColor: '#121111' },
        main: { backgroundColor: 'transparent' },
        navbar: { backgroundColor: 'transparent' },
        root: { backgroundColor: 'transparent' },
      },
    },
    Button: {
      defaultProps: { fw: '500', px: 'calc(0.5rem * var(--mantine-scale))', variant: 'filled' },
    },
    Card: {
      defaultProps: { padding: 'lg', radius: 'md' },
      styles: {
        root: {
          backgroundColor: '#353432',
          borderColor: '#464543',
          border: '1px solid #464543',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.09)',
        },
      },
    },
    Input: { defaultProps: { size: 'md' } },
    InputWrapper: {
      defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] },
      styles: { label: { fontSize: 'calc(0.75rem * var(--mantine-scale))' } },
    },
    Modal: {
      defaultProps: { centered: true, padding: 0 },
      styles: {
        content: { padding: 0, backgroundColor: '#353432', border: 'none', display: 'flex', flexDirection: 'column' },
        body: { padding: 0, backgroundColor: '#353432', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
        header: { display: 'none' },
      },
    },
    Paper: {
      defaultProps: { p: 'md', shadow: 'sm', radius: 'md' },
      styles: {
        root: {
          backgroundColor: '#353432',
          borderColor: '#464543',
          border: '1px solid #464543',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.09)',
        },
      },
    },
    Select: {
      defaultProps: { size: 'md', withAsterisk: false },
      styles: {
        input: {
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: 'none',
          color: '#cdcccb',
          fontSize: 'calc(0.75rem * var(--mantine-scale))',
          '&::placeholder': { color: '#757472' },
          '&:focus': { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'transparent' },
        },
        option: { fontSize: 'calc(0.75rem * var(--mantine-scale))' },
      },
    },
    Table: {
      defaultProps: { striped: true, highlightOnHover: true, withTableBorder: false, withColumnBorders: false },
    },
    Textarea: {
      defaultProps: { size: 'md', withAsterisk: false },
      styles: {
        input: {
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: 'none',
          color: '#cdcccb',
          fontSize: 'calc(0.75rem * var(--mantine-scale))',
          '&::placeholder': { color: '#757472' },
          '&:focus': { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'transparent' },
        },
      },
    },
    TextInput: {
      defaultProps: { size: 'md', withAsterisk: false },
      styles: {
        input: {
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: 'none',
          color: '#cdcccb',
          fontSize: 'calc(0.75rem * var(--mantine-scale))',
          '&::placeholder': { color: '#757472' },
          '&:focus': { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'transparent' },
        },
      },
    },
    // Tooltip was a wrapped component in the design system, not a theme entry —
    // reproduced here so tips keep the dark, mono look instead of Mantine's
    // default light bubble.
    Tooltip: {
      defaultProps: { arrowSize: 8 },
      styles: {
        arrow: { border: '1px solid #353432' },
        tooltip: {
          backgroundColor: '#121111',
          border: '1px solid #353432',
          borderRadius: 'calc(0.25rem * var(--mantine-scale))',
          color: '#FFFFFF',
          fontFamily: fontMono,
          padding: '4px 8px',
        },
      },
    },
  },
})
