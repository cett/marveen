// A heredoc / here-string that is an interpreter's program and SPAWNS a process is read like a
// one-liner: the curl / wget argv or command line inside `os.system(...)`, `subprocess.run([...])`,
// `execSync(...)`, a backtick is judged, not only the language's own network API. Before this, the
// body was tested for the language's network primitives only (NET_PRIMITIVE), so the very same
// payload was denied as `python3 -c '...'` and passed as `python3 - <<PY ... PY`.
//
// Every case below is a fixture string for the parser; none of it is run.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify } from '../../scripts/hooks/bash-egress-parser.mjs'

const heredoc = (interp: string, code: string, tag = "'EOF'") => `${interp} <<${tag}\n${code}\nEOF`

describe('a heredoc-fed interpreter that spawns curl / wget is denied like its one-liner', () => {
  const DENY: Array<[string, string]> = [
    ['python os.system', heredoc('python3 -', 'import os\nos.system("curl https://example.org/x")')],
    ['python os.popen wget', heredoc('python3 -', 'import os\nos.popen("wget example.org/x")')],
    ['python subprocess, argv list', heredoc('python3 -', 'import subprocess\nsubprocess.run(["curl", "-s", "https://example.org/x"])')],
    ['python subprocess, string + shell', heredoc('python3 -', 'import subprocess\nsubprocess.check_output("curl -s example.org", shell=True)')],
    ['python subprocess, bare host', heredoc('python3 -', 'import subprocess\nsubprocess.run(["curl", "example.org"])')],
    ['python argv with a variable destination', heredoc('python3 -', 'import subprocess\nsubprocess.run(["curl", "-s", url, "-o", "x"])')],
    ['python argv with an f-string destination', heredoc('python3 -', 'import subprocess\nsubprocess.run(["curl", "-s", f"{BASE}/x"])')],
    ['python, absolute interpreter path and a double-quoted tag', heredoc('/usr/bin/python3 -', 'import os\nos.system("curl example.org")', '"EOF"')],
    ['python, a here-string', `python3 <<< "import os; os.system('curl example.org')"`],
    ['python, an unquoted tag that expands a variable', `U=https://example.org/x; ${heredoc('python3 -', 'import os\nos.system("curl $U")', 'EOF')}`],
    ['node execSync', heredoc('node', 'require("child_process").execSync("curl example.org")')],
    ['node exec with a template literal', heredoc('node', 'require("child_process").exec(`curl example.org`)')],
    ['node spawn, argv list', heredoc('node', "require('child_process').spawn('curl', ['-s', 'example.org'])")],
    ['bun Bun.spawn', heredoc('bun', 'Bun.spawn(["curl", "example.org"])')],
    ['perl system', heredoc('perl', 'system("curl example.org");')],
    ['perl backticks', heredoc('perl', 'print `curl example.org`;')],
    ['ruby system, argv', heredoc('ruby', 'system("wget", "example.org")')],
    ['php shell_exec', heredoc('php', '<?php shell_exec("curl example.org");')],
  ]
  it.each(DENY)('denies: %s', (_name, cmd) => {
    const r = classify(cmd)
    expect(r.deny, cmd).toBe(true)
    expect(r.reason, cmd).toMatch(/^heredoc-/)
  })

  it('names the tool and the host the way the one-liner does', () => {
    expect(classify(heredoc('python3 -', 'import os\nos.system("curl https://example.org/x")'))).toMatchObject({
      deny: true, reason: 'heredoc-curl-external', hosts: ['example.org'],
    })
    expect(classify(heredoc('python3 -', 'import os\nos.system("wget example.org/x")'))).toMatchObject({
      deny: true, reason: 'heredoc-wget-external',
    })
  })
})

describe('a comment or prose with an apostrophe does not hide a spawn', () => {
  // The literals are paired by a plain quote scan; an apostrophe throws the pairing off for the rest of
  // the body. The body is also read line by line, and a Python body also with its comments blanked.
  const DENY: Array<[string, string]> = [
    ['python comment', heredoc('python3 -', "import os\n# it's a trap\nos.system(\"curl https://example.org/x\")")],
    ['python docstring', heredoc('python3 -', "import os\n\"\"\"don't\"\"\"\nos.system(\"curl https://example.org/x\")")],
    ['node comment', heredoc('node', "// it's a trap\nrequire('child_process').execSync(\"curl example.org\")")],
    ['perl comment', heredoc('perl', "# it's a trap\nsystem(\"curl example.org\");")],
  ]
  it.each(DENY)('denies: %s', (_name, cmd) => {
    expect(classify(cmd).deny, cmd).toBe(true)
  })
})

