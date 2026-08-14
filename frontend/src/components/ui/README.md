# UI primitives — Phase A sample (dsh → ChatQuery)

> **Status: dev sample, not yet integrated into business components.**
> Hand-built atoms that borrow the **API surface** of DeepSeek Harness'
> [`dsh-client-ui-primitives`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-primitives)
> and map the **visual tokens** onto ChatQuery's existing Apple-HIG palette
> (`frontend/src/style.css`). No runtime dependency on dsh; no global theme
> changes; existing business components are untouched.

## What's in here

| File | Purpose |
|------|---------|
| `Button.tsx` + `Button.module.css` | 4-variant × 2-size atom (primary / ghost / outline / toolbar) |
| `Input.tsx` + `Input.module.css` | Single-line text input, optional leading icon |
| `UiPreview.tsx` + `UiPreview.module.css` | Floating overlay that renders every variant for eyeballing |
| `index.ts` | Barrel export |
| `vite-env.d.ts` | Vite client types (required for `.module.css` to type-check) |

## Design decisions (so you can tweak confidently)

- **API parity with dsh** — `variant: 'primary' \| 'ghost' \| 'outline' \| 'toolbar'`,
  `size: 'md' \| 'sm'`, optional `icon`. Same `ButtonHTMLAttributes` pass-through.
  If you later want to pull in the real dsh package, JSX stays the same.
- **Visual adaptation, not 1:1 copy**:
  - Radius: 8px (`--r-md`) — matches ChatQuery's pill-free HIG rhythm.
    dsh uses full capsule (`r=18px`); we soften it for desktop feel.
  - Height: 32px (md) / 26px (sm) — sits next to existing 28px `icon-btn` /
    32px `sidebar-actions button` without looking out of scale.
  - Color: `var(--brand)` indigo instead of dsh's pure black, so the
    primary button reads as "yours" not "out of place".
- **CSS Modules, not global classes** — your business components share one
  global `style.css`. UI atoms live in `.module.css` so the namespacing is
  per-component, the way dsh does it. This is a clean place to start a real
  design-system boundary if you want one.
- **No new globals in `style.css`** — every `var(--…)` in these `.module.css`
  files is already defined. If you want to swap to dsh's `--dsw-alias-*`
  layer, add those aliases to `style.css` and swap the references — the JSX
  doesn't change.

## How to preview (without committing to a real integration)

The fastest way to see the atoms in action is to mount `UiPreview` once in
`App.tsx` and then remove the line. Two options:

### Option A — always-on in dev (1 line)

```tsx
// at the top of App.tsx, alongside the other imports
import { UiPreview } from './components/ui'

// anywhere inside the root <div className="root"> ... </div>
{import.meta.env.DEV && <UiPreview onClose={() => {}} />}
```

`UiPreview` is self-contained: backdrop click + Esc both close. The
`onClose` is required by the type; in DEV-keep-alive mode just pass a
no-op.

### Option B — toggle (3 lines)

```tsx
const [showUi, setShowUi] = useState(false)
// ... inside the root ...
{showUi && <UiPreview onClose={() => setShowUi(false)} />}
<button onClick={() => setShowUi(true)} style={{ position: 'fixed', bottom: 16, right: 16 }}>
  UI
</button>
```

## Verification done

- `npx tsc --noEmit` — 0 errors
- `npx vite build` — 403 modules transformed, 2.6s, no warnings introduced
- No existing files modified (App.tsx / main.tsx / style.css untouched)

## Next steps (only if you like what you see)

- **Phase A full**: Pill / DisclosureRow / Menu / Modal / Tooltip / Toast
  (still no business integration; same "preview overlay" delivery).
- **Phase B content blocks**: JsonBlock / CodeBlock / DiffBlock — these
  *do* land in real code paths (AI message rendering, PHP unserialiser view).
- **Phase C (optional)**: real `--dsw-alias-*` token layer in `style.css` if
  you want dsh and your own theme to live side by side.
- **Phase D (optional)**: extract into its own workspace package if the
  project ever grows a second client (web companion, CLI TUI styles, etc.).

## Source reference (for credit + comparison)

- dsh source: https://github.com/deepseek-ai/deepseek-harness
- Borrowed files (raw, 2026-08-14):
  - `packages/client/ui-primitives/src/Button.tsx` + `Button.module.css`
  - `packages/client/ui-primitives/src/Input.tsx` + `Input.module.css`
- All visual values re-derived; no code copied verbatim.
