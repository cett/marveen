// The export options both OTLP paths share (the push exporter and the GET /api/otel-export pull
// route), read from the settings registry on every call so a toggle needs no restart.

import { getEffectiveSettingValue } from './settings-store.js'
import { serviceInstanceId, type OtelExportOptions } from './otel-exporter.js'

export function readOtelExportOptions(): OtelExportOptions {
  return {
    includeInputSummary: getEffectiveSettingValue('OTEL_EXPORT_INPUT_SUMMARY') === '1',
    serviceInstanceId: serviceInstanceId(),
  }
}
