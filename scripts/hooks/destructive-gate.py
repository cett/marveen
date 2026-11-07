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
import bisect
import functools
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import agent_token  # noqa: E402
import shell_subst  # noqa: E402

# Commands no agent decides on its own -- each destroys data or state
# irreversibly, not a style preference.
BANNED_CMDS = {'rm', 'mv', 'shred', 'sudo', 'mkfs', 'dd'}
# Path prefixes that hold credential material.
PROTECTED_RE = re.compile(r'/\.(ssh|aws|gnupg|gmail-mcp)(?=/|\s|$|["\'])')
# A `.env` file name: `.env` at the start of a word or after `=`/`:`, or at the end of a path
# (`/x/y/.env`), followed by the end of the text, whitespace or a closing character. The
# regex this replaces, `(?:^|[\s=:])(?:[^\s"\']*/)?\.env(?=$|[\s"\'`,;)\]}])`, was
# QUADRATIC (`a=a=a=...`: every `=` starts a scan to the end of the word and backs off for
# the `/`): 250 KB of it ran longer than a minute, far past the 10 s hook timeout. The pass
# below is one scan of the text with the same verdicts (the tests compare both on random text).
_ENV_AFTER = set(' \t\n\r\f\v"\'`,;)]}')


def _env_file_mentioned(text):
    n = len(text)
    run_begin = 0      # start of the current run of non-space, non-quote characters
    sep_seen = False   # a `=` or `:` inside the current run
    i = 0
    while i < n:
        ch = text[i]
        if ch.isspace() or ch in '"\'':
            run_begin = i + 1
            sep_seen = False
            i += 1
            continue
        if ch == '.' and text.startswith('.env', i) and (i + 4 >= n or text[i + 4] in _ENV_AFTER
                                                           or text[i + 4].isspace()):
            if i == 0:
                return True
            prev = text[i - 1]
            if prev.isspace() or prev in '=:':
                return True
            if prev == '/' and (run_begin == 0 or text[run_begin - 1].isspace() or sep_seen):
                return True
        if ch in '=:':
            sep_seen = True
        i += 1
    return False

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


def _post(base_url, auth, endpoint, payload):
    """Best-effort POST -- never raises, never affects the verdict. A missing token only means the
    audit row is not written: it never changes what the gate decides."""
    if not auth.token:
        return
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'{base_url}{endpoint}',
                data=json.dumps(payload).encode(),
                headers=auth.headers({'Content-Type': 'application/json'}),
                method='POST',
            ),
            timeout=3,
        )
    except Exception:
        pass


# The session of the event being judged, set by main() once the event is parsed and read by _notify_block: block() is
# called from a dozen helpers that have no event, and threading the id through each of them would touch every call.
_EVENT = {'session_id': None}


