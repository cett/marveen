export function restartRefusalReason(
  status: number,
  data: Record<string, unknown> | null,
): 'busy' | 'no_pane' | null

export function postGatedRestart(
  url: string,
  deps: {
    fetchFn: (input: string, init?: RequestInit) => Promise<Response>
    confirmFn: (message: string) => boolean
    tFn: (key: string) => string
    plainBody?: string
  },
): Promise<{ res: Response; data: any; cancelled: boolean }>
