import { getWidget, listWidgets, renameWidget } from './db/widgets.js'

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
