export interface AuthStatus {
  authenticated?: boolean
  method?: string | null
  login_available?: boolean
  [key: string]: unknown
}
export function holdsSession(status: AuthStatus | null | undefined): boolean
export function shouldOfferSignIn(status: AuthStatus | null | undefined): boolean
export function enrollUnlessSession(args: {
  code: string | null | undefined
  probeStatus: () => Promise<AuthStatus | null>
  exchange: (code: string) => Promise<string>
}): Promise<string>
export interface SignInEntryDoc {
  getElementById(id: string): {
    hidden: boolean
    dataset: Record<string, string | undefined>
    addEventListener(type: string, cb: (e: { preventDefault(): void }) => void): void
  } | null
}
export function applySignInEntry(status: AuthStatus | null | undefined, doc?: SignInEntryDoc, openLogin?: () => void): void
