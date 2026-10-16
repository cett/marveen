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

// Provider credentials in their own shape, with no "Bearer" or "token=" next to them: an Anthropic or OpenAI key
// (sk-...), a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_), a Slack token (xoxb-/xoxp-/xoxa-/xoxs-/xoxr-,
// xapp-), a JSON web token (three base64url segments, the first two starting with eyJ), an AWS access key id
// (AKIA/ASIA + 16). Applied to every scrubbed text, before the generic rules.
const KEY_SCRUBS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***'],
]

// A long run of base64-looking characters that mixes letters and digits (32 or more): a key, a signature, a blob.
// Only for log text, where such a run is never wanted; in a command (the tool input summary) a long path would
// match too. The match is the whole run (plus up to two "=" of padding) and the letter and digit conditions are
// checked on it afterwards, so one pass over the text is enough. With the two conditions as lookaheads in front of
// the run, every start position of a long run without a digit (or without a letter) scanned to the end of it:
// quadratic in the length of the run.
const BLOB_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g
const HAS_LETTER = /[A-Za-z]/
const HAS_DIGIT = /\d/

export function scrubBlobs(value: string): string {
  return value.replace(BLOB_RUN, run => (HAS_LETTER.test(run) && HAS_DIGIT.test(run) ? '***' : run))
}

// The credential and home-directory scrub, shortened last so a cut never leaves half a secret behind.
export function scrubText(value: string, maxChars: number): string {
  let out = value
  for (const [rx, replacement] of KEY_SCRUBS) out = out.replace(rx, replacement)
  for (const [rx, replacement] of SCRUBS) out = out.replace(rx, replacement)
  return out.slice(0, maxChars)
}

// The same plus the free-text shapes above, for a log message.
export function scrubLogText(value: string, maxChars: number): string {
  let out = value
  for (const [rx, replacement] of KEY_SCRUBS) out = out.replace(rx, replacement)
  for (const [rx, replacement] of SCRUBS) out = out.replace(rx, replacement)
  out = scrubBlobs(out)
  for (const [rx, replacement] of TEXT_SCRUBS) out = out.replace(rx, replacement)
  return out.slice(0, maxChars)
}
