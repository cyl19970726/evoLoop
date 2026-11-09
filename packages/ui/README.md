# @evoloop/ui

The workbench design system. It is the single source of design tokens and the shared components described in [`docs/frontend/components.md`](../../docs/frontend/components.md).

- `src/tokens.css`: CSS custom properties for colours, type, spacing, size, radius, shadow and motion. Pages and components use these instead of literal values. Purposes and rules are in [`docs/frontend/foundations.md`](../../docs/frontend/foundations.md).
- `src/theme.css`: the Tailwind v4 theme that maps Tailwind utilities onto these tokens. Import it from a stylesheet processed by Tailwind.
- `src/scope.css`: isolation for pages built on this package while the old workbench CSS exists. Mark the page root and overlays with `data-ui`; load the file after the old CSS.
- `src/index.ts`: React components (buttons, fields, status, state, list, overlays, avatars, logo). They take text from the caller and know nothing about business objects. Visual reference: the workbench sample page at `#/ui`.
- `src/logo.svg`, `src/logo-dark.svg`, `src/logo-small.svg`: the product mark for light pages, dark pages, and sizes of 24px and below (favicon).

Light ("warm paper") is the default. Dark ("warm ink") applies under `<html data-theme="dark">` and is only switched on for pages rebuilt on this package.

This package does not depend on `@evoloop/contracts` and does not issue requests.
