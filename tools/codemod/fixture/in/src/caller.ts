import { getWidget, getWidgetQa, listWidgets, renameWidget } from './db/widgets.js'

export function widgetName(id: number): string {
  const w = getWidget(id)
  return w ? w.name : ''
}

export function describeWidget(id: number): string {
  return `widget ${widgetName(id)}`
}

export function renameAll(suffix: string): void {
  listWidgets().forEach((w) => renameWidget(w.id, w.name + suffix))
}

export const lookup = getWidget

// callbacks that expect a synchronous value stay as they are (reported, not rewritten)
export function mapCaller(ids: number[]) {
  return ids.map((id) => getWidgetQa(id))
}

export function timerCaller() {
  setInterval(() => { getWidgetQa(1) }, 1000)
}

export function takesVoidCallback(fn: (n: number) => void) { fn(1) }

export function usesVoidCallback() { takesVoidCallback((n) => { getWidgetQa(n) }) }
