// What the Bash read gate (secret-read-gate.py, which guards the claim signing key) says about running the headers
// helper, next to the vault paths an agent can already use. The helper hands the agent a token the same way
// scripts/vault-resolve.mjs does, so it must fall in the SAME access class: this test compares verdicts instead of
// pinning allow or deny, so a future gate that starts covering vault reads changes all three together, and a
// helper that is judged differently from the existing vault paths is caught.
//
// Privacy: neutral fixtures only.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const GATE = fileURLToPath(new URL('../../scripts/hooks/secret-read-gate.py', import.meta.url))

function verdict(command: string): number {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmpdir() })
  const r = spawnSync('python3', ['-I', GATE], { input: payload, encoding: 'utf-8', timeout: 30_000 })
  return r.status ?? -1
}

const HELPER = "env -i HOME='/fixture/home' PATH='/usr/bin:/bin' '/fixture/bin/node' '/fixture/repo/scripts/vault-http-header-helper.mjs' --secret 'fixture-secret-a' --header 'Authorization' --prefix 'Bearer '"
const HELPER_PLAIN = 'node scripts/vault-http-header-helper.mjs --secret fixture-secret-a --header Authorization'
const RESOLVE = "printf 'FIXTURE_VAR=fixture-secret-a\\n' | node scripts/vault-resolve.mjs"
const SIGNING_KEY = 'cat store/.claim-signing-key'

describe('the headers helper is in the same access class as the existing vault paths', () => {
  it('the helper command line gets the same verdict as running vault-resolve', () => {
    expect(verdict(HELPER)).toBe(verdict(RESOLVE))
    expect(verdict(HELPER_PLAIN)).toBe(verdict(RESOLVE))
  })

  it('the gate itself is alive: it still refuses the claim signing key in the same harness', () => {
    // Without this the comparison above could be two broken-gate verdicts that happen to agree.
    expect(verdict(SIGNING_KEY)).toBe(2)
  })

  it('the helper command line does not name the signing key, so the gate has nothing to trip on by accident', () => {
    expect(HELPER).not.toMatch(/claim-signing|\.claim/)
  })
})