def _notify_block(agent_id, tool_name, reason):
    auth = agent_token.resolve(agent_id=agent_id, store_dir=os.path.join(_project_root(), 'store'))
    base_url = f'http://localhost:{_web_port()}/api'
    _post(base_url, auth, '/hook-audit', {
        'agent_id': agent_id,
        'hook_type': 'PreToolUse',
        'verdict': 'deny',
        'tool_name': tool_name,
        'reason': reason,
        # The raw session id as the trace of the row (the server drops anything that is not a plain id).
        'trace_id': _EVENT['session_id'] if isinstance(_EVENT['session_id'], str) else None,
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


@functools.lru_cache(maxsize=4)
def _quote_map(text):
    """For each character: inside a quote or not (0=no, 1=single, 2=double).

    Tolerant of an unbalanced quote -- never raises, just flips state. Cached (the last few texts): every
    reading of one command asks for the same map, and the result is only ever READ.
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


_HEREDOC_OPEN = re.compile(r'<<-?[ \t]*([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\1')


def _heredoc_body_ranges(cmd):
    """(data-body ranges, interpreter-body ranges).

    The difference is whether the opening line's command EXECUTES the body:
      cat > file <<EOF   -> data      (goes to a file, nothing runs it)
      python3 - <<PY     -> code      (python runs it)

    A heredoc opener is a `<<` the SHELL reads as one: outside quotes and comments, not part of a `<<<`
    here-string, not inside `$(( ))` arithmetic. The scan walks the whole command once with the quote state
    carried across lines, so text that only LOOKS like an opener (`cat <<< x`, `echo "a <<EOF b"`,
    `ls # see <<EOF`) cannot open a phantom heredoc whose body would swallow the destructive command on
    the next lines. Missing a real opener is the safe error (its body is scanned as commands: a possible
    false alarm); reading a phantom one is not (a command is blanked as data). `$(cat <<'EOF'` inside double
    quotes IS an opener (a command substitution runs), so a commit-message heredoc keeps working.
    KNOWN LIMIT (older than this scan): a `<<` the shell does not read as a heredoc but this scan does still
    opens one: `(( a = 1<<b ))`, `$[1<<b]`, `${x//<<EOF/y}`, `[[ a == b<<EOF ]]`, an ANSI-C quote `$'a\\'b <<EOF'`;
    a destructive command on the NEXT line is then read as heredoc data. `$(( ))` is handled.
    The body starts after the newline that ends the opener's command line, and ends at the first line that,
    stripped, equals the delimiter; without such a line it runs to the end of the command."""
    n = len(cmd)
    data, code = [], []
    # contexts: [kind, depth]; 'c' command (the top level, or a `$(` body), 'd' double quote,
    # 's' single quote, 'a' arithmetic `$(( ))`. depth counts plain parentheses in 'c' / 'a'.
    stack = [['c', 0]]
    pending = []  # (delimiter, offset of the `<<`) of the openers on the command line being read
    i = 0
    while i < n:
        ch = cmd[i]
        kind = stack[-1][0]
        if kind == 's':
            if ch == "'":
                stack.pop()
            i += 1
            continue
        if kind == 'd':
            if ch == '\\':
                i += 2
            elif ch == '"':
                stack.pop()
                i += 1
            elif ch == '$' and cmd.startswith('$((', i):
                stack.append(['a', 0])
                i += 3
            elif ch == '$' and cmd.startswith('$(', i):
                stack.append(['c', 0])
                i += 2
            else:
                i += 1
            continue
        if kind == 'a':
            if ch == '(':
                stack[-1][1] += 1
            elif ch == ')':
                if stack[-1][1] > 0:
                    stack[-1][1] -= 1
                else:
                    stack.pop()
                    if cmd.startswith('))', i):
                        i += 1
            i += 1
            continue
        # kind == 'c'
        if ch == '\\':
            i += 2
        elif ch == "'":
            stack.append(['s', 0])
            i += 1
        elif ch == '"':
            stack.append(['d', 0])
            i += 1
        elif ch == '#' and (i == 0 or cmd[i - 1] in ' \t\n;|&()'):
            nl = cmd.find('\n', i)
            i = n if nl == -1 else nl  # the newline itself is still read below
        elif ch == '$' and cmd.startswith('$((', i):
            stack.append(['a', 0])
            i += 3
        elif ch == '$' and cmd.startswith('$(', i):
            stack.append(['c', 0])
            i += 2
        elif ch == '(':
            stack[-1][1] += 1
            i += 1
        elif ch == ')':
            if stack[-1][1] > 0:
                stack[-1][1] -= 1
            elif len(stack) > 1:
                stack.pop()
            i += 1
        elif ch == '<' and cmd.startswith('<<<', i):
            i += 3
        elif ch == '<' and cmd.startswith('<<', i):
            m = _HEREDOC_OPEN.match(cmd, i)
            if m:
                pending.append((m.group(2), i))
                i = m.end()
            else:
                i += 2
        elif ch == '\n' and pending:
            # the command line is over: the bodies of its openers follow, one after the other
            line_start = cmd.rfind('\n', 0, pending[0][1]) + 1
            words = [w for w in re.split(r'[\s|;&]+', cmd[line_start:i]) if w]
            is_code = any(os.path.basename(w.strip('"\'')) in INTERPRETERS for w in words)
            pos = i + 1
            for delim, _at in pending:
                body_end, resume = n, n
                scan = pos
                while scan < n:
                    e = cmd.find('\n', scan)
                    if e == -1:
                        e = n
                    if cmd[scan:e].strip() == delim:
                        body_end, resume = scan, e
                        break
                    scan = e + 1
                (code if is_code else data).append((pos, body_end))
                pos = resume + 1
            pending = []
            i = max(i + 1, min(n, pos))
        else:
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


def _merge_ranges(ranges):
    """Sorted, overlap-free union of the ranges (nested or overlapping ones join)."""
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1]:
            if b > out[-1][1]:
                out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def _in_ranges(pos, ranges, starts):
    """True when `pos` lies in one of `ranges` (sorted by start, disjoint; `starts` is
    their start offsets). A bisect, not a scan: the scan per quoted span made the
    whole pass quadratic on a command with many quoted spans and many ranges."""
    k = bisect.bisect_right(starts, pos) - 1
    return k >= 0 and pos < ranges[k][1]


def _prose_quote_ranges(text, keep_ranges, code_ranges=()):
    """Ranges of quoted text that contains whitespace -- prose or data (a
    message body, a JSON payload, a regex, a test case), not a path.

    A quoted string WITHOUT whitespace can still be a path, so it stays.
    `keep_ranges` is the interpreter's own script argument: its content
    RUNS, it is not prose.
    """
    state = _quote_map(text)
    out = []
    keep_ranges = _merge_ranges(keep_ranges)
    code_ranges = _merge_ranges(code_ranges)
    keep_starts = [a for a, _b in keep_ranges]
    code_starts = [a for a, _b in code_ranges]
    i = 0
    while i < len(text):
        if state[i]:
            j = i
            while j < len(text) and state[j] == state[i]:
                j += 1
            span = text[i:j]
            inside_keep = _in_ranges(i, keep_ranges, keep_starts)
            # Command substitution inside a quote EXECUTES -- the shell steps
            # back into command context there. Never treated as prose, or a
            # PORT="$(sed ...)" shape would lose a real block. The exception
            # only applies in shell context: inside an interpreter heredoc
            # body, a backtick or $( is just a character in Python/Node text.
            in_code_body = _in_ranges(i, code_ranges, code_starts)
            runs_code = (not in_code_body) and ('$(' in span or chr(96) in span)
            if not inside_keep and not runs_code and re.search(r'\s', span):
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def _logical_spans(text, state=None):
    r"""The REAL shell segments: _segment_spans() cut again at an escaped delimiter on purpose (the fail
    closed direction for the banned-name check), and joined back here for the readings that need the whole
    command, eval's arguments and a here-string next to its shell (`bash -s a\; <<< 'X'` is ONE bash)."""
    spans = _segment_spans(text, state)
    out = []
    for a, b in spans:
        if out and out[-1][1] < len(text):
            end = out[-1][1]
            k = end - 1
            while k >= 0 and text[k] == '\\':
                k -= 1
            # an odd run of backslashes in front of the delimiter escapes it: the cut was not a real one
            if (end - 1 - k) % 2 == 1:
                out[-1] = (out[-1][0], b)
                continue
        out.append((a, b))
    return out


def _word_ends(seg):
    """End offset (in `seg`) of every word, split the way _bare_tokens() splits (same length, so offsets
    carry over: `(` becomes a space, quotes are tracked, empty words are dropped)."""
    sp = seg.replace('(', ' ')
    state = _quote_map(sp)
    ends, cur, i, n = [], False, 0, len(sp)
    while i < n:
        ch = sp[i]
        if not state[i] and ch in ' \t':
            if cur:
                ends.append(i)
                cur = False
        elif not state[i] and ch in ('"', "'"):
            pass
        else:
            cur = True
        i += 1
    if cur:
        ends.append(n)
    return ends


def _has_shell_word(toks):
    return any(os.path.basename(_plain(t)) in _SHELLS or os.path.basename(_plain(t)) in ('source', '.')
               for t, _sp in toks)


def _eval_spans(text, state, spans):
    r"""For every logical segment whose COMMAND is `eval`: ((start, end) of its arguments, up to the REAL end
    of the segment, the quoted ranges inside). The command is found from the normalised tokens, so
    `ev''al 'X'` and `\eval 'X'` count; the arguments start after that word. The real end skips an escaped
    delimiter and everything inside `$( )`, `<( )`, `>( )`, `( )` and backticks (a substitution's `)` or `;`
    is not the end of eval's arguments: `eval true ';' $(b) 'X'` runs X). KNOWN LIMIT, same as shell_subst:
    the `)` of a `case` pattern inside such a substitution ends the scan early. Linear: a segment that
    starts inside an earlier span is skipped."""
    n = len(text)
    found, quoted, scanned_to = [], [], 0
    for a, b in spans:
        if a < scanned_to or b - a < 4:
            continue
        seg = text[a:b]
        # Obfuscating the name needs a quote or a backslash; skip the tokenizer for plain segments.
        if 'eval' not in seg and '"' not in seg and "'" not in seg and '\\' not in seg:
            continue
        toks = _bare_tokens_plain(seg)
        idx = command_index(toks)
        if idx is None or os.path.basename(_plain(toks[idx][0])) != 'eval':
            continue
        ends = _word_ends(seg)
        # The arguments start after the eval word; if the two word splits ever disagree, start at the
        # segment's beginning (over-reading: the script then holds the prefix too, which only nests).
        start = j = a + (ends[idx] if len(ends) == len(toks) and idx < len(ends) else 0)
        depth, bt = 0, False
        while j < n:
            if state[j]:
                k = j
                while k < n and state[k]:
                    k += 1
                quoted.append((j, k))
                j = k
                continue
            ch = text[j]
            if ch == '\\':
                j += 2
                continue
            if ch == '`':
                bt = not bt
            elif text.startswith(('$(', '<(', '>('), j):
                depth += 1
                j += 2
                continue
            elif ch == '(':
                depth += 1
            elif ch == ')':
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0 and not bt and (
                    ch in ';|\n'
                    or (ch == '&' and not (j + 1 < n and text[j + 1] == '>')
                        and not (j > 0 and text[j - 1] in '<>'))):
                break
            j += 1
        found.append((start, j))
        scanned_to = j
    return found, quoted


def _bare_tokens_plain(seg):
    """_bare_tokens() without the here-string spacing: the same words _word_ends() counts."""
    return [(t, sp) for t, sp in _tokens(seg.replace('(', ' ')) if t]


def _eval_scripts(text):
    r"""The scripts eval would run: its arguments after the outer shell's unescaping, joined with spaces
    (`eval true\; 'X'` receives `true;` and `X`, so the script has a real `;` in it)."""
    state = _quote_map(text)
    found, _quoted = _eval_spans(text, state, _logical_spans(text, state))
    out = []
    for a, b in found:
        words = [t for t, _sp in _tokens(_space_herestrings(text[a:b]), unescape=True)]
        if words and words[0] == '--':
            words = words[1:]
        script = ' '.join(words)
        if script.strip():
            out.append(script)
    return out


def _herestring_scripts(text):
    """The words after every unquoted `<<<` of a logical segment that holds a shell, `source` or `.` word
    ANYWHERE (fail closed, the command position is not worked out; `cat <<< 'X'` stays data). The last
    here-string is the shell's stdin, the others cost nothing to read."""
    if '<<<' not in text:
        return []
    state = _quote_map(text)
    out = []
    for a, b in _logical_spans(text, state):
        seg = text[a:b]
        if '<<<' not in seg or not _has_shell_word(_bare_tokens(seg)):
            continue
        toks = _tokens(_space_herestrings(seg), unescape=True)
        for k in range(len(toks) - 1):
            if toks[k][0] == '<<<' and toks[k + 1][0] not in out:
                out.append(toks[k + 1][0])
    return out


def _herestring_ranges(text, state, spans):
    """Ranges of the quoted word after an unquoted `<<<` in a logical segment that holds a shell, `source`
    or `.` word ANYWHERE: script text, kept out of the prose blanking."""
    if '<<<' not in text:
        return []
    out, n = [], len(text)
    for a, b in spans:
        if b - a < 4 or '<<<' not in text[a:b]:
            continue
        if not _has_shell_word(_bare_tokens(text[a:b])):
            continue
        i = a
        while True:
            q = text.find('<<<', i, b)
            if q < 0:
                break
            if state[q]:
                i = q + 3
                continue
            j = q + 3
            while j < n and text[j] in ' \t':
                j += 1
            if j < n and text[j] in ('"', "'"):
                k = e = j + 1
                while e < n and state[e]:
                    e += 1
                out.append((k, e))
                i = e
            else:
                i = q + 3
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
    # More running code, same reading: the quoted LITERAL handed to a shell that runs it again.
    #   eval 'X'                    eval joins ALL its arguments with spaces and runs the result, so every
    #                               quoted argument up to the end of the segment is script text
    #                               (`eval true ';' 'rm -rf x'`, `eval -- 'X'`, `eval a "rm -rf x"`)
    spans = _logical_spans(text, state)
    out.extend(_eval_spans(text, state, spans)[1])
    #   bash <<< 'X'  /  bash<<<'X'  /  bash -x <<< 'X'    a shell's here-string is its script, wherever the
    #                               `<<<` sits in the segment of a shell (or of source / `.`)
    out.extend(_herestring_ranges(text, state, spans))
    #   source <(echo 'X')  /  . <(printf 'X')    the quoted text inside the process substitution
    for m in re.finditer(r'(?<![\w-])(?:source|\.)\s+<\(', text):
        j = m.end()
        while j < len(text) and (state[j] or text[j] != ')'):
            if state[j] and (j == 0 or not state[j - 1]):
                k = j
                while k < len(text) and state[k]:
                    k += 1
                out.append((j, k))
                j = k
                continue
            j += 1
    return out


def scannable(cmd):
    """The part of the command that ACTUALLY runs. See the module header."""
    data, code = _heredoc_body_ranges(cmd)
    text = _blank_ranges(cmd, data)
    text = _blank_ranges(text, _comment_ranges(text))
    keep = _script_arg_ranges(text)
    text = _blank_ranges(text, _prose_quote_ranges(text, keep, code))
    # LAST, on purpose: every range above is an offset into the ORIGINAL text, and a continuation joined
    # earlier would shift them. It also has to come after the heredoc and comment blanking: a data heredoc
    # whose line ends in a backslash would otherwise swallow its own terminator line (and everything after
    # it would read as heredoc data), and a comment ending in a backslash would swallow the next line.
    return _join_continuations(text)


def _join_continuations(text):
    """Remove every backslash-newline that the shell removes: outside single quotes (in double quotes
    and unquoted alike). `r\\<newline>m -rf x` runs `rm -rf x`; the gate has to read it as one word.

    Walks the text once (linear). An escaped backslash (`\\\\`) consumes its pair, so `\\\\<newline>` is
    a literal backslash and a real line break, not a continuation.
    """
    if '\\\n' not in text:
        return text
    out, i, q = [], 0, 0  # q: 0 unquoted, 1 single quote, 2 double quote
    n = len(text)
    while i < n:
        ch = text[i]
        if q == 1:
            out.append(ch)
            if ch == "'":
                q = 0
            i += 1
            continue
        if ch == '\\' and i + 1 < n:
            if text[i + 1] == '\n':
                i += 2
                continue
            out.append(ch)
            out.append(text[i + 1])
            i += 2
            continue
        if q == 0 and ch == '#' and (i == 0 or text[i - 1] in ' \t\n;|&()<>'):
            # An unquoted `#` at the start of a word opens a comment that ends at the newline; a backslash
            # in front of that newline is just a character of the comment, NOT a continuation. Joining it
            # would swallow the next line (a command that really runs) into the comment's line.
            j = text.find('\n', i)
            j = n if j < 0 else j
            out.append(text[i:j])
            i = j
            continue
        if ch == "'" and q == 0:
            q = 1
        elif ch == '"':
            q = 2 if q == 0 else 0
        out.append(ch)
        i += 1
    return ''.join(out)


def _segment_spans(text, state=None):
    r"""(start, end) of every logical segment: the boundaries segments() cuts at. An ESCAPED delimiter
    (`\;`) still cuts, on purpose: over-splitting is the fail-closed direction for every command that
    re-parses its joined arguments through a shell (watch, parallel, ...), and the text after the cut is
    judged as a command of its own."""
    if state is None:
        state = _quote_map(text)
    n = len(text)
    spans, start, i = [], 0, 0
    while i < n:
        if state[i]:
            i += 1
            continue
        hit = next((d for d in DELIMS if text.startswith(d, i)), None)
        if hit:
            spans.append((start, i))
            i += len(hit)
            start = i
            continue
        if text[i] == '&' and not (i + 1 < n and text[i + 1] == '>') \
                and not (i > 0 and text[i - 1] in '<>'):
            spans.append((start, i))
            i += 1
            start = i
            continue
        i += 1
    spans.append((start, n))
    return spans


def segments(text):
    """Logical segments (&&, ||, ;, |, &, newline, $(, backtick) -- quote-aware.

    A naive split lets a '|' inside a quoted grep pattern open a fake new
    segment, making the pattern's next word look like a command name.

    A single `&` (run in the background) ends a segment too: `true & rm x` runs both. It is NOT a
    delimiter inside `&&`, `&>` / `&>>` (redirect both streams) or `>&` / `<&` / `2>&1` (file
    descriptor duplication): cutting those apart would make the word after them a fake command.
    """
    return [p for p in (text[a:b].strip() for a, b in _segment_spans(text)) if p]


def _tokens(seg, unescape=False):
    """Quote-aware word splitting. Items: (text without quotes, had a
    whitespace inside a quote).

    unescape=True also removes the shell's own backslashes (unquoted `\\;` -> `;`; in double quotes only
    before `$` `` ` `` `"` `\\`; none in single quotes): the words the command RECEIVES. eval needs them,
    it parses its joined arguments as a script again."""
    state = _quote_map(seg)
    toks, cur, had_space, i = [], [], False, 0
    while i < len(seg):
        ch = seg[i]
        if unescape and ch == '\\' and i + 1 < len(seg) and state[i] != 1:
            nxt = seg[i + 1]
            if state[i] == 0 or nxt in '$`"\\':
                cur.append(nxt)
            else:
                cur.append(ch)
                cur.append(nxt)
            i += 2
            continue
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
_TRANSPARENT = ('exec', 'command', 'time', 'nohup', 'env', 'builtin', 'noglob', 'nocorrect')
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
# Limits of the command-substitution inspection (see shell_subst.py). Past any of
# them the gate DENIES: what it cannot finish reading inside the hook timeout it
# does not wave through. 256 KiB and 256 bodies are far above anything a real call
# carries; 4 s leaves the 10 s hook timeout a wide margin.
MAX_CMD_CHARS = 262144
MAX_SUBST_BODIES = 256
# Total text of all bodies judged (a body nested k deep is read k times): half the call cap, so a body
# that is most of the command is refused before it is read again (the cost of a hostile one).
MAX_SUBST_CHARS = 131072
INSPECT_SECONDS = 4.0
_budget = {'bodies': 0, 'chars': 0, 'deadline': None}


def _bare_tokens(seg):
    return [(t, sp) for t, sp in _tokens(_space_herestrings(seg).replace('(', ' ')) if t]


def _space_herestrings(seg):
    """`bash<<<'X'` is one word to the tokenizer; the shell reads `bash` and a here-string. Put spaces
    around every UNQUOTED `<<<`."""
    if '<<<' not in seg:
        return seg
    state = _quote_map(seg)
    out, last = [], 0
    for m in re.finditer('<<<', seg):
        if state[m.start()]:
            continue
        out.append(seg[last:m.start()])
        out.append(' <<< ')
        last = m.end()
    out.append(seg[last:])
    return ''.join(out)


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


def _plain(word):
    """A command word the way the shell reads it: unquoted backslashes dropped (`\\rm` and `r\\m` run
    `rm`). Quotes are already gone (_tokens). The word is only ever used to be COMPARED."""
    return word.replace('\\', '')


# Words that open or continue a compound command: the real command name is the NEXT word. Only ever
# looked at in FIRST position of a segment -- `git commit -m "... then rm ..."` and `man rm` start with
# another word, so a word of this list inside an argument is never read as one.
_SHELL_KEYWORDS = frozenset(('if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}'))


def _skip_shell_syntax(toks, i):
    """Index past the shell syntax that can stand in front of a segment's command name:
    compound-command keywords (`then rm`, `do rm`, `else rm`), `{` / `}`, `!`, a `case` header
    (`case x in`) or a case pattern (`a) rm`, `a|b)` is cut at the `|` first), and a function
    definition (`f() { rm x; }` reads `f) {`, `function f {`, `function f() {`). No iteration cap: every
    branch moves `i` forward by at least one word, so the walk is linear in the words and ends. A cap would
    stop in front of a keyword and read IT as the command name, which fails open."""
    while i < len(toks):
        w = _plain(toks[i][0])
        if w in _SHELL_KEYWORDS:
            i += 1
            continue
        if w in (')', '){'):
            # What is left of `function f() {` / `function f(){` after the name was skipped.
            i += 1
            continue
        if w == 'case':
            # `case WORD in`: skip through the `in`.
            j = i + 1
            while j < len(toks) and _plain(toks[j][0]) != 'in' and j < i + 4:
                j += 1
            i = j + 1 if j < len(toks) and _plain(toks[j][0]) == 'in' else i + 1
            continue
        if w == 'function':
            i += 2
            continue
        # `f() {` / `f () {` / `f(){`: _bare_tokens blanked the `(`, leaving `f` then `)` (then `{`), or
        # `f` then `){`. A lone `(rm)` has no `{` after its `)`, so a subshell is not mistaken for this.
        if i + 1 < len(toks) and not toks[i][1]:
            nxt = toks[i + 1][0]
            if nxt == '){':
                i += 2
                continue
            if nxt == ')' and i + 2 < len(toks) and toks[i + 2][0] == '{':
                i += 3
                continue
        # A case pattern ending in `)` (the `(` was blanked by _bare_tokens): `a) rm`, or `b) rm` after `a|`.
        # Only when more words follow: a lone `rm)` is `(rm)`, a subshell, and its name must stay readable.
        if len(w) > 1 and w.endswith(')') and '(' not in w and not toks[i][1] and i + 1 < len(toks):
            i += 1
            continue
        return i
    return i


def command_index(toks):
    """Index of the segment's ACTUAL command name, seeing through wrappers.

    Environment assignments (FOO=bar), transparent prefixes (exec, env, ...)
    and wrappers (xargs, timeout, ...) are skipped. None if there is no
    command name.
    """
    i = _skip_shell_syntax(toks, 0)
    for _ in range(12):  # bounded chain length -- never loop forever
        while i < len(toks) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[i][0]):
            i += 1
        if i >= len(toks):
            return None
        base = os.path.basename(_plain(toks[i][0]))
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
    """The script a segment's command hands to a shell to RUN again: a shell's -c script, `bash -c 'X'`.
    eval's arguments and a here-string are read at TEXT level (_eval_scripts, _herestring_scripts): their
    real segment can span an escaped `;`.
    KNOWN LIMIT (stated in the CHANGELOG): only text that is LITERAL in the command is read. A script
    built from a variable (`eval "$A$B"`, `source "$f"`) is not followed; the gate governs cooperating
    agents and does not claim to be a sandbox (see the wrapper note above).
    """
    if idx is None:
        return []
    if os.path.basename(_plain(toks[idx][0])) not in _SHELLS:
        return []
    for k in range(idx + 1, len(toks)):
        if toks[k][0] in ('-c', '--command') and k + 1 < len(toks):
            return [toks[k + 1][0]]
    return []


_ECHO_UNREADABLE = object()


def _literal_echo_script(body):
    """The text `echo` / `printf` would print, when `body` is exactly such a command: the script a
    `source <(echo 'X')` reads. None for any other body (its own bodies are judged on their own).

    FAIL CLOSED where the printed text is not the text written: a backslash (escapes under `echo -e`, zsh's
    echo, `xpg_echo`, printf's `\\x72m`), a `%` in a printf format (`%b`), `echo -e` / `-E`, or a printf
    option. Those return _ECHO_UNREADABLE and the caller denies; modelling them would be a second shell.
    """
    toks = _tokens(body.strip())
    idx = command_index(toks)
    base = os.path.basename(_plain(toks[idx][0])) if idx is not None else ''
    if base not in ('echo', 'printf'):
        return None
    if '\\' in body or (base == 'printf' and '%' in body):
        return _ECHO_UNREADABLE
    args = [t for t, _sp in toks[idx + 1:]]
    k = 0
    if base == 'echo':
        # Only the LEADING option words are options: `echo rm -rf x` prints "rm -rf x", dash words and all.
        while k < len(args) and re.fullmatch(r'-[neE]+', args[k]):
            if re.search('[eE]', args[k]):
                return _ECHO_UNREADABLE
            k += 1
        words = args[k:]
    else:
        if args and args[0] == '--':
            k = 1
        if k < len(args) and args[k].startswith('-'):
            return _ECHO_UNREADABLE  # printf -v prints nothing, and other options are not modelled
        # No `%` in the format: the format alone is printed, extra arguments are ignored.
        words = args[k:k + 1]
    return ' '.join(words) if words else None


def _is_coordinator_push_allowed():
    """True only when THIS process is running inside one of the main agent's
    OWN tmux sessions, never a sub-agent's ("agent-<name>"). Deliberately NOT
    cwd-based: agent_id_from_cwd() falls back to the last path component for
    any cwd outside <install> and <install>/agents/<id> (e.g. a shared
    worktree under ~/worktrees/, which the coordinator AND sub-agents both
    operate in for delegated dev work), so cwd cannot tell the two apart
    there. The tmux session name is set once at process launch and is
    invariant to `cd`, including into a worktree.

    Two independent checks, either one grants:
      1. MARVEEN_COORDINATOR_PUSH_ALLOWED=1 -- exported only by channels.sh
         at coordinator-session startup, never by the sub-agent spawn path
         (agent-process-spawn.ts). An env var survives `cd` and a tmux
         rename, so this is the stronger of the two signals.
      2. The live tmux session name matches one of the coordinator's own
         session templates: "<main_id>-channels" (the long-lived channels
         session, main-agent.ts channelsSessionName()), "<main_id>-worker"
         and "<main_id>-worker-fast" (the background task workers,
         agent-worker.ts ctxSlow/ctxFast), or "agent-<main_id>" (the generic
         agentSessionName() template in agent-process-session.ts, which is
         reserved for sub-agents everywhere ELSE in the codebase -- but this
         install has run its actual coordinator under exactly that session
         since 2026-09-15, independently confirmed live via tmux
         list-sessions + capture-pane). The security cost of including it is
         zero: "agent-<main_id>" is a single specific string only the main
         agent's own id can produce, so it grants no additional session --
         "agent-<sub-agent-name>" for any other name is untouched and still
         blocked below.

    Both checks are spoofable by a sub-agent that renames its own tmux
    session or forges the env var into its own process -- this governs
    cooperating agents, not a determined attempt to bypass. Fails closed
    (False) on any error -- no positive proof, no exemption.
    """
    if os.environ.get('MARVEEN_COORDINATOR_PUSH_ALLOWED') == '1':
        return True
    try:
        main_id = ledger_lib.main_agent_id()
        allowed = {
            '%s-channels' % main_id,
            '%s-worker' % main_id,
            '%s-worker-fast' % main_id,
            'agent-%s' % main_id,
        }
        out = subprocess.run(
            ['tmux', 'display-message', '-p', '#S'],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode != 0:
            return False
        return out.stdout.strip() in allowed
    except Exception:
        return False


def check_bash(cmd, agent_id=None, _depth=0):
    if _depth == 0:
        if len(cmd) > MAX_CMD_CHARS:
            block('A parancs tul nagy (%d karakter, a hatar %d): a kapu nem tudja '
                  'atvizsgalni, ezert nem engedi at. Nagy szoveget fajlba ird a Write '
                  'tool-lal.' % (len(cmd), MAX_CMD_CHARS), agent_id, 'Bash')
        _budget['bodies'] = 0
        _budget['chars'] = 0
        _budget['deadline'] = time.monotonic() + INSPECT_SECONDS
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
            # A trailing `)` is the end of a subshell the `(` of which _bare_tokens blanked: `(rm)`.
            base = os.path.basename(_plain(name)).rstrip(')')
            if base in BANNED_CMDS:
                block('A tiltott parancs: "%s" (a teljes szegmens: %s)' % (base, seg[:160]),
                      agent_id, 'Bash')
            if base == 'git' and second is not None and _plain(second) == 'push' \
                    and not _is_coordinator_push_allowed():
                block('git push: a kozos repoba valo iras kifele mutato, visszafordithatatlan '
                      'muvelet. Commitolni szabad, pusholni nem.', agent_id, 'Bash')

        # The -c script is read from the UNMODIFIED tokens too: _bare_tokens() turns every `(`
        # into a space (so `(rm x)` finds its command), which also cut the `$(` out of a script
        # like `bash -c 'echo "$(rm x)"'` before its body could be read.
        raw_toks = _tokens(_space_herestrings(seg))
        subs = _sub_scripts(toks, idx)
        for extra in _sub_scripts(raw_toks, command_index(raw_toks)):
            if extra not in subs:
                subs.append(extra)
        # `source <(echo 'X')` / `. <(printf 'X')`: the process substitution only PRINTS the script, the
        # sourcing shell runs it. The body itself (`echo ...`) is harmless to the loop below, so read the
        # printed text as a script here. A body that is anything else is judged as a command of its own.
        if idx is not None and os.path.basename(_plain(toks[idx][0])) in ('source', '.'):
            for body in shell_subst.top_bodies(seg, False, 8):
                printed = _literal_echo_script(body)
                if printed is _ECHO_UNREADABLE:
                    block('source/. <(echo|printf ...): a kiirt szoveg backslash-escape, printf formatum vagy '
                          'echo -e miatt mas lehet, mint amit a kapu olvas, ezert nem engedi at.',
                          agent_id, 'Bash')
                if printed and printed not in subs:
                    subs.append(printed)
        for sub in subs:
            if not sub or sub == cmd:
                continue
            if _depth >= _MAX_NEST:
                block('Tul melyen agyazott parancs (%d szint): a kapu nem tudja '
                      'vegigkovetni, ezert nem engedi at.' % _depth, agent_id, 'Bash')
            check_bash(sub, agent_id, _depth + 1)

    # eval re-parses its arguments AFTER the outer shell's unescaping and joins ALL of them: judged here, on the
    # text, because a segment cut at an escaped `;` would hold only the first words of them.
    for sub in _eval_scripts(text) + _herestring_scripts(text):
        if sub == cmd:
            continue
        if time.monotonic() > _budget['deadline']:
            block('A parancs atvizsgalasa tul sokaig tart: a kapu nem tudja befejezni, '
                  'ezert nem engedi at.', agent_id, 'Bash')
        if _depth >= _MAX_NEST:
            block('Tul melyen agyazott parancs (%d szint): a kapu nem tudja '
                  'vegigkovetni, ezert nem engedi at.' % _depth, agent_id, 'Bash')
        check_bash(sub, agent_id, _depth + 1)

    m = PROTECTED_RE.search(text)
    if m:
        block('Hitelesito adatokat tartalmazo konyvtar: .%s' % m.group(1), agent_id, 'Bash')
    if _env_file_mentioned(text):
        block('.env fajl: hitelesito adatokat tartalmaz.', agent_id, 'Bash')

    # A command substitution RUNS, also inside double quotes, where the segment
    # splitter above keeps it as text. Each body is judged as a command of its
    # own, one level deeper (the same depth bound as a wrapped -c script).
    for body in shell_subst.top_bodies(cmd, False, MAX_SUBST_BODIES + 1):
        # Every body counts, a blank one too: the reader stops after MAX + 1 bodies, so a gate that
        # skipped blank ones before counting could be filled with them and never see the real one.
        _budget['bodies'] += 1
        if not body.strip():
            if _budget['bodies'] > MAX_SUBST_BODIES:
                block('Tul sok parancs-behelyettesites (tobb mint %d): a kapu nem tudja '
                      'vegigkovetni, ezert nem engedi at.' % MAX_SUBST_BODIES, agent_id, 'Bash')
            continue
        if _budget['bodies'] > MAX_SUBST_BODIES:
            block('Tul sok parancs-behelyettesites (tobb mint %d): a kapu nem tudja '
                  'vegigkovetni, ezert nem engedi at.' % MAX_SUBST_BODIES, agent_id, 'Bash')
        _budget['chars'] += len(body)
        if _budget['chars'] > MAX_SUBST_CHARS:
            block('A parancs-behelyettesitesek szovege egyutt tul nagy (%d karakter felett): '
                  'a kapu nem tudja vegigkovetni, ezert nem engedi at.' % MAX_SUBST_CHARS,
                  agent_id, 'Bash')
        if time.monotonic() > _budget['deadline']:
            block('A parancs atvizsgalasa tul sokaig tart: a kapu nem tudja befejezni, '
                  'ezert nem engedi at.', agent_id, 'Bash')
        if _depth >= _MAX_NEST:
            block('Tul melyen agyazott parancs-behelyettesites (%d szint): a kapu nem '
                  'tudja vegigkovetni, ezert nem engedi at.' % _depth, agent_id, 'Bash')
        check_bash(body, agent_id, _depth + 1)


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
    _EVENT['session_id'] = ev.get('session_id')
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
    # OTel H5b: count this run's outcome after the verdict (best effort, never changes it; see
    # gate_audit_lib.py). A missing or broken audit module leaves the gate exactly as it was.
    try:
        from gate_audit_lib import audited
    except Exception:  # noqa: BLE001
        audited = None
    if audited is None:
        main()
    else:
        audited('destructive-gate', main)
