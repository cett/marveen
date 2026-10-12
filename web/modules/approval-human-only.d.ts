export interface ApprovalRowLike {
  status?: string
  human_only?: number | boolean | null
  [key: string]: unknown
}
export interface ViewerStatus {
  authenticated?: boolean
  method?: string | null
  role?: string | null
  tenant_id?: string | null
  [key: string]: unknown
}
export function isHumanOnlyRow(row: ApprovalRowLike | null | undefined): boolean
export function canDecideHumanOnly(status: ViewerStatus | null | undefined): boolean
export function isLockedForViewer(row: ApprovalRowLike | null | undefined, status: ViewerStatus | null | undefined): boolean
export function shouldShowHumanOnlyBanner(rows: ApprovalRowLike[] | null | undefined, status: ViewerStatus | null | undefined): boolean
