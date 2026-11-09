# @evoloop/ui

The workbench design system. It is the single source of design tokens and, later, the shared components described in [`docs/frontend/components.md`](../../docs/frontend/components.md).

- `src/tokens.css`: CSS custom properties for colours, type, spacing, radius, shadow, motion and breakpoints. Pages and components use these instead of literal values. Purposes and rules are in [`docs/frontend/foundations.md`](../../docs/frontend/foundations.md).
- `src/theme.css`: the Tailwind v4 theme that maps Tailwind utilities onto these tokens. Import it from a stylesheet processed by Tailwind.

This package does not depend on `@evoloop/contracts` and does not issue requests.
