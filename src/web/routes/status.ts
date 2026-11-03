import { logger } from '../../logger.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { literalBlocks, stripAngleTags } from '../import-utils.js'
import type { RouteContext } from './types.js'

export async function tryHandleStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/status' && method === 'GET') {
    try {
      const rssResponse = await fetch('https://status.claude.com/history.rss', { signal: AbortSignal.timeout(10000) })
      const rssText = await rssResponse.text()

      const items: any[] = []
      // Plain string searches (literalBlocks), not [\s\S]*? patterns: a feed of many openers
      // and no closer was quadratic. Same items and fields as before.
      const field = (xml: string, tag: string): string =>
        literalBlocks(xml, `<${tag}>`, `</${tag}>`, 1)[0]?.trim() || ''
      for (const itemXml of literalBlocks(rssText, '<item>', '</item>')) {
        const title = field(itemXml, 'title')
        const description = field(itemXml, 'description')
        const pubDate = field(itemXml, 'pubDate')
        const link = field(itemXml, 'link')

        const cleanDesc = stripAngleTags(description
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'"))
          .replace(/\s+/g, ' ').trim()

        let status = 'investigating'
        if (cleanDesc.toLowerCase().includes('resolved')) status = 'resolved'
        else if (cleanDesc.toLowerCase().includes('monitoring')) status = 'monitoring'
        else if (cleanDesc.toLowerCase().includes('identified')) status = 'identified'

        items.push({ title, description: cleanDesc, pubDate, link, status })
      }

      let overall = 'operational'
      const activeIncidents = items.filter(i => i.status !== 'resolved')
      if (activeIncidents.length > 0) overall = 'degraded'

      // Real per-service status from the Statuspage components API. The RSS feed
      // only carries incident history (no per-service state), so the dashboard
      // used to invent a hardcoded service list and substring-match incident
      // titles -- which left every tile permanently "operational". Fetch the
      // actual components so the grid reflects reality; on failure we return an
      // empty array and the UI shows an honest "no per-service data" note rather
      // than a fake green grid.
      let components: Array<{ name: string; status: string }> = []
      try {
        const compResp = await fetch('https://status.claude.com/api/v2/components.json', { signal: AbortSignal.timeout(10000) })
        if (compResp.ok) {
          const compData = await compResp.json() as { components?: Array<{ name: string; status: string; group?: boolean }> }
          const seenNames = new Set<string>()
          components = (compData.components || [])
            .filter(c => !c.group) // drop group containers, keep leaf services
            .filter(c => {
              // the same service name can appear under multiple regional/parent
              // groups (e.g. "API" listed once per group), which duplicated
              // tiles in the status grid -- keep only the first occurrence.
              if (seenNames.has(c.name)) return false
              seenNames.add(c.name)
              return true
            })
            .map(c => ({ name: c.name, status: c.status }))
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to fetch Claude status components')
      }

      jsonMaybeGzip(req, res, { overall, components, incidents: items.slice(0, 15), fetchedAt: Date.now() })
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude status')
      json(res, { overall: 'unknown', components: [], incidents: [], fetchedAt: Date.now(), error: 'internal_error', hint: 'Failed to fetch status' })
    }
    return true
  }

  return false
}
