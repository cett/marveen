#!/usr/bin/env python3
"""destructive-gate.py -- PreToolUse gate for genuinely irreversible operations.

Adapted from upstream Szotasz/marveen PR #1357 (scaffold decision D1: a new,
separate file mirroring upstream's own structure, NOT merged into
post-tool-injection-gate.py -- that hook scans tool OUTPUT for injection
markers; this one scans tool INPUT before it runs, for a short, deliberately
narrow list of operations no agent should decide on its own).

WHY IT'S A SEPARATE GATE FROM settings.json's deny list: a deny list is
disabled entirely under `--dangerously-skip-permissions`, which several fleet
agents run under for day-to-day work (the fleet moved to permissive mode
because an allowlist can never be complete, and false permission-prompts on
trivial commands were costing more than they protected). A HOOK runs
regardless of permission mode. So what is genuinely non-negotiable belongs
here, not on the deny list -- the deny list is decoration in permissive mode,
this hook is not.

CONTEXT-SENSITIVE SCANNING (ported from upstream's own measured fix): a naive
full-text pattern match on the raw command string measured 28.4% false
positives among upstream's blocks (heredoc bodies, quoted string literals,
and shell comments containing a banned word without ever executing it) --
three of those false positives hit upstream's own measurement work while
documenting the problem. The fix here is NOT to relax the rules (a "warn
instead of block" direction was explicitly rejected upstream), only to
change WHERE the scanner looks:
  1. shell/code comment lines never run -> excluded from the scan;
  2. a heredoc body written to a FILE (`cat > f <<EOF`) never runs -> excluded;
  3. a heredoc body handed to an INTERPRETER (`python3 - <<PY`) DOES run ->
     stays in scope (two real credential-file reads in upstream's own corpus
     lived in exactly this shape; a naive "skip all heredocs" rule would have
     let both through);
  4. a quoted string containing whitespace is prose/data (a message body, a
     JSON payload, a regex, a test case), not a path -> excluded. A quoted
     string WITHOUT whitespace can still be a path -> stays in scope;
  5. segment-splitting and command-name detection are quote-aware, so a `|`
     or `;` inside a quoted grep pattern never opens a fake new segment.

KNOWN, ACCEPTED LIMIT: a path containing a space inside quotes is not caught
by the Bash branch (the file-tool branch -- Read/Edit/Write/NotebookEdit --
has none of this ambiguity and catches it directly).

Wrapper-transparency (xargs, timeout, bash -c, find -exec, ...) is included:
a banned command passed as an ARGUMENT to a wrapper is still a banned
command. This only follows one level of nesting deep by design -- it guards
against accidental wrapping, not a determined attempt to hide a command
behind several layers of quoting.

Contract: exit 0 = allow (silent), exit 2 = block (stderr surfaced to the
model). Fail-closed on the gate's OWN failure too (an exception here blocks,
it does not silently pass through) -- the one failure mode a gate must never
have is becoming permissive when broken.

NOT wired into any settings.json PreToolUse array by this change -- see the
adaptation note in the commit/PR description for why registering a NEW,
UNTESTED-IN-PRODUCTION blocking gate fleet-wide is a policy call for the
coordinator/owner, not something to flip on silently as a side effect of
porting the file.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# Commands no agent decides on its own -- each destroys data or state
# irreversibly, not a style preference.
BANNED_CMDS = {'rm', 'mv', 'shred', 'sudo', 'mkfs', 'dd'}
# Path prefixes that hold credential material.
PROTECTED_RE = re.compile(r'/\.(ssh|aws|gnupg|gmail-mcp)(?=/|\s|$|["\'])')
ENV_RE = re.compile(r'(?:^|[\s=:])(?:[^\s"\']*/)?\.env(?=$|[\s"\'`,;)\]}])')

# Commands whose heredoc body is EXECUTED, not written to a file. Only these
# keep their heredoc body in the scanned text.
INTERPRETERS = {'python', 'python3', 'bash', 'sh', 'zsh', 'node', 'perl', 'ruby', 'php'}
SCRIPT_FLAGS = {'-c', '-e', '--command', '--eval'}

DELIMS = ('&&', '||', '$(', ';', '|', '\n', '`')


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    port = os.environ.get('WEB_PORT')
    if not port:
        try:
            with open(os.path.join(_project_root(), '.env')) as f:
                for line in f:
                    if line.startswith('WEB_PORT='):
                        port = line.split('=', 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or '3420'


def _dashboard_token():
    try:
        with open(os.path.join(_project_root(), 'store', '.dashboard-token')) as f:
            return f.read().strip()
    except OSError:
        return ''


def _post(base_url, token, endpoint, payload):
    """Best-effort POST -- never raises, never affects the verdict."""
    if not token:
        return
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'{base_url}{endpoint}',
                data=json.dumps(payload).encode(),
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
                method='POST',
            ),
            timeout=3,
        )
    except Exception:
        pass


def _notify_block(agent_id, tool_name, reason):
    token = _dashboard_token()
    base_url = f'http://localhost:{_web_port()}/api'
    _post(base_url, token, '/hook-audit', {
        'agent_id': agent_id,
        'hook_type': 'PreToolUse',
        'verdict': 'deny',
        'tool_name': tool_name,
        'reason': reason,
    })


def block(msg, agent_id=None, tool_name=''):
    try:
        _notify_block(agent_id, tool_name, hashlib.sha256(msg.encode('utf-8', errors='replace')).hexdigest()[:16])
    except Exception:
        pass  # notification failure never changes the verdict
    sys.stderr.write(
        'DESTRUKTIV-KAPU: BLOKKOLVA.\n' + msg +
        '\n\nEz nem jogosultsagi hiba, es nem is kell hozza jovahagyast kerned: '
        'ez a fejlesztesi koordinator dontese volt. Ha tenyleg szukseges, ird meg '
        'NEKI, hogy MIT es MIERT akarsz, es o elvegzi vagy engedelyezi.\n'
    )
    sys.exit(2)


def _quote_map(text):
    """For each character: inside a quote or not (0=no, 1=single, 2=double).

    Tolerant of an unbalanced quote -- never raises, just flips state.
    """
    state = [0] * len(text)
    q = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and q != 1 and i + 1 < len(text):
            state[i] = q
            state[i + 1] = q
            i += 2
            continue
        if q == 0 and ch in ("'", '"'):
            q = 1 if ch == "'" else 2
            state[i] = 0
            i += 1
            continue
        if (q == 1 and ch == "'") or (q == 2 and ch == '"'):
            state[i] = 0
            q = 0
            i += 1
            continue
        state[i] = q
        i += 1
    return state


def _blank_ranges(text, ranges):
    """Blank the given ranges to spaces, preserving newlines so offsets stay
    stable (which also keeps error messages readable)."""
    if not ranges:
        return text
    out = list(text)
    for a, b in ranges:
        for i in range(max(0, a), min(len(out), b)):
            if out[i] != '\n':
                out[i] = ' '
    return ''.join(out)


def _heredoc_body_ranges(cmd):
    """(data-body ranges, interpreter-body ranges).

    The difference is whether the opening line's command EXECUTES the body:
      cat > file <<EOF   -> data      (goes to a file, nothing runs it)
      python3 - <<PY     -> code      (python runs it)
    """
    lines = cmd.split('\n')
    offs, pos = [], 0
    for ln in lines:
        offs.append(pos)
        pos += len(ln) + 1
    data, code = [], []
    i = 0
    while i < len(lines):
        m = re.search(r'<<-?\s*([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\1', lines[i])
        if m:
            delim = m.group(2)
            words = [w for w in re.split(r'[\s|;&]+', lines[i]) if w]
            is_code = any(os.path.basename(w.strip('"\'')) in INTERPRETERS for w in words)
            j = i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            if j > i:
                a = offs[i] + len(lines[i]) + 1
                b = offs[j] if j < len(lines) else len(cmd)
                (code if is_code else data).append((a, b))
            i = j
        i += 1
    return data, code


def _comment_ranges(text):
    """Lines whose first non-whitespace character is `#` -- a comment in
    shell and in embedded Python/Ruby alike, so it never executes. A
    trailing end-of-line comment is deliberately NOT stripped -- the `#`
    there can be inside a quote."""
    out, pos = [], 0
    for ln in text.split('\n'):
        if ln.lstrip().startswith('#'):
            out.append((pos, pos + len(ln)))
        pos += len(ln) + 1
    return out


def _prose_quote_ranges(text, keep_ranges, code_ranges=()):
    """Ranges of quoted text that contains whitespace -- prose or data (a
    message body, a JSON payload, a regex, a test case), not a path.

    A quoted string WITHOUT whitespace can still be a path, so it stays.
    `keep_ranges` is the interpreter's own script argument: its content
    RUNS, it is not prose.
    """
    state = _quote_map(text)
    out = []
    i = 0
    while i < len(text):
        if state[i]:
            j = i
            while j < len(text) and state[j] == state[i]:
                j += 1
            span = text[i:j]
            inside_keep = any(a <= i < b for a, b in keep_ranges)
            # Command substitution inside a quote EXECUTES -- the shell steps
            # back into command context there. Never treated as prose, or a
            # PORT="$(sed ...)" shape would lose a real block. The exception
            # only applies in shell context: inside an interpreter heredoc
            # body, a backtick or $( is just a character in Python/Node text.
            in_code_body = any(a <= i < b for a, b in code_ranges)
            runs_code = (not in_code_body) and ('$(' in span or chr(96) in span)
            if not inside_keep and not runs_code and re.search(r'\s', span):
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def _script_arg_ranges(text):
    """Ranges of a quoted script passed to an interpreter via -c/-e: this is
    RUNNING CODE."""
    out = []
    state = _quote_map(text)
    for m in re.finditer(r'(?<![\w-])(python3?|bash|sh|zsh|node|perl|ruby|php)\s+(-\w|--\w+)', text):
        if m.group(2) not in SCRIPT_FLAGS:
            continue
        k = m.end()
        while k < len(text) and text[k] in ' \t':
            k += 1
        if k < len(text) and text[k] in ('"', "'"):
            k += 1
            j = k
            while j < len(text) and state[j]:
                j += 1
            out.append((k, j))
    return out


def scannable(cmd):
    """The part of the command that ACTUALLY runs. See the module header."""
    data, code = _heredoc_body_ranges(cmd)
    text = _blank_ranges(cmd, data)
    text = _blank_ranges(text, _comment_ranges(text))
    keep = _script_arg_ranges(text)
    text = _blank_ranges(text, _prose_quote_ranges(text, keep, code))
    return text


def segments(text):
    """Logical segments (&&, ||, ;, |, newline, $(, backtick) -- quote-aware.

    A naive split lets a '|' inside a quoted grep pattern open a fake new
    segment, making the pattern's next word look like a command name.
    """
    state = _quote_map(text)
    parts, start, i = [], 0, 0
    while i < len(text):
        if state[i]:
            i += 1
            continue
        hit = next((d for d in DELIMS if text.startswith(d, i)), None)
        if hit:
            parts.append(text[start:i])
            i += len(hit)
            start = i
            continue
        i += 1
    parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]


def _tokens(seg):
    """Quote-aware word splitting. Items: (text without quotes, had a
    whitespace inside a quote)."""
    state = _quote_map(seg)
    toks, cur, had_space, i = [], [], False, 0
    while i < len(seg):
        ch = seg[i]
        if not state[i] and ch in ' \t':
            if cur:
                toks.append((''.join(cur), had_space))
                cur, had_space = [], False
            i += 1
            continue
        if not state[i] and ch in ('"', "'"):
            i += 1
            continue
        if state[i] and ch in ' \t':
            had_space = True
        cur.append(ch)
        i += 1
    if cur:
        toks.append((''.join(cur), had_space))
    return toks


# --- Wrapper commands ---------------------------------------------------
# The gate looks at the FIRST word of a segment as the command name. Without
# this, any wrapper that takes a command as an ARGUMENT would carry a banned
# command past it: `ls /tmp | xargs rm`, `find . -exec rm {} ;`,
# `timeout 5 rm /tmp/x`, `bash -c "rm ..."`.
#
# The LIMIT that must be stated: nested-script inspection only goes ONE
# level deep -- the token extraction does not unwind backslash-escaped
# quoting recursively:
#     bash -c "rm -rf /tmp/x"              -> BLOCKED
#     bash -c "bash -c \"rm -rf /tmp/x\""  -> PASSES
# This guards against accidental wrapping, not a determined bypass -- which
# fits the gate's purpose (governing cooperating agents), but nobody should
# assume it's complete. Also still open: `ssh host rm ...` -- that runs on a
# remote machine and would need its own rule, not wrapper detection.
_TRANSPARENT = ('exec', 'command', 'time', 'nohup', 'env')
_PREFIX_WRAPPERS = ('xargs', 'timeout', 'nice', 'ionice', 'stdbuf', 'watch', 'parallel',
                    'flock', 'chroot', 'setsid', 'unbuffer')
_FIND_EXEC = ('-exec', '-execdir', '-ok', '-okdir')
_SHELLS = ('sh', 'bash', 'zsh', 'dash', 'ksh')
# Flags that take their value as a SEPARATE word (xargs -I {} / -n 1 / -P 4).
_VALUE_FLAGS = ('-I', '-i', '-n', '-P', '-L', '-s', '-d', '-E', '-a',
                '--max-args', '--max-procs', '--delimiter', '--replace', '--arg-file')
_NUMERIC = re.compile(r'^[0-9]+(\.[0-9]+)?[smhd]?$')
# Explicit depth limit alongside the loop guard (sub != cmd): so a future
# change can never recurse without bound. Exceeding it BLOCKS, it does not
# pass through -- what the gate cannot follow, it does not allow.
_MAX_NEST = 8


def _bare_tokens(seg):
    return [(t, sp) for t, sp in _tokens(seg.replace('(', ' ')) if t]


def _after_wrapper(toks, i):
    """Index of the first command-name candidate after the wrapper (past
    its flags and any leading number)."""
    j = i + 1
    while j < len(toks):
        t = toks[j][0]
        if t.startswith('-'):
            j += 2 if t in _VALUE_FLAGS else 1
            continue
        if _NUMERIC.match(t):  # timeout 5 CMD, nice 10 CMD
            j += 1
            continue
        return j
    return None


def command_index(toks):
    """Index of the segment's ACTUAL command name, seeing through wrappers.

    Environment assignments (FOO=bar), transparent prefixes (exec, env, ...)
    and wrappers (xargs, timeout, ...) are skipped. None if there is no
    command name.
    """
    i = 0
    for _ in range(12):  # bounded chain length -- never loop forever
        while i < len(toks) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[i][0]):
            i += 1
        if i >= len(toks):
            return None
        base = os.path.basename(toks[i][0])
        if base in _TRANSPARENT:
            i += 1
            continue
        if base in _PREFIX_WRAPPERS:
            nxt = _after_wrapper(toks, i)
            if nxt is None:
                return None
            i = nxt
            continue
        return i
    return None


def _sub_scripts(toks, idx):
    """The segment's shell command's -c script(s)."""
    if idx is None or os.path.basename(toks[idx][0]) not in _SHELLS:
        return []
    for k in range(idx + 1, len(toks)):
        if toks[k][0] in ('-c', '--command') and k + 1 < len(toks):
            return [toks[k + 1][0]]
    return []


def _is_coordinator_tmux_session():
    """True only when THIS process is running inside the main agent's own
    channels tmux session (e.g. "jarvis-channels"), never a sub-agent's
    ("agent-<name>"). Deliberately NOT cwd-based: agent_id_from_cwd() falls
    back to the last path component for any cwd outside <install> and
    <install>/agents/<id> (e.g. a shared worktree under ~/worktrees/, which
    the coordinator AND sub-agents both operate in for delegated dev work),
    so cwd cannot tell the two apart there. The tmux session name is set once
    at process launch and is invariant to `cd`, including into a worktree.
    Fails closed (False) on any error -- no positive proof, no exemption.
    """
    try:
        out = subprocess.run(
            ['tmux', 'display-message', '-p', '#S'],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode != 0:
            return False
        return out.stdout.strip() == '%s-channels' % ledger_lib.main_agent_id()
    except Exception:
        return False


def check_bash(cmd, agent_id=None, _depth=0):
    text = scannable(cmd)
    for seg in segments(text):
        toks = _bare_tokens(seg)
        idx = command_index(toks)

        names = []
        # A quoted word containing whitespace is not a command name, it's a
        # string (a test-case list, a message body, a regex pattern).
        if idx is not None and not toks[idx][1]:
            nxt = toks[idx + 1][0] if idx + 1 < len(toks) and not toks[idx + 1][1] else None
            names.append((toks[idx][0], nxt))
        for j, (t, _sp) in enumerate(toks):
            if t in _FIND_EXEC and j + 1 < len(toks) and not toks[j + 1][1]:
                names.append((toks[j + 1][0], None))

        for name, second in names:
            base = os.path.basename(name)
            if base in BANNED_CMDS:
                block('A tiltott parancs: "%s" (a teljes szegmens: %s)' % (base, seg[:160]),
                      agent_id, 'Bash')
            if base == 'git' and second == 'push' and not _is_coordinator_tmux_session():
                block('git push: a kozos repoba valo iras kifele mutato, visszafordithatatlan '
                      'muvelet. Commitolni szabad, pusholni nem.', agent_id, 'Bash')

        for sub in _sub_scripts(toks, idx):
            if not sub or sub == cmd:
                continue
            if _depth >= _MAX_NEST:
                block('Tul melyen agyazott parancs (%d szint): a kapu nem tudja '
                      'vegigkovetni, ezert nem engedi at.' % _depth, agent_id, 'Bash')
            check_bash(sub, agent_id, _depth + 1)

    m = PROTECTED_RE.search(text)
    if m:
        block('Hitelesito adatokat tartalmazo konyvtar: .%s' % m.group(1), agent_id, 'Bash')
    if ENV_RE.search(text):
        block('.env fajl: hitelesito adatokat tartalmaz.', agent_id, 'Bash')


def check_read(path, agent_id=None, tool_name=''):
    m = PROTECTED_RE.search(path if path.endswith('/') else path + '/')
    if m:
        block('Hitelesito adatokat tartalmazo konyvtar: .%s' % m.group(1), agent_id, tool_name)
    if os.path.basename(path) == '.env':
        block('.env fajl: hitelesito adatokat tartalmaz.', agent_id, tool_name)


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        sys.stderr.write('DESTRUKTIV-KAPU: a bemenet nem olvashato, ezert BLOKKOL.\n')
        sys.exit(2)
    tool = ev.get('tool_name') or ''
    inp = ev.get('tool_input') or {}
    cwd = ev.get('cwd') or ''
    try:
        agent_id = ledger_lib.agent_id_from_cwd(cwd)
    except Exception:
        agent_id = None
    # Fail-closed on the gate's OWN failure too. block() exits via SystemExit,
    # which "except Exception" does not catch, so a real block still goes
    # through. Every OTHER exception (a future edit's typo, a regex bug) must
    # not silently pass the operation -- a broken gate must never become a
    # permissive one.
    try:
        if tool == 'Bash':
            check_bash(str(inp.get('command') or ''), agent_id)
        elif tool in ('Read', 'Edit', 'Write', 'NotebookEdit'):
            check_read(str(inp.get('file_path') or ''), agent_id, tool)
    except Exception as exc:
        sys.stderr.write('DESTRUKTIV-KAPU: a kapu maga hibara futott (%s: %s), ezert '
                          'BLOKKOL. Ez a kapu hibaja, nem a tied.\n' % (type(exc).__name__, exc))
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