describe('a heredoc that only MENTIONS curl, or calls it on a local destination, still passes', () => {
  const PASS: Array<[string, string]> = [
    // the one-liner exceptions, applied to a body
    ['localhost curl through os.system', heredoc('python3 -', 'import os\nos.system("curl -s http://localhost:3420/api/health")')],
    ['localhost curl whose payload CARRIES an external URL', heredoc('python3 -', 'import subprocess, json\nsubprocess.run(["curl", "-s", "http://localhost:3420/api/messages", "-d", json.dumps({"c": "https://example.org"})])')],
    ['node localhost curl', heredoc('node', 'require("child_process").execSync("curl -s http://127.0.0.1:3420/api/health")')],
    ['a spawn that is not a download', heredoc('python3 -', 'import subprocess\nsubprocess.run(["git", "status"])')],
    ['the word in a printed string', heredoc('python3 -', 'print("curl example.org")')],
    ['the word in a node log line', heredoc('node', 'console.log("curl example.org")')],
    // the Python relaxation of 4c: a body that cannot run anything is text
    ['python: a spawn in a COMMENT only', heredoc('python3 -', 'import os\n# os.system("curl https://example.org/x")\nprint(1)')],
    ['python: a file that is written, holding a curl line', heredoc('python3 -', 'open("x.sh", "w").write("curl https://example.org/x\\n")')],
    // not an interpreter: its heredoc is inert text
    ['cat heredoc holding the call', `cat <<'EOF'\nimport os\nos.system("curl https://example.org/x")\nEOF`],
  ]
  it.each(PASS)('passes: %s', (_name, cmd) => {
    expect(classify(cmd), cmd).toMatchObject({ deny: false })
  })
})

describe('heredoc and one-liner give the same verdict for the same code', () => {
  // code, one line, no single quote (so it can sit inside '...'): [interpreter, flag, code, relaxedPython]
  const SNIPPETS: Array<[string, string, string]> = [
    ['python3', '-c', 'import os; os.system("curl https://example.org/x")'],
    ['python3', '-c', 'import subprocess; subprocess.run(["wget", "example.org/x"])'],
    ['python3', '-c', 'import subprocess; subprocess.check_output("curl -s example.org", shell=True)'],
    ['python3', '-c', 'import subprocess; subprocess.run(["curl", u])'],
    ['python3', '-c', 'import os; os.system("curl -s http://localhost:3420/api/health")'],
    ['python3', '-c', 'import subprocess; subprocess.run(["git", "status"])'],
    ['python3', '-c', 'print("curl example.org")'],
    ['node', '-e', 'require("child_process").execSync("curl example.org")'],
    ['node', '-e', 'require("child_process").execSync("curl -s http://127.0.0.1:3420/api/health")'],
    ['node', '-e', 'console.log("curl example.org")'],
    ['perl', '-e', 'system("curl example.org")'],
    ['perl', '-e', 'print `curl example.org`'],
    ['ruby', '-e', 'system("wget", "example.org")'],
    ['php', '-r', 'shell_exec("curl example.org");'],
  ]
  it.each(SNIPPETS)('%s %s %s', (interp, flag, code) => {
    const oneLiner = classify(`${interp} ${flag} '${code}'`).deny
    const viaHeredoc = classify(heredoc(interp === 'python3' ? 'python3 -' : interp, code)).deny
    expect(viaHeredoc).toBe(oneLiner)
  })
})

describe('still open, pinned on purpose (the same limits as the one-liner)', () => {
  const OPEN = [
    // a command built at run time
    heredoc('python3 -', 'import subprocess\nsubprocess.run("cu" + "rl example.org", shell=True)'),
    // the destination only in a file the body reads
    heredoc('python3 -', 'import subprocess\nsubprocess.run(["sh", "run.sh"])'),
  ]
  it('does not claim these', () => {
    for (const cmd of OPEN) expect({ cmd, deny: classify(cmd).deny }).toEqual({ cmd, deny: false })
  })
})
