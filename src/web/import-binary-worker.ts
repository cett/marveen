// Worker thread entry point for binary file content extraction.
// Spawned by parseBinaryInWorker() in import-crawler.ts.
// Runs in an isolated V8 heap with a capped memory limit so a malicious
// or corrupt xlsx/docx cannot OOM the main server process.
//
// Protocol:
//   input:  workerData = { filePath: string, ext: string }
//   output: postMessage({ ok: true, text: string })
//        or postMessage({ ok: false, error: string })

import { workerData, parentPort, isMainThread } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import type { CellValue, Worksheet } from 'exceljs'

// Core extraction logic is exported so tests can exercise it directly
// without spawning a real Worker (which requires a compiled dist/ file).
export async function extractBinaryContent(filePath: string, ext: string): Promise<string> {
  if (ext === 'xlsx' || ext === 'xls') {
    const ExcelJS = (await import('exceljs')).default
    const buf = readFileSync(filePath)
    const wb = new ExcelJS.Workbook()
    try {
      // exceljs's bundled types predate @types/node's generic Buffer<TArrayBuffer>;
      // tsc treats the two Buffer shapes as structurally incompatible even though
      // they are identical at runtime, so the argument is untyped here.
      await wb.xlsx.load(buf as any)
    } catch {
      // ExcelJS parses the OOXML zip container eagerly and throws on anything
      // that is not a valid xlsx (garbage bytes, a 0-byte file, or a legacy
      // binary .xls, which ExcelJS does not support).
      throw new Error('corrupt_workbook')
    }

    if (wb.worksheets.length === 0) throw new Error('empty_workbook')

    const sheets = wb.worksheets.map(sheetToCsv).join('\n')

    // Reject extracted text that is mostly control characters (binary garbage
    // that somehow parsed as a valid workbook without throwing).
    const nonPrintable = (sheets.match(/[\x00-\x08\x0E-\x1F]/g) ?? []).length
    if (nonPrintable > 0 && nonPrintable / sheets.length > 0.1) throw new Error('garbage_content')

    return sheets
  }

  // docx
  const mammoth = await import('mammoth')
  const buf = readFileSync(filePath)
  return (await mammoth.extractRawText({ buffer: buf })).value
}

// Renders a worksheet as CSV text, matching the shape SheetJS's sheet_to_csv
// produced (one line per row, comma-separated, quoted only when needed).
function sheetToCsv(ws: Worksheet): string {
  const lines: string[] = []
  ws.eachRow({ includeEmpty: false }, row => {
    const cells = (row.values as CellValue[]).slice(1)
    lines.push(cells.map(cellToCsvField).join(','))
  })
  return lines.join('\n')
}

function cellToCsvField(value: CellValue): string {
  const text = cellText(value)
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map(rt => rt.text).join('')
    if ('text' in value) return String(value.text)
    if ('result' in value) return String(value.result ?? '')
    if ('error' in value) return String(value.error)
    return ''
  }
  return String(value)
}

// Worker entry point -- only runs when this file is the worker script,
// not when imported as a module in tests or other contexts.
if (!isMainThread) {
  const { filePath, ext } = workerData as { filePath: string; ext: string }

  extractBinaryContent(filePath, ext)
    .then(text => { parentPort!.postMessage({ ok: true, text }) })
    .catch(err => { parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }) })
}
