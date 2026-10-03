export const ROLE_PERMISSIONS: Record<string, ReadonlySet<string>>
export function getAuthStatus(): Promise<{ role?: string | null } | null>
export function can(permission: string): Promise<boolean>
export function gate(selector: string, permission: string, mode?: 'hide' | 'disable'): Promise<boolean>
export function roleHas(role: string | null | undefined, permission: string): boolean
