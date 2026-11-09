# @evoloop/ui

The workbench design system. It is the single source of design tokens and, later, the shared components described in [`docs/frontend/components.md`](../../docs/frontend/components.md).

- `src/tokens.css`: CSS custom properties for colours, type, spacing, size, radius, shadow and motion. Pages and components use these instead of literal values. Purposes and rules are in [`docs/frontend/foundations.md`](../../docs/frontend/foundations.md).
- `src/theme.css`: the Tailwind v4 theme that maps Tailwind utilities onto these tokens. Import it from a stylesheet processed by Tailwind.
- `src/logo.svg`, `src/logo-dark.svg`, `src/logo-small.svg`: the product mark for light pages, dark pages, and sizes of 24px and below (favicon).

Light ("warm paper") is the default. Dark ("warm ink") applies under `<html data-theme="dark">` and is only switched on for pages rebuilt on this package.

This package does not depend on `@evoloop/contracts` and does not issue requests.
