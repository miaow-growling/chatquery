// Input — single-line text input atom. API borrowed from dsh ui-primitives:
// the wrapper span holds the icon + the native input. Composer textareas /
// code-mirror editors stay where they are — this is for inline forms, search
// boxes, settings fields.
//
// Token mapping: same as Button — references ChatQuery palette directly so
// no global theme change is needed.

import type { InputHTMLAttributes, ReactNode } from 'react'
import css from './Input.module.css'

export type InputProps = {
  icon?: ReactNode
  className?: string
} & InputHTMLAttributes<HTMLInputElement>

export function Input({ icon, className, ...rest }: InputProps) {
  const wrapClass = [css.wrap, className].filter(Boolean).join(' ')
  return (
    <span className={wrapClass}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      <input className={css.input} {...rest} />
    </span>
  )
}
