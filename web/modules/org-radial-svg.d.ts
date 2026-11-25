import type { RadialLayout } from './org-radial-layout.js'

export const AVATAR_SIZE: Readonly<{ normal: number; centre: number }>
export const RING_OFFSET: number
export const LABEL_MAX: number

export function shortLabel(text: unknown, max?: number): string
export function monogram(text: unknown): string

export interface TenantViewInput {
  id: string
  name?: string
  rootId?: string | null
  nodes: { id: string; label?: string; title?: string | null; running?: boolean }[]
  edges?: { from: string; to: string }[]
}

export interface RenderOptions {
  index?: number
  avatarUrl(id: string): string
  a11yLabel(n: { label: string; title: string | null; running: boolean }): string
  hiddenLabel(n: number): string
  ariaLabel?: string
}

export function renderRadialSvg(tenant: TenantViewInput, layout: RadialLayout, opts: RenderOptions): string
