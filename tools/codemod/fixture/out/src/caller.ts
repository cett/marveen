import { getWidget, listWidgets, renameWidget } from './db/widgets.js'

export async function widgetName(id: number): Promise<string> {
  const w = await getWidget(id)
  return w ? w.name : ''
}

export async function describeWidget(id: number): Promise<string> {
  return `widget ${await widgetName(id)}`
}

export async function renameAll(suffix: string): Promise<void> {
  ;(await listWidgets()).forEach((w) => renameWidget(w.id, w.name + suffix))
}

export const lookup = getWidget
