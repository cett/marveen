export type ScreenAccessRole = 'admin' | 'agent' | 'read_only' | 'viewer'
export type ScreenAccessLevel = 'full' | 'ro' | 'gap' | 'none'

export interface ScreenAccessRow {
  key: string
  backend: string
  roles: Record<ScreenAccessRole, ScreenAccessLevel>
}

export const SCREEN_ACCESS_ROLES: readonly ScreenAccessRole[]
export const SCREEN_ACCESS_ROWS: readonly ScreenAccessRow[]
export const SCREEN_ACCESS_GAPS: readonly string[]
