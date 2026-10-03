export const PAGE_PERMISSIONS: Readonly<Record<string, string>>
export const TAB_PERMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>>
export const STATUS_BLOCK_PERMISSION: string
export function setNavRole(role: string | null | undefined): void
export function permissionForPage(pageId: string): string | null
export function isPageAllowed(pageId: string, role?: string | null): boolean
export function isTabAllowed(pageId: string, tab: string, role?: string | null): boolean
export interface GatingRoot {
  querySelectorAll(selector: string): ArrayLike<GatingElement> & { forEach(cb: (el: GatingElement) => void): void }
}
export interface GatingElement {
  hidden: boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  hasAttribute(name: string): boolean
  querySelectorAll(selector: string): ArrayLike<GatingElement> & { forEach(cb: (el: GatingElement) => void): void }
}
export function applyRbacAttrGating(root: GatingRoot, role?: string | null): number
export function initNavGating(opts: { doc?: GatingRoot; currentPage?: () => string | null; switchPage: (pageId: string) => void }): Promise<void>
