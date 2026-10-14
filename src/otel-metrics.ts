// In-process metric registry for the OTLP push exporter (src/web/otel-push-exporter.ts).
//
// Counters and histograms are fed by the code that sees the event (the schedule runner, the message
// router, the exporter itself) and are CUMULATIVE since the process started, the idiomatic OTLP shape: a
// restart is a counter reset, which every backend handles. Gauges are read from a callback at export time
// (queue depth, oldest pending age), so they cost nothing between exports.
//
// Every metric is declared once with the attribute keys it may carry; an attribute that is not declared is
// dropped when a value is recorded. That keeps the metrics free of content by construction, in line with the
// span attribute allowlist in src/otel-exporter.ts: names, statuses and counts only, never text.

export type MetricAttrValue = string | number | boolean
export type MetricAttrs = Record<string, MetricAttrValue>

interface OtelAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; boolValue?: boolean }
}

interface BaseDef {
  name: string
  unit: string
  attrKeys: readonly string[]
}
interface CounterDef extends BaseDef { kind: 'counter' }
interface HistogramDef extends BaseDef { kind: 'histogram'; bounds: readonly number[] }
interface GaugeDef extends BaseDef {
  kind: 'gauge'
  collect: () => { attrs?: MetricAttrs; value: number }[]
}
type MetricDef = CounterDef | HistogramDef | GaugeDef

interface HistogramSeries { count: number; sum: number; min: number; max: number; buckets: number[] }

const startedAtMs = Date.now()
const defs = new Map<string, MetricDef>()
const counters = new Map<string, Map<string, { attrs: MetricAttrs; value: number }>>()
const histograms = new Map<string, Map<string, { attrs: MetricAttrs; series: HistogramSeries }>>()

// Seconds: from a fast local operation up to a long-running scheduled task.
export const DURATION_BOUNDS_SECONDS: readonly number[] = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600]

export function defineCounter(name: string, unit: string, attrKeys: readonly string[] = []): void {
  defs.set(name, { kind: 'counter', name, unit, attrKeys })
}

export function defineHistogram(
  name: string, unit: string, attrKeys: readonly string[] = [], bounds: readonly number[] = DURATION_BOUNDS_SECONDS,
): void {
  defs.set(name, { kind: 'histogram', name, unit, attrKeys, bounds })
}

export function defineGauge(
  name: string, unit: string, collect: GaugeDef['collect'], attrKeys: readonly string[] = [],
): void {
  defs.set(name, { kind: 'gauge', name, unit, attrKeys, collect })
}

function pickAttrs(def: BaseDef, attrs: MetricAttrs | undefined): MetricAttrs {
  const out: MetricAttrs = {}
  if (!attrs) return out
  for (const key of def.attrKeys) if (key in attrs) out[key] = attrs[key]
  return out
}

function seriesKey(attrs: MetricAttrs): string {
  return JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1)))
}

// Adds `delta` to a declared counter. An undeclared name is ignored: instrumentation never throws.
export function otelCount(name: string, attrs?: MetricAttrs, delta = 1): void {
  const def = defs.get(name)
  if (!def || def.kind !== 'counter' || !Number.isFinite(delta) || delta < 0) return
  const picked = pickAttrs(def, attrs)
  const key = seriesKey(picked)
  const series = counters.get(name) ?? new Map()
  const cur = series.get(key) ?? { attrs: picked, value: 0 }
  cur.value += delta
  series.set(key, cur)
  counters.set(name, series)
}

// Records one observation in a declared histogram.
export function otelRecord(name: string, value: number, attrs?: MetricAttrs): void {
  const def = defs.get(name)
  if (!def || def.kind !== 'histogram' || !Number.isFinite(value) || value < 0) return
  const picked = pickAttrs(def, attrs)
  const key = seriesKey(picked)
  const all = histograms.get(name) ?? new Map()
  const cur = all.get(key) ?? {
    attrs: picked,
    series: { count: 0, sum: 0, min: value, max: value, buckets: new Array(def.bounds.length + 1).fill(0) },
  }
  const s: HistogramSeries = cur.series
  s.count += 1
  s.sum += value
  s.min = Math.min(s.min, value)
  s.max = Math.max(s.max, value)
  // explicit bucket i holds values <= bounds[i]; the last bucket is the overflow
  const idx = def.bounds.findIndex((b) => value <= b)
  s.buckets[idx === -1 ? def.bounds.length : idx] += 1
  all.set(key, cur)
  histograms.set(name, all)
}

function toAttributes(attrs: MetricAttrs): OtelAttribute[] {
  return Object.entries(attrs).map(([key, val]) => {
    if (typeof val === 'boolean') return { key, value: { boolValue: val } }
    if (typeof val === 'number') return { key, value: { intValue: String(Math.round(val)) } }
    return { key, value: { stringValue: val } }
  })
}

const nano = (ms: number) => String(Math.round(ms) * 1_000_000)

export interface RegistryMetric {
  name: string
  unit: string
  sum?: { dataPoints: unknown[]; aggregationTemporality: number; isMonotonic: boolean }
  gauge?: { dataPoints: unknown[] }
  histogram?: { dataPoints: unknown[]; aggregationTemporality: number }
}

// Every metric that currently has data, in OTLP/JSON shape. Empty when nothing was recorded yet.
// 2 = AGGREGATION_TEMPORALITY_CUMULATIVE.
export function collectRegistryMetrics(nowMs = Date.now()): RegistryMetric[] {
  const out: RegistryMetric[] = []
  const start = nano(startedAtMs)
  const now = nano(nowMs)
  for (const def of defs.values()) {
    if (def.kind === 'counter') {
      const series = [...(counters.get(def.name)?.values() ?? [])]
      if (series.length === 0) continue
      out.push({
        name: def.name, unit: def.unit,
        sum: {
          aggregationTemporality: 2, isMonotonic: true,
          dataPoints: series.map((s) => ({
            attributes: toAttributes(s.attrs), startTimeUnixNano: start, timeUnixNano: now, asInt: String(Math.round(s.value)),
          })),
        },
      })
    } else if (def.kind === 'histogram') {
      const series = [...(histograms.get(def.name)?.values() ?? [])]
      if (series.length === 0) continue
      out.push({
        name: def.name, unit: def.unit,
        histogram: {
          aggregationTemporality: 2,
          dataPoints: series.map((s) => ({
            attributes: toAttributes(s.attrs), startTimeUnixNano: start, timeUnixNano: now,
            count: String(s.series.count), sum: s.series.sum, min: s.series.min, max: s.series.max,
            bucketCounts: s.series.buckets.map(String), explicitBounds: [...def.bounds],
          })),
        },
      })
    } else {
      let points: { attrs?: MetricAttrs; value: number }[] = []
      try {
        points = def.collect()
      } catch {
        continue // a gauge that cannot be read is skipped, never fatal to the export
      }
      if (points.length === 0) continue
      out.push({
        name: def.name, unit: def.unit,
        gauge: {
          dataPoints: points.map((p) => ({
            attributes: toAttributes(pickAttrs(def, p.attrs)), timeUnixNano: now, asDouble: p.value,
          })),
        },
      })
    }
  }
  return out
}

// Test seam: forget every recorded value (declarations stay).
export function resetMetricValues(): void {
  counters.clear()
  histograms.clear()
}
