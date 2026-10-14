// Text scrubbing shared by the OTLP exporter (the opt-in tool input summary) and the application log export
// (src/otel-app-logs.ts). A module of its own with no imports, so the logger can load it without pulling in the
// database.
//
// Second scrub for the opt-in input_summary, on top of the hook's own redaction. It removes the credential
// shapes that are cheap to recognise: user:password embedded in a URL (with or without the scheme),
// curl's -u / --user, "Authorization:" / Bearer / Basic values, and password= / token= / secret= /
// api_key= assignments. It also drops the home directory (it names the machine's user). It is a
// heuristic, not a guarantee, which is why the attribute stays off by default. Shortened last, so a cut
// never leaves half a secret behind.
const SCRUBS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\b[^\s/@:]+:[^\s/@]+@/g, '***@'],
  [/(\s(?:-u|--user)(?:\s+|=))\S+/g, '$1***'],
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?\S+/gi, '$1***'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\b((?:pass(?:word|wd)?|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)\S+/gi, '$1***'],
  [/(--?(?:pass(?:word|wd)?|token|secret|api[_-]?key)\s+)\S+/gi, '$1***'],
  [/\/(?:Users|home)\/[^/\s]+/g, '/~'],
]

// Extra shapes for free text (a log message, unlike a command, can carry a mailbox, a path or an id).
const TEXT_SCRUBS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?:\/[\w.@~+-]+){3,}/g, '[path]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/\b[0-9a-f]{16,}\b/gi, '[id]'],
]

// The credential and home-directory scrub, shortened last so a cut never leaves half a secret behind.
export function scrubText(value: string, maxChars: number): string {
  let out = value
  for (const [rx, replacement] of SCRUBS) out = out.replace(rx, replacement)
  return out.slice(0, maxChars)
}

// The same plus the free-text shapes above, for a log message.
export function scrubLogText(value: string, maxChars: number): string {
  let out = value
  for (const [rx, replacement] of SCRUBS) out = out.replace(rx, replacement)
  for (const [rx, replacement] of TEXT_SCRUBS) out = out.replace(rx, replacement)
  return out.slice(0, maxChars)
}

