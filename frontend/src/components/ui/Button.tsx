// Button — atom borrowed from dsh's ui-primitives (variant API preserved).
// Visual tokens map to ChatQuery's Apple-HIG palette (--brand, --bg-subtle,
// --border) so it slots in without a global theme rewrite. Geometry follows
// ChatQuery's radius scale (r-md = 8px) instead of dsh's capsule (r=18px).
//
// To switch this component to dsh's "pure black capsule" look, change only
// the token references in Button.module.css — no JSX changes required.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import css from './Button.module.css'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

export type ButtonProps = {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [css.button, css[variant], css[size], className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={classes} {...rest}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      {children}
    </button>
  )
}
