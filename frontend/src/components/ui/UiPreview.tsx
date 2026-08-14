// UiPreview — floating overlay that renders the current ui/ atoms in every
// variant × size, so a reviewer can eyeball the result without wiring the
// components into a real feature yet. Closes with × or Esc.
//
// Mount in App.tsx (anywhere inside the root):
//   import { UiPreview } from './components/ui'
//   {showUiPreview && <UiPreview onClose={() => setShowUiPreview(false)} />}
//
// Or open it on demand from a key combo / devtools entry — the component is
// pure UI, no global side effects.

import { useEffect } from 'react'
import { Button } from './Button'
import { Input } from './Input'
import css from './UiPreview.module.css'

export function UiPreview({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.panel} onClick={(e) => e.stopPropagation()}>
        <header className={css.head}>
          <div>
            <h2 className={css.title}>UI Preview</h2>
            <p className={css.sub}>
              Atoms borrowed from <code>dsh</code> ui-primitives, token-mapped to ChatQuery palette.
              Esc / × to close.
            </p>
          </div>
          <button className={css.close} onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className={css.section}>
          <h3 className={css.h3}>Button — variant × size</h3>
          <div className={css.grid}>
            <Row label="primary">
              <Button variant="primary">保存</Button>
              <Button variant="primary" size="sm">保存</Button>
              <Button variant="primary" disabled>保存</Button>
            </Row>
            <Row label="ghost">
              <Button variant="ghost">取消</Button>
              <Button variant="ghost" size="sm">取消</Button>
              <Button variant="ghost" disabled>取消</Button>
            </Row>
            <Row label="outline">
              <Button variant="outline">更多</Button>
              <Button variant="outline" size="sm">更多</Button>
              <Button variant="outline" disabled>更多</Button>
            </Row>
            <Row label="toolbar">
              <Button variant="toolbar">筛选</Button>
              <Button variant="toolbar" size="sm">筛选</Button>
              <Button variant="toolbar" disabled>筛选</Button>
            </Row>
          </div>
        </section>

        <section className={css.section}>
          <h3 className={css.h3}>Input — with / without icon, states</h3>
          <div className={css.stack}>
            <Input placeholder="搜索连接…" />
            <Input placeholder="搜索连接…" defaultValue="local-mysql" />
            <Input placeholder="API 密钥" disabled defaultValue="sk-…" />
            <Input
              icon={<span>🔍</span>}
              placeholder="带前置图标的搜索框"
            />
          </div>
        </section>

        <section className={css.section}>
          <h3 className={css.h3}>Side-by-side — dsh source vs ChatQuery-mapped</h3>
          <div className={css.compare}>
            <div className={css.col}>
              <p className={css.colHead}>dsh source <small>(Button.module.css)</small></p>
              <pre className={css.code}>{`border-radius: 18px;        /* full capsule */
height: 36px;               /* md */
background: var(--dsw-alias-button-primary-fill);  /* black */
color: var(--dsw-alias-label-primary-foreground);  /* white */`}</pre>
            </div>
            <div className={css.col}>
              <p className={css.colHead}>ChatQuery-mapped <small>(this file)</small></p>
              <pre className={css.code}>{`border-radius: var(--r-md);  /* 8px  */
height: 32px;               /* md */
background: var(--brand);   /* indigo */
color: var(--text-on-brand); /* white */`}</pre>
            </div>
          </div>
          <p className={css.foot}>
            Want the pure-dsh look instead? Swap the <code>var(--brand)</code> / <code>var(--r-md)</code> lines in
            <code> Button.module.css</code> for the dsh originals — JSX stays as-is.
          </p>
        </section>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      <div className={css.rowItems}>{children}</div>
    </div>
  )
}
