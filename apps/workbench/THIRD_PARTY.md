# Frontend upstream sources

- `frontend-design`: anthropics/skills@dbd4588f9e1033efb41dad4bef2f7947c8993d44, `skills/frontend-design/SKILL.md`, license in local LICENSE.txt. Project scope `.agents/skills/frontend-design` only; instructions, no executable dependencies.
- `web-design-guidelines`: project-local authored reference entry to Vercel instructions. Upstream repository exposes no license file, so its source text is not redistributed; read it remotely for review.

- shadcn/ui@2c2fe97eb96b2c5c7d03d1ae2756a851c3790030: adapted `apps/www/registry/new-york/ui/button.tsx` and `sheet.tsx` (local utility import and Chinese close label), MIT. Direct runtime dependencies: Radix Dialog, CVA, clsx, tailwind-merge and lucide-react; Tailwind CSS/Vite compile styling. No upstream application/store/runtime copied.

Upstream source SHA-256: button `c2b999a96781e6c932632bd089095368e973bf5602e1b1a62156b7d2b43f1e84`; sheet `363f8e06aa5b53c6475f445117f60fa9294be79e9e4f1f5bf70886800188124e`. MIT license text fetched at upstream ba1503c64472b82256d9de95e2e62c5901a38e8b. Package dependency versions and transitive closure are fixed in root package-lock.json.

- `@evoloop/ui` components (`packages/ui/src/components/`) are written for this project following the shadcn/ui and Radix patterns above; no further upstream source was copied. Added runtime dependencies, all MIT: Radix Tabs, Tooltip, Dropdown Menu, Hover Card and Collapsible (versions fixed in `packages/ui/package.json` and the root lockfile). Agent avatars are project-drawn SVG.

- TanStack Router (`@tanstack/react-router` 1.170.46 and its `router-core`, `history` and `store` packages), MIT: path URLs and browser history for the workbench (#229 PR4a). Used as a package; no source copied. Version fixed in `apps/workbench/package.json` and the root lockfile.
