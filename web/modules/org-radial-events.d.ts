export interface RadialEventApi {
  open(id: string): void
  isMain(id: string): boolean
}
export function wireRadialEvents(
  container: { addEventListener(type: string, fn: (e: any) => void): void; querySelectorAll(sel: string): Iterable<any> },
  api: RadialEventApi,
): void
