import { describe, it, expect, beforeEach } from 'vitest'
import {
  defineCounter, defineHistogram, defineGauge, otelCount, otelRecord, collectRegistryMetrics, resetMetricValues,
} from '../otel-metrics.js'

defineCounter('test.counter', '{x}', ['kind'])
defineHistogram('test.hist', 's', ['kind'], [1, 5])
defineGauge('test.gauge', '{x}', () => [{ attrs: { kind: 'a', secret: 'leak' }, value: 3 }], ['kind'])
defineGauge('test.broken', '{x}', () => { throw new Error('db gone') })
defineGauge('test.gauge.async', '{x}', () => Promise.resolve([{ attrs: { kind: 'b', secret: 'leak' }, value: 7 }]), ['kind'])
defineGauge('test.broken.async', '{x}', () => Promise.reject(new Error('db gone')))

const find = async (name: string) => (await collectRegistryMetrics()).find((m) => m.name === name)

beforeEach(() => resetMetricValues())

describe('otel-metrics registry', () => {
  it('counts per attribute set, cumulative, monotonic (temporality 2)', async () => {
    otelCount('test.counter', { kind: 'a' })
    otelCount('test.counter', { kind: 'a' }, 2)
    otelCount('test.counter', { kind: 'b' })
    const sum = (await find('test.counter'))!.sum!
    expect(sum.aggregationTemporality).toBe(2)
    expect(sum.isMonotonic).toBe(true)
    const byKind = Object.fromEntries((sum.dataPoints as any[]).map((d) => [d.attributes[0].value.stringValue, d.asInt]))
    expect(byKind).toEqual({ a: '3', b: '1' })
  })

  it('drops an attribute the metric did not declare (no content by construction)', async () => {
    otelCount('test.counter', { kind: 'a', body: 'message text', chat_id: '123' })
    const point = ((await find('test.counter'))!.sum!.dataPoints as any[])[0]
    expect(point.attributes.map((a: any) => a.key)).toEqual(['kind'])
    expect(JSON.stringify(await find('test.counter'))).not.toContain('message text')
  })

  it('ignores an undeclared metric, a negative delta and a non-finite value instead of throwing', async () => {
    expect(() => otelCount('nope', {})).not.toThrow()
    otelCount('test.counter', { kind: 'a' }, -1)
    otelRecord('test.hist', Number.NaN, { kind: 'a' })
    otelRecord('test.hist', -2, { kind: 'a' })
    expect(await find('test.counter')).toBeUndefined()
    expect(await find('test.hist')).toBeUndefined()
  })

  it('fills explicit histogram buckets (<= bound, last is overflow) with count, sum, min and max', async () => {
    for (const v of [0.5, 1, 3, 9]) otelRecord('test.hist', v, { kind: 'a' })
    const dp = ((await find('test.hist'))!.histogram!.dataPoints as any[])[0]
    expect(dp.explicitBounds).toEqual([1, 5])
    expect(dp.bucketCounts).toEqual(['2', '1', '1'])
    expect(dp.count).toBe('4')
    expect(dp.sum).toBeCloseTo(13.5)
    expect(dp.min).toBe(0.5)
    expect(dp.max).toBe(9)
  })

  it('reads a gauge at collect time, keeps only its declared attributes, and skips a gauge that throws', async () => {
    const g = (await find('test.gauge'))!.gauge!
    const point = (g.dataPoints as any[])[0]
    expect(point.asDouble).toBe(3)
    expect(point.attributes.map((a: any) => a.key)).toEqual(['kind'])
    expect(await find('test.broken')).toBeUndefined()
  })

  it('awaits an asynchronous gauge: its points are read, and one that rejects is skipped', async () => {
    const g = (await find('test.gauge.async'))!.gauge!
    const point = (g.dataPoints as any[])[0]
    expect(g.dataPoints).toHaveLength(1)
    expect(point.asDouble).toBe(7)
    expect(point.attributes.map((a: any) => a.key)).toEqual(['kind'])
    expect(await find('test.broken.async')).toBeUndefined()
  })
})
