#!/usr/bin/env python3
"""auth-admin-gate.py -- PreToolUse hard gate: an agent's Bash call may not mint or
destroy a login, a session or a bearer, and may not approve its own request.

WHY A HOOK: the dashboard routes that create users, tokens, device keys and browser
enrolment codes are session-only (403 `human_session_required` for a bearer caller), but
the machine's own break-glass paths do the same work with NO HTTP and NO auth gate:
  (1) the dashboard-user CLI (`npm run dashboard-user`, tsx/node on scripts/dashboard-user.*,
      scripts/security-reset*), which talks to SQLite directly, and
  (2) a direct write to the auth tables of the live store DB (sqlite3 / python / node).
An agent that can run either can give itself a human session, and then a human-only
approval (email_send, ...) is no longer a human decision. A hook runs regardless of the
permission mode (see destructive-gate.py for why a settings.json deny list is not enough).

WHAT IS BLOCKED (exit 2):
  1. The CLI: any invocation of dashboard-user / security-reset except the read-only
     `list`. Every shape of getting there is followed: npm/pnpm/yarn run, npx/bunx/pnpm dlx,
     tsx/ts-node/node/bun/deno/vite-node (compiled dist/ too), a direct ./scripts/ path,
     shell globs and brace expansions of the name, bash/sh/zsh -c, eval, env -S, xargs, find
     -exec, timeout/nice/nohup/... wrappers, heredocs and here-strings, `echo ... | bash`,
     $(...) and backticks, `ssh host ...`, tmux send-keys / run-shell, osascript,
     shell variables assigned in the same command line, and a shell script file that
     contains such a call (bash x.sh, source x.sh, ./x.sh).
  2. `--password-stdin` on any command (except docker/podman/buildah/skopeo/helm/crane
     login), also when the command is hidden behind a wrapper.
  3. A write (INSERT/UPDATE/DELETE/REPLACE/DROP/ALTER/RENAME TO/.import/.restore) on an
     auth table: dashboard_users, auth_sessions, api_tokens, device_keys (+ their _old
     and _seq shadows), and approvals / approval_events (an agent must not approve its
     own request by writing the row). sqlite3 / sqlite / litecli / sqlite-utils /
     duckdb / psql ...: only when the database is the live store (path-aware: a copy in
     /tmp is the QA instances' own business) or cannot be resolved. python / node / perl /
     ruby / php code (-c / -e / heredoc / here-string / pipe) has no visible path, so a
     write to those tables there is blocked wherever it points. The app's own mutators
     (createDashboardUser, securityReset, insertApiToken, ...) in interpreter code are
     blocked too, and so is interpreter code that spawns the CLI.
  4. Base64/xxd/openssl-decoded text handed to a shell or eval (the decoded text cannot be
     inspected, so it is not let through).
READS ARE ALLOWED: SELECT, `.dump`, `.schema`, `.tables`, `npm run dashboard-user -- list`.

BOUNDED AND FAIL-CLOSED (same rules as outgoing-copy-gate.py, #650): one linear lexer
pass, hard limits (command size, heredoc openers, opener line length, nesting depth, a
total work budget), and over a limit the gate DENIES ("too large to inspect"), because a
hook still running at its timeout is NOT a deny. A wall-clock alarm (8 s, under the
10 s hook timeout) turns a hang into an explicit exit 2. Bad input, an internal error,
an unreadable event: exit 2. Exit 0 only after a complete inspection found nothing.

HONEST LIMITS (good-faith protection against the same OS user, like the docs say):
  - A script FILE of another language (python/node) that an agent wrote and then runs is
    not read: test fixtures in the repo legitimately contain INSERT INTO api_tokens ...
    and would be blocked. Shell script files ARE read (nothing in the repo calls the CLI).
  - A table name built at run time (f"UPDATE {t} SET ...") is not seen.
  - Anything the owner types in their own terminal is not under a hook at all.
  - Only the Bash tool is inspected here.

Contract: exit 0 = allow (silent), exit 2 = block (stderr surfaced to the model).
NOT wired into any settings.json by this file; the coordinator wires it (Bash matcher,
timeout 10, the same `command -v python3 || exit 2` guard as destructive-gate).
"""
import glob
import hashlib
import json
import os
import re
import signal
import stat
import sys

HARD_TIMEOUT_S = 8
MAX_EVENT_CHARS = 524288
MAX_CMD_CHARS = 131072
MAX_HEREDOC_OPENERS = 32
MAX_OPENER_LINE_CHARS = 4096
MAX_NEST = 6
MAX_WORK_CHARS = 1048576      # total characters lexed over the whole inspection
MAX_CALLS = 400               # total check_command invocations
MAX_WORDS_PER_COMMAND = 20000
MAX_SUBS = 128
MAX_SCRIPT_BYTES = 262144
MAX_BRACE_ALTS = 64
MAX_GLOB_HITS = 50
MAX_STORE_SCAN = 1024         # directory entries looked at when hunting for the live DB files
MAX_LIVE_INODES = 64          # live-store inodes kept
MAX_TRIGGER_HEADS = 64        # `CREATE TRIGGER` headers looked at per text; more is "unknown"
TRIGGER_WINDOW = 4000         # characters after `CREATE TRIGGER` searched for `ON <auth table>`
MAX_LINK_DESTS = 16           # `ln` link names followed exactly; more is "unknown"
MAX_CD_TARGETS = 16           # absolute `cd` targets followed exactly; more is "unknown"
MAX_GENERIC_MARKERS = 8      # marker hits followed per argument text in the generic fallback

CLI_NAMES = ('dashboard-user',)
CLI_PREFIXES = ('security-reset',)
AUTH_TABLES = (
    'dashboard_users', 'auth_sessions', 'api_tokens', 'device_keys',
    'api_tokens_old', 'api_tokens_seq', 'device_keys_old', 'device_keys_seq',
    'approvals', 'approvals_old', 'approval_events',
    # the schema table: rewriting a row of it (PRAGMA writable_schema) edits or drops an auth table's
    # definition and can leave the whole database unreadable
    'sqlite_master', 'sqlite_schema', 'sqlite_temp_master', 'sqlite_temp_schema',
    # raw page access: a write here edits the database file directly
    'sqlite_dbpage',
)


class InspectionLimit(Exception):
    """The command is too large / too deep to inspect inside the hook timeout (DENY)."""


class Deny(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason


class Opaque(Exception):
    """The text a shell / interpreter / SQL client reads comes out of a decoder (base64 -d, xxd -r,
    openssl, gunzip ...): it cannot be inspected. A shell or interpreter DENIES; a SQL client only
    when the database is the live store."""


# --------------------------------------------------------------------------------------
# audit (best effort, never changes the verdict; absent helpers just mean no audit row)
# --------------------------------------------------------------------------------------

def _hooks_dir():
    return os.path.dirname(os.path.abspath(__file__))


def _install_root():
    env = os.environ.get('CLAUDE_PROJECT_DIR')
    if env and os.path.isdir(env):
        return os.path.realpath(env)
    return os.path.dirname(os.path.dirname(_hooks_dir()))


def _audit(agent_id, reason_hash):
    try:
        sys.path.insert(0, _hooks_dir())
        import agent_token  # noqa: E402
        import urllib.request  # noqa: E402
        root = _install_root()
        auth = agent_token.resolve(agent_id=agent_id, store_dir=os.path.join(root, 'store'))
        if not auth.token:
            return
        import dashboard_api  # noqa: E402  the shared resolver: DASHBOARD_BASE_URL, WEB_PORT, the install's .env
        base = dashboard_api.base_url()
        urllib.request.urlopen(
            urllib.request.Request(
                base + '/api/hook-audit',
                data=json.dumps({'agent_id': agent_id, 'hook_type': 'PreToolUse', 'verdict': 'deny',
                                 'tool_name': 'Bash', 'reason': reason_hash}).encode(),
                headers=auth.headers({'Content-Type': 'application/json'}),
                method='POST'),
            timeout=2)
    except Exception:
        pass


def _agent_id(cwd):
    try:
        sys.path.insert(0, _hooks_dir())
        import ledger_lib  # noqa: E402
        return ledger_lib.agent_id_from_cwd(cwd)
    except Exception:
        return None


def block(reason, cwd=''):
    h = hashlib.sha256(reason.encode('utf-8', errors='replace')).hexdigest()[:16]
    if not os.environ.get('AUTH_ADMIN_GATE_NO_AUDIT'):
        _audit(_agent_id(cwd), h)
    sys.stderr.write(
        'AUTH-ADMIN-KAPU: BLOKKOLVA.\n' + reason +
        '\n\nEz a kapu azt vedi, hogy egy agens ne tudjon bejelentkezest, sessiont vagy tokent '
        'letrehozni/torolni, es sajat kerest jovahagyni. A dontes a tulajdone: a dashboardon, '
        'bejelentkezve. Ne probald mas uton megkerulni; ha ez tevedes vagy tenyleg kell, ird meg '
        'Jarvisnak, hogy MIT es MIERT, es o elvegzi vagy tovabbitja.\n')
    sys.exit(2)


# --------------------------------------------------------------------------------------
# lexer: one linear pass; words keep the info the rules need
# --------------------------------------------------------------------------------------

class Word(object):
    __slots__ = ('text', 'dyn', 'alts', 'quoted', 'assign')

    def __init__(self, text, dyn=False, alts=None, quoted=False, assign=False):
        self.text = text
        self.dyn = dyn
        self.alts = alts if alts else [text]
        self.quoted = quoted
        self.assign = assign   # NAME=value with the NAME= part unquoted (a quoted value is fine)


class Seg(object):
    __slots__ = ('words', 'assigns', 'heredocs', 'herestr', 'stdin_files', 'prev', 'subs', 'out_files')

    def __init__(self):
        self.words = []
        self.assigns = []
        self.heredocs = []     # (body, quoted_delimiter)
        self.herestr = []
        self.stdin_files = []
        self.out_files = []    # Word objects: the targets of > >> >| &> redirections
        self.prev = None       # previous segment of the same pipeline
        self.subs = []         # $(...) / `...` / <(...) bodies seen in this segment


_ASSIGN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=')
_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
_SAFE_ENV = ('HOME', 'PWD', 'OLDPWD', 'USER', 'TMPDIR', 'LOGNAME')
_KEYWORDS = ('if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '}', '!', 'time', 'coproc')


class Budget(object):
    def __init__(self):
        self.chars = 0
        self.calls = 0
        self.subs = 0


def _match_paren(s, i):
    """Index of the ')' that closes the '(' just before s[i]; -1 if none. Quote-aware, bounded
    by the string; one pass."""
    depth = 1
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == '\\':
            i += 2
            continue
        if ch == "'":
            j = s.find("'", i + 1)
            if j == -1:
                return -1
            i = j + 1
            continue
        if ch == '"':
            i += 1
            while i < n and s[i] != '"':
                i += 2 if s[i] == '\\' else 1
            i += 1
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _find_backtick(s, i):
    n = len(s)
    while i < n:
        if s[i] == '\\':
            i += 2
            continue
        if s[i] == '`':
            return i
        i += 1
    return -1


def _ansi_c(body):
    """Decode the body of $'...' (\\xHH, \\NNN, \\n, \\t, \\\\, \\', \\")."""
    out = []
    i = 0
    n = len(body)
    simple = {'n': '\n', 't': '\t', 'r': '\r', 'a': '\a', 'b': '\b', 'f': '\f', 'v': '\v',
              '\\': '\\', "'": "'", '"': '"', 'e': '\x1b', 'E': '\x1b'}
    while i < n:
        c = body[i]
        if c != '\\' or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        d = body[i + 1]
        if d in simple:
            out.append(simple[d])
            i += 2
        elif d == 'x':
            m = re.match(r'[0-9A-Fa-f]{1,2}', body[i + 2:i + 4])
            if m:
                out.append(chr(int(m.group(), 16)))
                i += 2 + len(m.group())
            else:
                out.append('\\x')
                i += 2
        elif d in '01234567':
            m = re.match(r'[0-7]{1,3}', body[i + 1:i + 4])
            out.append(chr(int(m.group(), 8) & 0xFF))
            i += 1 + len(m.group())
        elif d in 'uU':
            m = re.match(r'[0-9A-Fa-f]{1,8}', body[i + 2:i + 10])
            if m:
                try:
                    out.append(chr(int(m.group(), 16)))
                except (ValueError, OverflowError):
                    pass
                i += 2 + len(m.group())
            else:
                out.append('\\' + d)
                i += 2
        else:
            out.append('\\' + d)
            i += 2
    return ''.join(out)


def _brace_alts(text):
    """Brace expansion of an unquoted word: a{b,c}d, {a,b}, x{1..3}. Bounded; None = leave."""
    if '{' not in text or '}' not in text:
        return None
    results = [text]
    for _ in range(4):  # nesting / repeated groups, bounded
        nxt = []
        changed = False
        for r in results:
            m = re.search(r'\{([^{}]*)\}', r)
            if not m or (',' not in m.group(1) and '..' not in m.group(1)):
                nxt.append(r)
                continue
            changed = True
            inner = m.group(1)
            if ',' in inner:
                parts = inner.split(',')
            else:
                a, _, b = inner.partition('..')
                if a.lstrip('-').isdigit() and b.lstrip('-').isdigit() and abs(int(b) - int(a)) < 50:
                    lo, hi = sorted((int(a), int(b)))
                    parts = [str(x) for x in range(lo, hi + 1)]
                elif len(a) == 1 and len(b) == 1 and a.isalpha() and b.isalpha():
                    lo, hi = sorted((ord(a), ord(b)))
                    parts = [chr(x) for x in range(lo, hi + 1)]
                else:
                    nxt.append(r)
                    continue
            for p in parts:
                nxt.append(r[:m.start()] + p + r[m.end():])
            if len(nxt) > MAX_BRACE_ALTS:
                raise InspectionLimit('brace expansion above %d alternatives' % MAX_BRACE_ALTS)
        results = nxt
        if not changed:
            break
    return results if len(results) > 1 or results[0] != text else None


def lex(cmd, state):
    """Split a command string into segments of words. Linear; heredoc bodies are consumed at
    the newline that ends their opener line. Raises InspectionLimit over a limit."""
    state.budget.chars += len(cmd)
    if state.budget.chars > MAX_WORK_CHARS:
        raise InspectionLimit('the total text to inspect is above %d characters' % MAX_WORK_CHARS)
    n = len(cmd)
    i = 0
    segs = []
    cur = Seg()
    parts = []
    has_word = False
    wdyn = False
    wsplit = False
    plain = True      # no quote / escape in the current word
    wquoted = False   # any quote / escape in the current word
    qstart = None     # text length at the first quote of the current word
    pending_here = []   # (seg, delim, quoted)
    redir = None        # 'skip' | 'in' | 'here' | ('heredoc', strip) -- the next word is a target
    nwords = [0]
    openers = [0]

    def vars_get(name):
        if name in state.vars:
            return state.vars[name]
        if name in _SAFE_ENV and name in os.environ:
            return os.environ[name]
        return None

    def add_sub(body):
        state.budget.subs += 1
        if state.budget.subs > MAX_SUBS:
            raise InspectionLimit('more than %d command substitutions' % MAX_SUBS)
        cur.subs.append(body)

    def mark_quote():
        nonlocal qstart
        if qstart is None:
            qstart = sum(len(p) for p in parts)

    def end_word():
        nonlocal parts, has_word, wdyn, wsplit, plain, wquoted, redir, qstart
        if not has_word:
            return
        text = ''.join(parts)
        quoted_any = wquoted
        was_plain = plain
        dyn = wdyn
        split = wsplit
        qs = qstart
        parts, has_word, wdyn, wsplit, plain, wquoted, qstart = [], False, False, False, True, False, None
        if was_plain and text.startswith('~') and (len(text) == 1 or text[1] == '/'):
            home = os.environ.get('HOME')
            if home:
                text = home + text[1:]
        words = [text]
        if split and re.search(r'\s', text):
            words = text.split()
            if not words:
                return
        for w in words:
            alts = None
            if was_plain:
                alts = _brace_alts(w)
            is_assign = bool(_ASSIGN.match(w)) and len(words) == 1 and (qs is None or qs > w.index('='))
            word = Word(w, dyn, alts, quoted_any, is_assign)
            nwords[0] += 1
            if nwords[0] > MAX_WORDS_PER_COMMAND:
                raise InspectionLimit('more than %d words' % MAX_WORDS_PER_COMMAND)
            handle_word(word)

    def handle_word(word):
        nonlocal redir
        if redir is not None:
            r = redir
            redir = None
            if r == 'in':
                cur.stdin_files.append(word.text)
            elif r == 'here':
                cur.herestr.append(word.text)
            elif r == 'out':
                cur.out_files.append(word)
            elif isinstance(r, tuple) and r[0] == 'heredoc':
                openers[0] += 1
                if openers[0] > MAX_HEREDOC_OPENERS:
                    raise InspectionLimit('more than %d heredoc openers' % MAX_HEREDOC_OPENERS)
                pending_here.append((cur, word.text, word.quoted))
            return
        if not cur.words and word.assign:
            name, _, val = word.text.partition('=')
            cur.assigns.append((name, val))
            return
        cur.words.append(word)

    def end_seg(pipe_next=False):
        nonlocal cur
        end_word()
        if (cur.words or cur.assigns or cur.heredocs or cur.herestr or cur.stdin_files or cur.subs
                or cur.out_files):
            _apply_assigns(cur, state)
            segs.append(cur)
            prev = cur
        else:
            prev = None
        cur = Seg()
        if pipe_next and prev is not None:
            cur.prev = prev

    while i < n:
        ch = cur_ch = cmd[i]
        # ---- line break: ends the segment and carries pending heredoc bodies ----
        if ch == '\n':
            end_seg()
            i += 1
            if pending_here:
                for (hseg, delim, quoted) in pending_here:
                    lines = []
                    closed = False
                    while i <= n:
                        j = cmd.find('\n', i)
                        line = cmd[i:] if j == -1 else cmd[i:j]
                        i = n + 1 if j == -1 else j + 1
                        if line.strip() == delim:
                            closed = True
                            break
                        lines.append(line)
                        if j == -1:
                            break
                    hseg.heredocs.append(('\n'.join(lines), quoted))
                    if not closed:
                        i = n
                pending_here = []
            continue
        if ch in ' \t\r':
            end_word()
            i += 1
            continue
        if ch == '\\':
            if i + 1 < n and cmd[i + 1] == '\n':   # line continuation
                i += 2
                continue
            if i + 1 < n:
                mark_quote()
                parts.append(cmd[i + 1])
                has_word = True
                plain = False
                wquoted = True
                i += 2
                continue
            parts.append('\\')
            has_word = True
            i += 1
            continue
        if ch == '#' and not has_word:
            j = cmd.find('\n', i)
            i = n if j == -1 else j
            continue
        if ch == "'":
            mark_quote()
            j = cmd.find("'", i + 1)
            if j == -1:
                parts.append(cmd[i + 1:])
                i = n
            else:
                parts.append(cmd[i + 1:j])
                i = j + 1
            has_word = True
            plain = False
            wquoted = True
            continue
        if ch == '$' and i + 1 < n and cmd[i + 1] == "'":
            mark_quote()
            j = i + 2
            while j < n and cmd[j] != "'":
                j += 2 if cmd[j] == '\\' else 1
            parts.append(_ansi_c(cmd[i + 2:j]))
            i = min(j + 1, n)
            has_word = True
            plain = False
            wquoted = True
            continue
        if ch == '"' or (ch == '$' and i + 1 < n and cmd[i + 1] == '"'):
            mark_quote()
            i += 2 if ch == '$' else 1
            has_word = True
            plain = False
            wquoted = True
            while i < n and cmd[i] != '"':
                c = cmd[i]
                if c == '\\' and i + 1 < n:
                    d = cmd[i + 1]
                    parts.append(d if d in '$`"\\' else c + d)
                    i += 2
                    continue
                if c == '$' and cmd.startswith('$(', i) and not cmd.startswith('$((', i):
                    k = _match_paren(cmd, i + 2)
                    if k == -1:
                        add_sub(cmd[i + 2:])
                        i = n
                        wdyn = True
                        continue
                    add_sub(cmd[i + 2:k])
                    parts.append('$(...)')
                    wdyn = True
                    i = k + 1
                    continue
                if c == '`':
                    k = _find_backtick(cmd, i + 1)
                    if k == -1:
                        add_sub(cmd[i + 1:])
                        i = n
                    else:
                        add_sub(cmd[i + 1:k])
                        i = k + 1
                    parts.append('`...`')
                    wdyn = True
                    continue
                if c == '$':
                    i = _expand_var(cmd, i, parts, vars_get, False, lambda: None)
                    if parts and parts[-1] is None:
                        parts.pop()
                        wdyn = True
                    continue
                parts.append(c)
                i += 1
            i += 1
            continue
        if ch == '$' and cmd.startswith('$((', i):
            k = cmd.find('))', i + 3)
            parts.append('$((...))')
            wdyn = True
            has_word = True
            i = n if k == -1 else k + 2
            continue
        if ch == '$' and cmd.startswith('$(', i):
            k = _match_paren(cmd, i + 2)
            if k == -1:
                add_sub(cmd[i + 2:])
                i = n
            else:
                add_sub(cmd[i + 2:k])
                i = k + 1
            parts.append('$(...)')
            wdyn = True
            has_word = True
            continue
        if ch == '`':
            k = _find_backtick(cmd, i + 1)
            if k == -1:
                add_sub(cmd[i + 1:])
                i = n
            else:
                add_sub(cmd[i + 1:k])
                i = k + 1
            parts.append('`...`')
            wdyn = True
            has_word = True
            continue
        if ch == '$':
            before = len(parts)
            i = _expand_var(cmd, i, parts, vars_get, True, lambda: None)
            has_word = True
            if len(parts) > before and parts[-1] is None:
                parts.pop()
                wdyn = True
            elif len(parts) > before:
                wsplit = True
            continue
        if ch in '<>' and cmd.startswith('<(', i) or ch == '>' and cmd.startswith('>(', i):
            k = _match_paren(cmd, i + 2)
            if k == -1:
                add_sub(cmd[i + 2:])
                i = n
            else:
                add_sub(cmd[i + 2:k])
                i = k + 1
            parts.append('<(...)')
            wdyn = True
            has_word = True
            continue
        if ch in '<>':
            # an fd prefix (2>file) is not an argument
            if has_word and not wquoted and ''.join(parts).isdigit():
                parts, has_word, wdyn, wsplit, plain, wquoted, qstart = [], False, False, False, True, False, None
            else:
                end_word()
            if cmd.startswith('<<<', i):
                redir = 'here'
                i += 3
            elif cmd.startswith('<<', i):
                i += 2
                if i < n and cmd[i] == '-':
                    i += 1
                redir = ('heredoc', False)
                # an opener line that is absurdly long is not inspected
                ls = cmd.rfind('\n', 0, i) + 1
                le = cmd.find('\n', i)
                if (n if le == -1 else le) - ls > MAX_OPENER_LINE_CHARS:
                    raise InspectionLimit('a heredoc opener line is longer than %d characters'
                                          % MAX_OPENER_LINE_CHARS)
            elif ch == '<':
                i += 1
                if i < n and cmd[i] == '&':
                    i += 1
                    redir = 'skip'
                else:
                    redir = 'in'
            else:
                i += 1
                if i < n and cmd[i] == '>':
                    i += 1
                if i < n and cmd[i] in '&|':
                    i += 1
                    # >&2 / >&- : the target is part of the operator
                    j = i
                    while j < n and (cmd[j].isdigit() or cmd[j] == '-'):
                        j += 1
                    if j > i:
                        i = j
                        redir = None
                        continue
                redir = 'out'
            continue
        if ch == '&':
            if cmd.startswith('&>', i):
                end_word()
                i += 2
                if i < n and cmd[i] == '>':
                    i += 1
                redir = 'out'
                continue
            end_seg()
            i += 2 if cmd.startswith('&&', i) else 1
            continue
        if ch == '|':
            pipe = not cmd.startswith('||', i)
            end_seg(pipe_next=pipe)
            i += 2 if (cmd.startswith('||', i) or cmd.startswith('|&', i)) else 1
            continue
        if ch == ';':
            end_seg()
            i += 2 if cmd.startswith(';;', i) or cmd.startswith(';&', i) else 1
            continue
        if ch in '()':
            end_seg()
            i += 1
            continue
        parts.append(ch)
        has_word = True
        i += 1
    end_seg()
    if len(pending_here) > 0:
        # opener on the very last line with no newline: an empty body
        for (hseg, _d, quoted) in pending_here:
            hseg.heredocs.append(('', quoted))
    return segs


def _expand_var(cmd, i, parts, vars_get, unquoted, _unused):
    """Expand the $... at cmd[i]. Appends the value to parts, or None when unknown.
    Returns the new index."""
    n = len(cmd)
    j = i + 1
    if j >= n:
        parts.append('$')
        return j
    if cmd[j] == '{':
        k = cmd.find('}', j + 1)
        if k == -1:
            parts.append(None)
            return n
        name = cmd[j + 1:k]
        val = vars_get(name) if _NAME.fullmatch(name) else None
        parts.append(val if val is not None else None)
        return k + 1
    m = _NAME.match(cmd, j)
    if m:
        val = vars_get(m.group())
        parts.append(val if val is not None else None)
        return m.end()
    if cmd[j] in '0123456789@*#?$!-':
        parts.append(None)
        return j + 1
    parts.append('$')
    return j


def _apply_assigns(seg, state):
    """A segment of only NAME=value assignments sets shell variables for the later segments;
    `export`/`declare`/`readonly`/`local` NAME=value do too. A prefix assignment before a
    command (X=1 cmd) is only that command's environment."""
    if seg.assigns and not seg.words:
        for name, val in seg.assigns:
            if len(state.vars) < 256:
                state.vars[name] = val
    elif seg.words and seg.words[0].text in ('export', 'declare', 'readonly', 'local', 'typeset'):
        for w in seg.words[1:]:
            if _ASSIGN.match(w.text) and len(state.vars) < 256:
                name, _, val = w.text.partition('=')
                state.vars[name] = val


# --------------------------------------------------------------------------------------
# rules
# --------------------------------------------------------------------------------------

class State(object):
    def __init__(self, cwd):
        self.budget = Budget()
        self.vars = {}
        self.cwd = cwd or os.getcwd()
        self.seen_files = set()
        self.isolated_cli = False
        self.dir_changed = False    # a directory change the gate cannot follow (relative / dynamic cd, pushd, env -C ...)
        self.cd_targets = []        # real paths of the ABSOLUTE `cd /x` targets in the inspected text
        self.link_made = False      # an `ln` in the inspected text: a link may not exist yet when we look
        self.link_global = False    # an `ln` whose link name the gate cannot tell: any path may be that link
        self.link_dests = []        # the link names (or link dirs) of the `ln` commands in the text
        self.funcs = set()          # names of shell functions defined in the inspected texts
        self.store_dirs = None      # cache of _store_dirs
        self.live_inodes = None     # cache of _live_inodes


_SHELLS = ('sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish')
_PY = re.compile(r'^python[0-9.]*$')
_NODEISH = ('node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm', 'bun', 'deno', 'esno', 'swc-node',
            'babel-node', 'jiti', 'vite-node')
_SCRIPT_LANGS = ('perl', 'ruby', 'php', 'lua', 'osascript')
_SQL_CLIENTS = ('sqlite3', 'sqlite', 'litecli', 'sqlite-utils', 'duckdb', 'psql', 'pgcli', 'usql',
                'mysql', 'sqlcmd', 'clickhouse-client')
_DECODERS = ('base64', 'xxd', 'openssl', 'uudecode', 'gunzip', 'zcat', 'gzcat', 'bunzip2', 'unxz')
_LOGIN_OK = ('docker', 'podman', 'buildah', 'skopeo', 'helm', 'crane', 'oras', 'nerdctl')

# name -> (flags that take a SEPARATE value word, positional words before the command)
_WRAPPERS = {
    'command': ((), 0), 'exec': (('-a',), 0), 'builtin': ((), 0), 'nohup': ((), 0),
    'time': (('-f', '-o', '--format', '--output'), 0), 'nice': (('-n', '--adjustment'), 0),
    'ionice': (('-c', '-n', '-p', '-P', '-u', '--class', '--classdata'), 0),
    'stdbuf': (('-i', '-o', '-e'), 0), 'setsid': ((), 0), 'caffeinate': (('-t', '-w'), 0),
    'unbuffer': ((), 0), 'timeout': (('-k', '-s', '--kill-after', '--signal'), 1),
    'xargs': (('-I', '-i', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs',
               '--delimiter', '--replace', '--arg-file', '--eof', '--max-lines'), 0),
    'parallel': (('-j', '-n', '-N', '-a', '--jobs', '--max-args'), 0),
    'flock': (('-w', '-E', '--timeout', '--conflict-exit-code'), 1),
    'sudo': (('-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R', '-T'), 0),
    'doas': (('-u', '-C'), 0), 'arch': (('-arch',), 0), 'chroot': ((), 1),
    'script': ((), 0), 'watch': (('-n', '-d', '-w', '--interval'), 0),
}
_CODE_WRAPPER_FLAGS = ('-c', '--command')   # su -c / script -c / runuser -c  (a command STRING)


def _base(w):
    return os.path.basename(w.text).lower()


def _strip_head(words):
    i = 0
    while i < len(words) and words[i].text in _KEYWORDS and not words[i].quoted:
        i += 1
    return words[i:]


def resolve_call(words):
    """(name, args, via) after stepping over keywords, wrappers, env assignments.
    `via` is the set of wrapper names crossed. name None = nothing to run."""
    words = _strip_head(words)
    via = set()
    for _ in range(12):
        if not words:
            return None, None, [], via
        name = _base(words[0])
        if name == 'env':
            i = 1
            while i < len(words):
                t = words[i].text
                if t in ('-u', '--unset', '-C', '--chdir', '-P'):
                    i += 2
                elif t in ('-S', '--split-string'):
                    return 'env-S', words[0], words[i + 1:i + 2], via
                elif t.startswith('--split-string='):
                    return 'env-S', words[0], [Word(t.split('=', 1)[1])], via
                elif t.startswith('-S') and len(t) > 2:
                    return 'env-S', words[0], [Word(t[2:])], via
                elif t.startswith('-') or _ASSIGN.match(t):
                    i += 1
                else:
                    break
            via.add('env')
            words = words[i:]
            continue
        if name in _WRAPPERS:
            flags, npos = _WRAPPERS[name]
            via.add(name)
            i = 1
            while i < len(words) and words[i].text.startswith('-') and words[i].text != '--':
                t = words[i].text
                if name in ('su', 'script') and t in _CODE_WRAPPER_FLAGS:
                    return name + '-c', words[0], words[i + 1:i + 2], via
                i += 2 if t in flags else 1
            if i < len(words) and words[i].text == '--':
                i += 1
            i += npos
            if name in ('time',) and i < len(words) and re.fullmatch(r'[0-9.]+[smhd]?', words[i].text):
                i += 1
            words = words[i:]
            continue
        if name in ('su', 'runuser'):
            for k in range(1, len(words) - 1):
                if words[k].text in _CODE_WRAPPER_FLAGS:
                    return 'su-c', words[0], [words[k + 1]], via
            return None, None, [], via
        return name, words[0], words[1:], via
    raise InspectionLimit('a chain of more than 12 wrappers')


def _dequote_flag_args(args):
    return [a for a in args]


def _is_cli_name(base_no_ext):
    return base_no_ext in CLI_NAMES or any(base_no_ext.startswith(p) for p in CLI_PREFIXES)


_EXTS = ('.ts', '.js', '.mjs', '.cjs', '.mts', '.cts', '.tsx', '.jsx', '.sh', '.bash', '.py')


def _script_stem(text):
    b = os.path.basename(text)
    low = b.lower()
    for e in _EXTS:
        if low.endswith(e):
            return low[:-len(e)]
    return low


def _word_hits_cli(word, cwd):
    """True when a script-position word names the CLI -- also through shell globs."""
    for alt in word.alts:
        if _is_cli_name(_script_stem(alt)):
            return True
        if any(c in alt for c in '*?['):
            try:
                hits = glob.glob(alt if os.path.isabs(alt) else os.path.join(cwd, alt))
            except Exception:
                hits = []
            for h in hits[:MAX_GLOB_HITS]:
                if _is_cli_name(_script_stem(h)):
                    return True
    return False


def _after_cli(args):
    """The arguments after the CLI name; `list` alone is the one read-only form."""
    rest = [a.text for a in args if a.text != '--']
    return rest


def _cli_decision(rest, state):
    if len(rest) == 1 and rest[0] == 'list':
        return
    if state.isolated_cli:      # MARVEEN_STORE_DIR points at a throw-away store: not the live logins
        return
    sub = rest[0] if rest else '(nincs alparancs)'
    raise Deny('dashboard-user / security-reset hivas (alparancs: %s). Ez a gep break-glass belepoje: '
               'kozvetlenul SQLite-ot ir, HTTP es hitelesites nelkul, ezert agensnek nem engedett. '
               'Egyedul a csak olvaso `list` engedett.' % sub[:40])


# ---- SQL / code ---------------------------------------------------------------------

_T = '(?:' + '|'.join(sorted(AUTH_TABLES, key=len, reverse=True)) + ')'
# Block comments are cut out first by _strip_block_comments (one linear pass), so the separator
# between a verb and the table name is whitespace or a `--` line comment: no lazy `.*?` scan.
_SQL_SEP = r'(?:\s|--[^\n]*\n)+'
# SQLite also takes a 'single-quoted' string as an identifier, and allows comments around the dot.
_TBL = (r'(?:(?:"[^"]*"|\'[^\']*\'|`[^`]*`|\[[^\]]*\]|\w+)(?:\s|--[^\n]*\n)*\.(?:\s|--[^\n]*\n)*)?'
        r'["\'`\[]?' + _T + r'["\'`\]]?(?![\w$])')
SQL_WRITE = re.compile(
    r'(?<![\w$])(?:insert' + _SQL_SEP + r'(?:or' + _SQL_SEP + r'\w+' + _SQL_SEP + r')?into'
    r'|replace' + _SQL_SEP + r'into'
    r'|update(?:' + _SQL_SEP + r'or' + _SQL_SEP + r'\w+)?'
    r'|delete' + _SQL_SEP + r'from'
    r'|drop' + _SQL_SEP + r'(?:table|view|trigger|index)(?:' + _SQL_SEP + r'if' + _SQL_SEP + r'exists)?'
    r'|alter' + _SQL_SEP + r'table'
    r'|truncate(?:' + _SQL_SEP + r'table)?'
    r'|rename' + _SQL_SEP + r'to'
    r')' + _SQL_SEP + _TBL,
    re.I | re.S)
# PRAGMA writable_schema turns the schema table into ordinary rows: refused on the live DB in any form.
# The schema can also be made writable from code (DBCONFIG_WRITABLE_SCHEMA through setconfig, opcode 1011),
# any mention of these on the live DB is refused (sqlite_dbpage is a protected table: reads pass, writes do not).
SQL_SCHEMA_TAMPER = re.compile(r'writable_schema|\bset_?config\b|\bdb_config\b|using\s+sqlite_dbpage\b', re.I)
SQL_DOT_WRITE = re.compile(r'(?m)^\s*\.(?:im(?:p(?:o(?:r(?:t)?)?)?)?|res(?:t(?:o(?:r(?:e)?)?)?)?)\b.*$', re.I)
SQL_DOT_SHELL = re.compile(r'(?m)^\s*\.(?:sh(?:e(?:l(?:l)?)?)?|sy(?:s(?:t(?:e(?:m)?)?)?)?)\b', re.I)
SQL_ATTACH = re.compile(r"attach(?:\s+database)?\s+(?:'([^']*)'|\"([^\"]*)\"|(\S+))", re.I)
SQL_DOT_OPEN = re.compile(r'(?m)^\s*\.op(?:e(?:n)?)?\s+(?:--\w+\s+)*(\S+)', re.I)
SQL_DOT_READ = re.compile(r'(?m)^\s*\.rea(?:d)?\s+(\S+)', re.I)

APP_MUTATORS = re.compile(
    r'\b(?:createDashboardUser|updateDashboardUserPassword|updateDashboardUser|deleteDashboardUser'
    r'|securityReset|insertDeviceKey|deleteDeviceKeyByHash|deleteDeviceKeyById|deleteAllDeviceKeys'
    r'|setDeviceKeyTenant|enrollDashboardApiToken|insertApiToken|revokeApiTokensForAgent'
    r'|revokeApiToken|rotateApiToken|revokeAllForUser|revokeAllSessions|issueEnrollCode'
    r'|consumeEnrollCode)\b|password-hash(?:\.js)?[\'"]')
EXEC_API = re.compile(
    r'subprocess|os\.(?:system|popen|exec\w*|spawn\w*)|child_process|execSync|spawnSync|execFileSync'
    r'|\bPopen\b|\bexecFile|Deno\.(?:run|Command)|Bun\.(?:spawn|\$)|\bsystem\s*\(|\bexec\s*\('
    r'|shell_exec|passthru|%x[\{\(\[]|IO\.popen')
# The CLI named the way it is RUN (a runner word in front, a path under scripts/, or the name as a
# whole quoted argv element), not as prose: a status message that mentions it is not an invocation.
CLI_MARKER = re.compile(
    r'(?:npm|pnpm|yarn|npx|tsx|ts-node|node|bun|bunx|deno)\b[^\n]{0,80}?dashboard[-_]user(?![\w-])'
    r'|scripts/dashboard-user(?![\w-])|[\'"]dashboard-user(?:\.[jt]s)?[\'"]'
    r'|security[-_:]reset|sessions:clear|--password-stdin')


def _strip_block_comments(text):
    """`/* ... */` replaced by one space, in ONE linear pass (an unclosed `/*` is left alone: once
    a `*/` is missing, none after it can close either, so the search is not repeated)."""
    if '/*' not in text:
        return text
    out = []
    i = 0
    while True:
        j = text.find('/*', i)
        if j == -1:
            out.append(text[i:])
            break
        k = text.find('*/', j + 2)
        if k == -1:
            out.append(text[i:])
            break
        out.append(text[i:j])
        out.append(' ')
        i = k + 2
    return ''.join(out)


# `CREATE TRIGGER name ... ON <table>`: the header is searched in a bounded window after the verb, on
# its own (a `;` can sit in a quoted trigger name, so the window does not stop there).
TRIGGER_HEAD = re.compile(r'(?<![\w$])create' + _SQL_SEP + r'(?:(?:temp|temporary)' + _SQL_SEP + r')?trigger(?![\w$])', re.I)
TRIGGER_ON = re.compile(r'(?<![\w$])on' + _SQL_SEP + _TBL, re.I)
TRIGGER_ANY_ON = re.compile(r'(?<![\w$])on(?![\w$])', re.I)


def _trigger_write(text):
    n = 0
    for m in TRIGGER_HEAD.finditer(text):
        n += 1
        if n > MAX_TRIGGER_HEADS:
            raise InspectionLimit('more than %d CREATE TRIGGER in one text' % MAX_TRIGGER_HEADS)
        window = text[m.end():m.end() + TRIGGER_WINDOW]
        mo = TRIGGER_ON.search(window)
        if mo:
            return 'create trigger ... ' + re.sub(r'\s+', ' ', mo.group())[:40]
        # No ON within the window although the text goes on: a header too long to read is not let through.
        if len(text) - m.end() > TRIGGER_WINDOW and not TRIGGER_ANY_ON.search(window):
            return 'create trigger (a fejlec nem er veget a vizsgalt tartomanyon belul)'
    return None


def _sql_write_summary(text):
    """What in `text` writes an auth table (a short description), or None. The text is looked at as it
    stands AND with its `/* */` comments cut out: a `/*` inside a string literal can make the cutting
    swallow a real write, and a comment between the verb and the table name hides it from the raw view."""
    stripped = _strip_block_comments(text)
    views = (text,) if stripped is text else (text, stripped)
    for t in views:
        m = SQL_WRITE.search(t)
        if m:
            return re.sub(r'\s+', ' ', m.group())[:60]
        if SQL_SCHEMA_TAMPER.search(t):
            return 'writable schema (writable_schema / setconfig)'
        r = _trigger_write(t)
        if r:
            return r
    return None


def inspect_sql(text, live):
    if SQL_DOT_SHELL.search(text):
        raise Deny('sqlite3 .shell / .system: tetszoleges parancs a kapu mogott, nem engedett.')
    hit = _sql_write_summary(text) if live else None
    if live and (hit or SQL_DOT_WRITE.search(text)):
        raise Deny('iras a hitelesito tablakra (%s) az elo store DB-n. A bejelentkezes, session, token '
                   'es jovahagyas allapotat csak a dashboard allitja.' % (hit or '.import / .restore'))


def inspect_code(text, state, python=False):
    """Interpreter code (python -c, node -e, a heredoc to python/node, ...). The path of a
    database is not visible here, so a write to an auth table is blocked wherever it points.
    The app's own mutators are TypeScript names: python cannot call them, so in python code they
    are only text (a source edit with s.replace(...)) and are not looked for."""
    hit = _sql_write_summary(text)
    if hit:
        raise Deny('iras a hitelesito tablakra interpreter-kodbol (%s).' % hit)
    m = None if python else APP_MUTATORS.search(text)
    if m:
        raise Deny('az alkalmazas hitelesitest modosito fuggvenye interpreter-kodbol (%s).'
                   % m.group()[:40])
    if CLI_MARKER.search(text) and EXEC_API.search(text):
        raise Deny('interpreter-kod, ami a dashboard-user / security-reset parancsot inditja.')
    # the code may also hold a plain shell line (osascript, perl system(...)): look at it as a command
    for mm in re.finditer(r'(?:do shell script|do script|keystroke)\s+"((?:\\.|[^"\\])*)"', text):
        check_command(mm.group(1).replace('\\"', '"').replace('\\\\', '\\'), state, 1)


def _db_is_live(path_word, state):
    """True = the live store (or cannot be resolved). A copy elsewhere = False."""
    if path_word is None or path_word.dyn:
        return True
    p = path_word.text
    if p in ('', ':memory:') or p.startswith('file::memory:'):
        return False
    if p.startswith('file:'):
        p = p[5:].split('?', 1)[0]
    if _has_placeholder(p):
        return True          # part of the path comes out of a $(...) / `...`: not knowable
    reals = _candidate_paths(p, state)
    if reals is None:
        return True          # a cd / pushd / env -C ... or an ln in the command: the directory is unknown
    for real in reals:
        if _in_store_dir(real, state) or _is_live_inode(real, state, True):
            return True
    return False


def _has_placeholder(text):
    """The lexer leaves '$(...)' / '`...`' / '<(...)' in a word whose text came out of a substitution."""
    return '$(...)' in text or '`...`' in text or '<(...)' in text or '$((...))' in text


def _candidate_paths(p, state, links=True):
    """The real paths the path text `p` can name when the command line runs. A relative path is
    resolved against the event cwd and against every ABSOLUTE `cd` target in the command line (the
    union over-approximates: it can only block more). None = cannot be told: another kind of
    directory change (cd to a relative / dynamic target, pushd, env -C, ...), or an `ln` in the same
    command line whose link name is, or lies above, the path (a link made there does not exist yet when
    the gate looks; an `ln` elsewhere does not matter)."""
    if links and state.link_global:
        return None
    try:
        if os.path.isabs(p):
            reals = [os.path.realpath(p)]
        elif state.dir_changed:
            return None
        else:
            reals = [os.path.realpath(os.path.join(c, p)) for c in [state.cwd] + state.cd_targets]
    except Exception:
        return None
    if links and state.link_dests and any(_link_hits(r, state) for r in reals):
        return None
    return reals


def _link_hits(real, state, below=False):
    """True when the (resolved) path `real` is, or lies under, a link name an `ln` of this command line
    creates: the link is not there yet, so realpath cannot follow it. With `below` a link name that lies
    INSIDE the directory `real` counts too (a link dropped into a store dir)."""
    if state.link_global:
        return True
    for d in state.link_dests:
        if os.path.isabs(d):
            bases = [d]
        elif state.dir_changed:
            return True
        else:
            bases = [os.path.join(c, d) for c in [state.cwd] + state.cd_targets]
        for b in bases:
            b = b.rstrip('/') or '/'
            try:
                named = os.path.join(os.path.realpath(os.path.dirname(b)), os.path.basename(b))
                there = os.path.realpath(b)
            except Exception:
                return True
            for x in (named, there):
                if real == x or real.startswith(x.rstrip('/') + os.sep):
                    return True
                if below and x.startswith(real.rstrip('/') + os.sep):
                    return True
    return False


# The file names of a SQLite database and its sidecars; the live store dir holds them.
_DB_FILE_RE = re.compile(r'(?:\.db|\.sqlite3?)(?:-wal|-shm|-journal)?$|^claudeclaw', re.I)


def _looks_db(text):
    return bool(_DB_FILE_RE.search(os.path.basename(text.rstrip('/'))))


def _live_inodes(state):
    """(st_dev, st_ino) of claudeclaw.db, its -wal / -shm and every *.db / *.db-wal / *.db-shm
    directly inside a live store dir (bounded: MAX_STORE_SCAN entries scanned, MAX_LIVE_INODES kept).
    A hard link elsewhere is the SAME file under another name; realpath cannot see that."""
    if state.live_inodes is not None:
        return state.live_inodes
    out = set()
    for d in _store_dirs(state):
        for nm in ('claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm'):
            try:
                st = os.stat(os.path.join(d, nm))
                out.add((st.st_dev, st.st_ino))
            except OSError:
                pass
        try:
            with os.scandir(d) as it:
                seen = 0
                for e in it:
                    seen += 1
                    if seen > MAX_STORE_SCAN or len(out) >= MAX_LIVE_INODES:
                        break
                    if _DB_FILE_RE.search(e.name):
                        try:
                            st = e.stat()
                            out.add((st.st_dev, st.st_ino))
                        except OSError:
                            pass
        except OSError:
            pass
    state.live_inodes = out
    return out


def _is_live_inode(real, state, nlink_rule):
    """True when the existing regular file at `real` (already resolved) is one of the live store's
    database files under another name (same device + inode), or - nlink_rule - has more than one
    hard link at all: a database file with a second name somewhere is treated as live."""
    try:
        st = os.stat(real)
    except (OSError, ValueError):
        return False
    if not stat.S_ISREG(st.st_mode):
        return False
    if (st.st_dev, st.st_ino) in _live_inodes(state):
        return True
    return bool(nlink_rule and st.st_nlink > 1)


def _dir_shares_live_files(real, state):
    """A throw-away store dir that holds a database file which is really the live one (a hard link, or
    a symlink to it) or any database file with more than one name is NOT a throw-away store. A dir too
    big to list within MAX_STORE_SCAN entries cannot be vouched for either."""
    try:
        with os.scandir(real) as it:
            seen = 0
            for e in it:
                seen += 1
                if seen > MAX_STORE_SCAN:
                    return True
                if _DB_FILE_RE.search(e.name) and _is_live_inode(os.path.realpath(e.path), state, True):
                    return True
    except OSError:
        return False        # the dir does not exist (yet): the app creates a fresh store there
    return False


def _store_dirs(state):
    if state.store_dirs is not None:
        return state.store_dirs
    dirs = set()
    for root in (_install_root(), os.environ.get('CLAUDE_PROJECT_DIR'), os.path.dirname(os.path.dirname(_hooks_dir()))):
        if root:
            dirs.add(os.path.realpath(os.path.join(root, 'store')))
    sd = os.environ.get('MARVEEN_STORE_DIR')
    if sd:
        dirs.add(os.path.realpath(sd))
    cur = os.path.realpath(state.cwd)
    for _ in range(12):
        if os.path.exists(os.path.join(cur, 'store', 'claudeclaw.db')):
            dirs.add(os.path.join(cur, 'store'))
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    state.store_dirs = dirs
    return dirs


def _in_store_dir(real, state):
    for d in _store_dirs(state):
        if real == d or real.startswith(d + os.sep):
            return True
    return False


def _read_text_file(path, state, max_bytes=MAX_SCRIPT_BYTES):
    p = path if os.path.isabs(path) else os.path.join(state.cwd, path)
    try:
        real = os.path.realpath(p)
        if real in state.seen_files or not os.path.isfile(real):
            return None
        if os.path.getsize(real) > max_bytes:
            return None
        state.seen_files.add(real)
        with open(real, 'r', encoding='utf-8', errors='replace') as f:
            return f.read(max_bytes)
    except Exception:
        return None


def _producer_text(seg, state):
    """What the previous pipeline stage literally prints, when we can tell (echo / printf /
    cat FILE). A decoder in front of the consumer is refused outright."""
    texts = []
    prev = seg.prev
    if prev is None:
        return texts
    name, _cw, args, _via = resolve_call(prev.words)
    if name in ('echo', 'printf', 'print'):
        words = [a.text for a in args if not a.text.startswith('-') or len(a.text) > 2]
        # printf prints its arguments on separate lines (format string aside): one line each
        texts.append('\n'.join(words) if name == 'printf' else ' '.join(words))
    elif name == 'cat':
        for a in args:
            if not a.text.startswith('-'):
                t = _read_text_file(a.text, state)
                if t:
                    texts.append(t)
        for body, _q in prev.heredocs:
            texts.append(body)
    elif name in _DECODERS:
        raise Opaque()
    # a decoder further up the same pipeline
    p = prev.prev
    hops = 0
    while p is not None and hops < 8:
        n2, _c2, _a, _v = resolve_call(p.words)
        if n2 in _DECODERS:
            raise Opaque()
        p = p.prev
        hops += 1
    return texts


def _stdin_texts(seg, state):
    texts = [b for b, _q in seg.heredocs] + list(seg.herestr)
    for f in seg.stdin_files:
        t = _read_text_file(f, state)
        if t:
            texts.append(t)
    texts.extend(_producer_text(seg, state))
    return texts


def check_shell_script(text, state, depth):
    check_command(text, state, depth + 1)


def _handle_shell(name, args, seg, state, depth):
    i = 0
    script = None
    while i < len(args):
        t = args[i].text
        if t == '--':
            i += 1
            break
        if t.startswith('--'):
            if t == '--command' and i + 1 < len(args):
                script = args[i + 1]
                i += 2
                break
            i += 2 if t in ('--rcfile', '--init-file') else 1
            continue
        if t.startswith('-') and len(t) > 1:
            if 'c' in t[1:] and not t.startswith('-o'):
                if i + 1 < len(args):
                    script = args[i + 1]
                i += 2
                break
            i += 2 if t[-1] in 'oO' else 1
            continue
        break
    if script is not None:
        for alt in script.alts:
            check_command(alt, state, depth + 1)
        return
    if i < len(args):                       # bash FILE
        if _word_hits_cli(args[i], state.cwd):          # bash scripts/security-reset.sh
            _cli_decision(_after_cli(args[i + 1:]), state)
        txt = _read_text_file(args[i].text, state)
        if txt is not None:
            check_shell_script(txt, state, depth)
        return
    for t in _stdin_texts(seg, state):       # script on stdin
        check_command(t, state, depth + 1)


def _handle_interp(name, args, seg, state, depth, kind):
    code = []
    i = 0
    flagset = {'python': ('-c',), 'node': ('-e', '--eval', '-p', '--print'),
               'perl': ('-e', '-E'), 'ruby': ('-e',), 'php': ('-r',), 'lua': ('-e',),
               'osascript': ('-e',)}[kind]
    while i < len(args):
        t = args[i].text
        if t in flagset or (kind == 'python' and re.fullmatch(r'-[A-Za-z]*c', t)):
            if i + 1 < len(args):
                code.append(args[i + 1].text)
            i += 2
            continue
        if t.startswith('--eval=') or t.startswith('--print='):
            code.append(t.split('=', 1)[1])
        i += 1
    for c in code:
        inspect_code(c, state, kind == 'python')
    if not code:
        for t in _stdin_texts(seg, state):
            inspect_code(t, state, kind == 'python')


def _positional(args, value_flags):
    """Positional (non-flag) words of an argument list; flags in value_flags eat the next word."""
    out = []
    i = 0
    while i < len(args):
        t = args[i].text
        if t == '--':
            out.extend(args[i + 1:])
            break
        if t.startswith('-') and len(t) > 1:
            i += 2 if t in value_flags else 1
            continue
        out.append(args[i])
        i += 1
    return out


_NODE_VALUE_FLAGS = ('-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions',
                     '-C', '--input-type', '--env-file', '--title', '--stack-size', '--inspect-port',
                     '--tsconfig', '--cwd', '--project', '-P', '--eval', '-e', '-p', '--print',
                     '--allow-read', '--allow-write', '--config', '-c')


def _runner_script_hit(args, state):
    """node/tsx/ts-node/bun/deno/...: the script word (first positionals) names the CLI."""
    pos = _positional(args, _NODE_VALUE_FLAGS)
    # the script is the first positional; a runner sub-command (bun run X, deno run X, tsx watch X,
    # vite-node X) puts it second. A later word that merely carries the name is an argument.
    spots = [0]
    if len(pos) > 1 and pos[0].text in ('run', 'watch', 'exec', 'task', 'x', 'serve'):
        spots.append(1)
    for k in spots:
        if k < len(pos) and _word_hits_cli(pos[k], state.cwd):
            return pos[k + 1:]
    return None


def _handle_node(name, args, seg, state, depth):
    if any(a.text in ('--check', '-c') for a in args) and name in ('node', 'nodejs'):
        return
    rest = _runner_script_hit(args, state)
    if rest is not None:
        _cli_decision(_after_cli(rest), state)
    if name == 'deno':          # deno eval "code": the code is the positional after the sub-command
        pos = _positional(args, ('--ext', '-c', '--config', '--import-map', '--tsconfig', '--location',
                                 '--seed', '--v8-flags', '--cert', '--env-file'))
        if len(pos) > 1 and pos[0].text == 'eval':
            inspect_code(pos[1].text, state, False)
    _handle_interp(name, args, seg, state, depth, 'node')


_NPM_VALUE_FLAGS = ('--prefix', '-C', '-w', '--workspace', '--cwd', '--registry', '--userconfig',
                    '--loglevel', '--cache', '--script-shell', '-p', '--package', '-c', '--call')


def _handle_npm_like(name, args, seg, state, depth):
    """npm / pnpm / yarn / bun run SCRIPT, npx / bunx / pnpm dlx|exec / npm exec|x PACKAGE ..."""
    pos = _positional(args, _NPM_VALUE_FLAGS)
    # npx -c "command string" / npm exec -c "..."
    for k, a in enumerate(args):
        if a.text in ('-c', '--call') and k + 1 < len(args):
            for alt in args[k + 1].alts:
                check_command(alt, state, depth + 1)
    if name in ('npx', 'pnpx', 'bunx'):
        sub, rest = None, pos
    elif pos and pos[0].text in ('run', 'run-script', 'rum', 'urn'):
        scr = pos[1:2]
        if scr:
            w = scr[0]
            if w.dyn and not name == 'bun':
                raise Deny('npm run egy futasidoben kepzett script-nevvel: a kapu nem tudja eldonteni, '
                           'hogy a dashboard-user-e, ezert nem engedi at.')
            if _word_hits_cli(w, state.cwd):
                _cli_decision(_after_cli(_args_after(args, w)), state)
        return
    elif pos and pos[0].text in ('exec', 'x', 'dlx'):
        sub, rest = pos[0].text, pos[1:]
    elif name in ('yarn', 'pnpm') and pos:
        # yarn dashboard-user / pnpm dashboard-user  (they run package scripts without "run")
        if _word_hits_cli(pos[0], state.cwd):
            _cli_decision(_after_cli(_args_after(args, pos[0])), state)
            return
        sub, rest = None, []
    elif name == 'bun' and pos:
        if _word_hits_cli(pos[0], state.cwd):
            _cli_decision(_after_cli(_args_after(args, pos[0])), state)
            return
        sub, rest = None, []
    else:
        return
    if not rest:
        return
    pkg = rest[0]
    if _word_hits_cli(pkg, state.cwd):
        _cli_decision(_after_cli(_args_after(args, pkg)), state)
        return
    # npx tsx scripts/dashboard-user.ts ...  -> the package is itself a runner / interpreter
    inner = [pkg] + rest[1:]
    check_words(inner, seg, state, depth)


def _args_after(args, word):
    for k, a in enumerate(args):
        if a is word:
            return args[k + 1:]
    return []


def _handle_sql_client(name, args, seg, state, depth):
    value_flags = ('-cmd', '-init', '-separator', '-newline', '-nullvalue', '-vfs', '-mmap', '-column',
                   '-d', '--dbname', '-c', '--command', '-f', '--file', '-h', '-p', '-U', '-W')
    pos = _positional(args, value_flags)
    dbword = pos[0] if pos else None
    texts = [w.text for w in pos[1:]]
    for k, a in enumerate(args):
        if a.text in ('-cmd', '-c', '--command', '-e', '-s') and k + 1 < len(args):
            texts.append(args[k + 1].text)
        if a.text in ('-f', '--file') and k + 1 < len(args):
            t = _read_text_file(args[k + 1].text, state)
            if t:
                texts.append(t)
    # the single positional of psql/mysql can be a database name, not a path: treat it as unresolvable
    if name in ('psql', 'pgcli', 'usql', 'mysql', 'sqlcmd', 'clickhouse-client', 'duckdb'):
        live = True
    elif name == 'sqlite-utils':
        live = _db_is_live(pos[1] if len(pos) > 1 else None, state)
        texts = [w.text for w in args]
    else:
        live = _db_is_live(dbword, state) if dbword is not None else False   # no file = a transient DB
    try:
        texts.extend(_stdin_texts(seg, state))
    except Opaque:
        if live:
            raise Deny('dekodolt (base64/xxd/gunzip/...) tartalom az elo store DB-t kezelo SQL kliensbe: a '
                       'dekodolt SQL nem ellenorizheto.')
    k = 0
    while k < len(texts) and k < 64:       # .read FILE adds that file's text (nested, bounded)
        for m in SQL_DOT_READ.finditer(texts[k]):
            tt = _read_text_file(m.group(1), state)
            if tt:
                texts.append(tt)
        k += 1
    # one session: a .open / ATTACH of the live store in ANY of the texts makes the whole session live
    eff = live
    for t in texts:
        for m in SQL_DOT_OPEN.finditer(t):
            if _db_is_live(Word(m.group(1).strip('\'"')), state):
                eff = True
        for m in SQL_ATTACH.finditer(t):
            target = m.group(1) or m.group(2) or m.group(3) or ''
            if target and (target.startswith('$') or _db_is_live(Word(target), state)):
                eff = True
    for t in texts:
        inspect_sql(t, eff)
        if name in ('sqlite3', 'sqlite', 'litecli', 'sqlite-utils'):
            _inspect_sql_targets(t, state)


def _handle_find(args, seg, state, depth):
    k = 0
    while k < len(args):
        if args[k].text in ('-execdir', '-okdir'):
            state.dir_changed = True       # find runs the command inside the directory of each hit
        if args[k].text in ('-fprint', '-fprint0', '-fprintf', '-fls') and k + 1 < len(args):
            if _live_path(args[k + 1], state):
                _deny_live_write('find %s %s' % (args[k].text, args[k + 1].text))
        if args[k].text in ('-exec', '-execdir', '-ok', '-okdir'):
            j = k + 1
            while j < len(args) and args[j].text not in (';', '+', '\\;'):
                j += 1
            check_words(args[k + 1:j], seg, state, depth)
            k = j
        k += 1


_TMUX_CMDS = ('send-keys', 'send', 'run-shell', 'run', 'new-session', 'new', 'new-window', 'neww',
              'split-window', 'splitw', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw',
              'pipe-pane', 'pipep', 'if-shell', 'if', 'display-popup', 'popup')


def _handle_tmux(args, state, depth):
    pos = _positional(args, ('-t', '-c', '-F', '-n', '-x', '-y', '-e', '-s', '-N', '-d', '-f'))
    if not pos or pos[0].text not in _TMUX_CMDS:
        return
    rest = [w.text for w in pos[1:]]
    if rest:
        state.dir_changed = True           # the pane / window has its own working directory
        check_command(' '.join(rest), state, depth + 1)
        for r in rest:
            check_command(r, state, depth + 1)


def _handle_ssh(args, seg, state, depth):
    pos = _positional(args, ('-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-e', '-E',
                             '-I', '-m', '-O', '-Q', '-S', '-W', '-w'))
    if len(pos) >= 2:
        state.dir_changed = True           # the remote shell starts in its own home directory
        check_command(' '.join(w.text for w in pos[1:]), state, depth + 1)
    elif seg is not None:                      # ssh host <<EOF ... EOF : the body is the remote shell
        state.dir_changed = True
        for t in _stdin_texts(seg, state):
            check_command(t, state, depth + 1)


def _isolated_store(seg, words, cmdword, state):
    """True when THIS command runs with MARVEEN_STORE_DIR set (inline `VAR=x cmd`, `env VAR=x cmd`, or
    an earlier `export`/assignment in the same command line) to a directory that is not the live
    store. The app and the CLI read their database from it, so the logins they touch are a QA
    instance's own. A value the gate cannot resolve (an unset variable, a substitution) is NOT isolated."""
    val = None
    if seg is not None:
        for name, v in seg.assigns:
            if name == 'MARVEEN_STORE_DIR':
                val = v
    for w in words:
        if w is cmdword:
            break
        if w.text.startswith('MARVEEN_STORE_DIR='):
            val = w.text.split('=', 1)[1]
    if val is None:
        val = state.vars.get('MARVEEN_STORE_DIR')
    if not val or '$' in val or '`' in val:
        return False
    if state.link_global:
        return False           # a link made in this very command, and we cannot tell where
    if not os.path.isabs(val):
        if state.dir_changed or state.cd_targets:
            return False       # relative, and a cd / env -C ... is in the command: not isolated (fail closed)
        val = os.path.join(state.cwd, val)
    try:
        real = os.path.realpath(val)
    except Exception:
        return False
    if state.link_dests and _link_hits(real, state, True):
        return False           # the dir is, lies under, or receives a link made in this very command
    for d in _store_dirs(state):
        if real == d or real.startswith(d + os.sep) or d.startswith(real + os.sep):
            return False       # the live store, inside it, or a parent that contains it
    if _dir_shares_live_files(real, state):
        return False           # a database file in there is the live one under another name
    return True


# ---- directory changes: a relative path is only meaningful while the cwd is the event cwd ----

def _note_link(args, state):
    """Remember where an `ln` makes its link (the last word, the -t directory, or - with one word - that
    name in the cwd). A link name the gate cannot tell makes every path suspect (link_global)."""
    pos = _positional(args, _FW_VALUE_FLAGS['ln'])
    dest = None
    for k, a in enumerate(args):
        if a.text in ('-t', '--target-directory') and k + 1 < len(args):
            dest = args[k + 1]
        elif a.text.startswith('--target-directory='):
            dest = Word(a.text.split('=', 1)[1])
    if dest is None:
        if len(pos) >= 2:
            dest = pos[-1]
        elif len(pos) == 1:
            dest = Word(os.path.basename(pos[0].text.rstrip('/')), pos[0].dyn)
    if (dest is None or dest.dyn or not dest.text or _has_placeholder(dest.text)
            or len(state.link_dests) >= MAX_LINK_DESTS):
        state.link_global = True
        return
    state.link_dests.append(dest.text)


_CD_COMMANDS = ('cd', 'pushd', 'popd', 'chdir', 'chroot')
_DIR_FLAGS = ('-C', '--chdir', '--cwd', '--prefix', '--dir', '--directory', '-D', '-w', '--workspace',
              '--workspaces', '-F', '--filter')


def _note_dir_changes(segs, state):
    """Look at every command of this text BEFORE any is judged (a cd in a later segment, a subshell, a
    loop or a function body still changes what a relative path means). `cd /absolute/target` is
    recorded and followed exactly (state.cd_targets). Everything else that may change the directory
    (a relative or dynamic cd, pushd, popd, chdir, chroot, a command word the gate cannot read, a
    -C / --chdir / --cwd / --prefix / --directory / -D / -w flag on ANY command: env -C, sudo -D,
    git -C, make -C, npm --prefix ...) sets state.dir_changed: every relative path is then unknown.
    An `ln` sets state.link_made: a link created in the same command line is not there to resolve.
    The names of shell functions defined here (`f() {`, `function f {`) go to state.funcs."""
    for k, seg in enumerate(segs):
        ws = seg.words
        if len(ws) > 1 and ws[0].text == 'function':
            state.funcs.add(ws[1].text)
        elif (len(ws) == 1 and k + 1 < len(segs) and segs[k + 1].words
              and segs[k + 1].words[0].text == '{' and not ws[0].dyn):
            state.funcs.add(ws[0].text)
    for seg in segs:
        if not seg.words:
            continue
        name, cmdword, args, _via = resolve_call(seg.words)
        if name is None:
            continue
        if name in ('ln', 'link'):
            state.link_made = True
            _note_link(args, state)
        if name == 'cd':
            pos = [a for a in args if a.text not in ('-P', '-L', '-e', '-@', '--')]
            tgt = pos[0] if len(pos) == 1 else None
            if (tgt is not None and not tgt.dyn and not _has_placeholder(tgt.text) and os.path.isabs(tgt.text)
                    and len(state.cd_targets) < MAX_CD_TARGETS):
                try:
                    state.cd_targets.append(os.path.realpath(tgt.text))
                except Exception:
                    state.dir_changed = True
            else:
                state.dir_changed = True
            continue
        if name in _CD_COMMANDS or (cmdword is not None and cmdword.dyn):
            state.dir_changed = True
            continue
        for w in seg.words:
            t = w.text
            if (t in _DIR_FLAGS or (t.startswith('--') and t.split('=', 1)[0] in _DIR_FLAGS)
                    or (len(t) > 2 and t[:2] in ('-C', '-D'))):      # -Cdir / -D/dir attached
                state.dir_changed = True
                break


# ---- writing the live database file as a file --------------------------------------------

_FILE_WRITERS = ('cp', 'mv', 'ln', 'link', 'install', 'rsync', 'scp', 'ditto', 'dd', 'tee', 'sponge')
_FW_VALUE_FLAGS = {
    'cp': ('-t', '--target-directory', '-S', '--suffix'),
    'mv': ('-t', '--target-directory', '-S', '--suffix'),
    'ln': ('-t', '--target-directory', '-S', '--suffix'),
    'install': ('-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group'),
    'rsync': ('-e', '--rsh', '--exclude', '--include', '-f', '--filter', '--exclude-from', '--include-from',
              '--files-from', '--link-dest', '--copy-dest', '--compare-dest', '--backup-dir', '--partial-dir',
              '--log-file', '--bwlimit', '-B', '--port', '--rsync-path', '--chmod', '--chown', '--temp-dir',
              '-T', '--timeout', '--suffix', '-M'),
    'scp': ('-P', '-i', '-o', '-F', '-J', '-S', '-c', '-l'),
}
# The files of the live database by NAME: the app reads them whether or not they exist yet.
_LIVE_DB_NAMES = ('claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm', 'claudeclaw.db-journal')
# A dynamic (unresolved) target only counts when the text that IS known says "the store": the app and
# the scheduled tasks keep state files in the same directory, and a QA script's `$S/claudeclaw.db` is
# its own copy, so a bare variable in front is not enough.
_DYN_LIVE_HINT = re.compile(
    r'(?:^|/)store(?:/(?:claudeclaw[^/]*|[^/]*\.db(?:-wal|-shm|-journal)?)?)?/?$', re.I)


def _live_path(word, state, hint=False, rel_live=False, source=False):
    """True when writing `word` as a file would write the live database: one of the live DB files by
    name (claudeclaw.db, -wal, -shm, -journal directly in a live store dir), by inode (a hard link, a
    symlink, any other *.db there), or the store dir itself when `hint` says the operation involves a
    database file (cp into it, mv of it). Other files in the store dir (state json, logs) are the
    app's and the scheduled tasks' own business. When the path cannot be resolved (see
    _candidate_paths) it counts as live when it looks like a database file, when `hint` says the
    operation involves one and the path names a directory, or always with `rel_live`."""
    p = word.text
    if not p:
        return False
    if word.dyn or _has_placeholder(p):
        return bool(_DYN_LIVE_HINT.search(p))
    reals = _candidate_paths(p, state, False)
    if reals is None:
        dirish = os.path.basename(p.rstrip('/')) in ('', '.', '..', 'store')
        return rel_live or (hint and dirish) or _looks_db(p)
    dirs = _store_dirs(state)
    for real in reals:
        if _is_live_inode(real, state, _looks_db(real)):
            return True
        if real in dirs and hint:
            return True
        if source and os.path.isfile(real):
            continue           # an existing file that is not a live inode is a copy, whatever its name
        if os.path.basename(real) in _LIVE_DB_NAMES and (os.path.dirname(real) in dirs or _link_hits(real, state)):
            return True        # with an `ln` in the command a link may lead into the store: go by the name
    return False


def _deny_live_write(what):
    raise Deny('iras az elo store-ba (%s). Egy agens nem irhatja, nem cserelheti es nem linkelheti fajlkent '
               'az elo adatbazist (claudeclaw.db, -wal, -shm) vagy a store konyvtarat. Masolni INNEN valahova '
               '(QA masolat) szabad.' % what[-70:])


def _handle_filewrite(name, args, state):
    """cp / mv / ln / install / rsync / scp / ditto / dd / tee: the TARGET must not be the live store. A
    source in the live store is fine (a QA instance starts from a copy), except for mv (it moves the
    live file away under a running app) and for the hard-link makers (ln, cp -l, rsync --link-dest)."""
    if name == 'dd':
        for a in args:
            if a.text.startswith('of='):
                if _live_path(Word(a.text[3:], a.dyn), state):
                    _deny_live_write('dd of=' + a.text[3:])
        return
    pos = _positional(args, _FW_VALUE_FLAGS.get(name, ()))
    if name in ('tee', 'sponge'):
        for w in pos:
            if _live_path(w, state):
                _deny_live_write(name + ' ' + w.text)
        return
    targets, sources = [], pos
    explicit = None
    if name not in ('rsync', 'scp'):
        for k, a in enumerate(args):
            if a.text in ('-t', '--target-directory') and k + 1 < len(args):
                explicit = args[k + 1]
            elif a.text.startswith('--target-directory='):
                explicit = Word(a.text.split('=', 1)[1])
    if explicit is not None:
        targets = [explicit]
    elif len(pos) >= 2:
        targets, sources = [pos[-1]], pos[:-1]
    # a source that is (or may expand to) a database file, or a whole directory merged into the target
    src_hint = any(_looks_db(w.text) or w.text.endswith('/') or any(c in w.text for c in '*?[')
                   for w in sources)
    for t in targets:
        if _live_path(t, state, src_hint):
            _deny_live_write('%s -> %s' % (name, t.text))
    flags = [a.text for a in args if a.text.startswith('-') and not a.text.startswith('--')]
    if name == 'mv':
        for s in sources:
            if _live_path(s, state, True):
                _deny_live_write('mv av az elo adatbazist: ' + s.text)
    elif name in ('ln', 'link'):
        symbolic = any('s' in f[1:] for f in flags) or any(a.text == '--symbolic' for a in args)
        if not symbolic:
            for s in sources:
                if _live_path(s, state, True, True, source=True):
                    _deny_live_write('hardlink az elo store fajljara: ' + s.text)
    elif name == 'cp':
        if any('l' in f[1:] for f in flags) or any(a.text == '--link' for a in args):
            for s in sources:
                if _live_path(s, state, True, True, source=True):
                    _deny_live_write('cp -l (hardlink) az elo store fajljara: ' + s.text)
    elif name == 'rsync':
        for k, a in enumerate(args):
            val = None
            if a.text == '--link-dest' and k + 1 < len(args):
                val = args[k + 1]
            elif a.text.startswith('--link-dest='):
                val = Word(a.text.split('=', 1)[1])
            if val is not None and _live_path(val, state, True, True, source=True):
                _deny_live_write('rsync --link-dest az elo store-ra: ' + val.text)


_TARGET_WRITERS = frozenset(('rm', 'rmdir', 'unlink', 'shred', 'truncate', 'chmod', 'chown', 'chgrp', 'touch',
                            'sed', 'sort', 'tree', 'curl', 'wget', 'less', 'more'))
_TW_VALUE_FLAGS = {
    'truncate': ('-s', '--size', '-r', '--reference'), 'touch': ('-d', '-t', '-r', '--date', '--reference'),
    'shred': ('-n', '-s', '--iterations', '--size'),
}
# options that name an OUTPUT file: (short letters, long names)
_OUT_OPTS = {
    'sort': ('o', ('--output',)), 'tree': ('o', ()), 'less': ('oO', ('--log-file', '--LOG-FILE')), 'more': ('', ()),
    'curl': ('Dc', ('--output', '--dump-header', '--cookie-jar')) , 'wget': ('Hoa', ('--output-document', '--output-file', '--append-output')),
}
_SED_WRITE = re.compile(r'(?:^|[\s;{}/])[wW]\s*([^\s;}]+)')


def _out_values(name, args):
    """The words that name an output file in the arguments of sort -o, curl -o, wget -O, ..."""
    shorts, longs = _OUT_OPTS[name]
    out = []
    if name == 'curl':
        shorts += 'o'
    if name == 'wget':
        shorts += 'O'
    for k, a in enumerate(args):
        t = a.text
        if t == '--':
            break
        if t.startswith('--'):
            nm = t.split('=', 1)[0]
            if any(_long_abbrev(nm, f) for f in longs):
                if '=' in t:
                    out.append(Word(t.split('=', 1)[1], a.dyn))
                elif k + 1 < len(args):
                    out.append(args[k + 1])
        elif t.startswith('-') and len(t) > 1:
            for idx, ch in enumerate(t[1:], 1):
                if ch in shorts:
                    rest = t[idx + 1:]
                    if rest:
                        out.append(Word(rest, a.dyn))
                    elif k + 1 < len(args):
                        out.append(args[k + 1])
                    break
    return out


def _handle_target_writers(name, args, state):
    """rm / truncate / chmod / chown / touch, sed -i and `w FILE`, sort -o, curl -o, wget -O ...: the file
    they change must not be the live database (or, for rm / chmod / chown, its store directory)."""
    if name in ('rm', 'rmdir', 'unlink', 'shred', 'touch', 'chmod', 'chown', 'chgrp', 'truncate'):
        for w in _positional(args, _TW_VALUE_FLAGS.get(name, ())):
            if _live_path(w, state, name not in ('touch', 'truncate')):
                _deny_live_write('%s %s' % (name, w.text))
        return
    if name == 'sed':
        inplace = any((t.startswith('-') and not t.startswith('--') and 'i' in t[1:]) or
                      (t.startswith('--') and len(t) >= 4 and '--in-place'.startswith(t.split('=', 1)[0]))
                      for t in (a.text for a in args))
        if inplace:
            for w in _positional(args, ('-e', '-f', '-l', '--expression', '--file', '--line-length')):
                if _live_path(w, state):
                    _deny_live_write('sed -i ' + w.text)
        for a in args:
            for m in _SED_WRITE.finditer(a.text):
                if _live_path(Word(m.group(1)), state):
                    _deny_live_write('sed w ' + m.group(1))
        return
    for w in _out_values(name, args):
        if _live_path(w, state):
            _deny_live_write('%s -> %s' % (name, w.text))


SQL_DOT_ANY = re.compile(r'(?m)^[ \t]*\.([A-Za-z]+)([^\n]*)$')
# sqlite3 dot-commands that write a FILE; the shell takes any unambiguous prefix (`.outp`, `.bac`)
_SQL_DOT_FILE_OUT = ('backup', 'save', 'clone', 'output', 'once', 'excel', 'log', 'trace')
_SQL_DOT_TOKEN = re.compile(r"""'(?:[^']|'')*'|"[^"]*"|\S+""")
_SQL_WORD_VACUUM = re.compile(r'(?<![\w$])vacuum(?![\w$])', re.I)
_SQL_WORD_INTO = re.compile(r'into(?![\w$])', re.I)
_SQL_WORD_WRITEFILE = re.compile(r'(?<![\w$])["`\[\']?writefile["`\]\']?(?![\w$])', re.I)
_SQL_WORD_EDIT = re.compile(r'(?<![\w$])edit\s*\(', re.I)
MAX_SQL_FILE_FUNCS = 64


def _sql_skip(text, i):
    """Index of the first character at or after `i` that is neither blank nor inside a comment."""
    n = len(text)
    while i < n:
        if text[i].isspace():
            i += 1
        elif text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j == -1 else j + 1
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j == -1 else j + 2
        else:
            break
    return i


def _sql_ident_end(text, i):
    """End of the one SQL name at `i` (bare, "x", [x], `x` or 'x'), -1 when there is none."""
    if i >= len(text):
        return -1
    c = text[i]
    if c in '"`\'' or c == '[':
        j = text.find(']' if c == '[' else c, i + 1)
        return -1 if j == -1 else j + 1
    m = re.compile(r'[A-Za-z_][\w$]*').match(text, i)
    return m.end() if m else -1


def _sql_single_literal(text, i, closers):
    """The value of ONE string literal at `i` that is followed (after blanks and comments) by one of
    `closers` ('' = end of the text), else None: an expression, a `||` join, a parameter, a function
    call, ... is not a path the gate can read."""
    if i >= len(text) or text[i] not in '\'"':
        return None
    q = text[i]
    j = i + 1
    parts = []
    while True:
        k = text.find(q, j)
        if k == -1:
            return None
        parts.append(text[j:k])
        if text.startswith(q, k + 1):          # '' inside the literal
            parts.append(q)
            j = k + 2
            continue
        break
    e = _sql_skip(text, k + 1)
    nxt = text[e:e + 1]
    if nxt not in closers:
        return None
    return ''.join(parts)


_SQL_DOT_LINE = re.compile(r'[ \t]*\.[A-Za-z]')


def _sql_inert_spans(text):
    """(start, end) of every string literal, quoted name and comment in the SQL part of `text` (dot-command
    lines are not SQL and are skipped): a keyword inside one is not a statement. The scan follows the SQLite
    lexer; it is only used to let a NON-literal VACUUM INTO / writefile() / edit() pass when it sits in a
    string, never to hide a literal path."""
    spans = []
    i, n, line_start = 0, len(text), True
    while i < n:
        c = text[i]
        if c == '\n':
            line_start = True
            i += 1
            continue
        if c in ' \t\r':
            i += 1
            continue
        if line_start and _SQL_DOT_LINE.match(text, i):
            j = text.find('\n', i)
            i = n if j == -1 else j
            continue
        line_start = False
        if text.startswith('--', i):
            j = text.find('\n', i)
            j = n if j == -1 else j
            spans.append((i, j))
            i = j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            j = n if j == -1 else j + 2
            spans.append((i, j))
            i = j
        elif c in '\'"`' or c == '[':
            q = ']' if c == '[' else c
            j = i + 1
            while True:
                k = text.find(q, j)
                if k == -1:
                    j = n
                    break
                if q != ']' and text.startswith(q, k + 1):
                    j = k + 2
                    continue
                j = k + 1
                break
            spans.append((i, j))
            i = j
        else:
            i += 1
    return spans


def _sql_inert(spans, pos):
    for s, e in spans:
        if s <= pos < e:
            return True
    return False


def _sql_file_target(what, target, state, inert=False):
    if target is None:
        if inert:
            return
        raise Deny('sqlite3 %s: a cel nem egyetlen szoveg-literal (kifejezes, osszefuzes, parameter, fuggveny), ezert a '
                   'kapu nem tudja, hova ir: nem engedett.' % what)
    if _live_path(Word(target, '$' in target or '`' in target), state):
        _deny_live_write('sqlite3 %s -> %s' % (what, target))


def _sql_dot_unquote(tok):
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in '\'"':
        return tok[1:-1].replace(tok[0] * 2, tok[0]) if tok[0] == "'" else tok[1:-1]
    return tok


def _inspect_sql_targets(text, state):
    """sqlite3 writes a FILE through `.backup` / `.save` / `.clone`, `.output` / `.once` / `.excel` / `.log` /
    `.trace`, `VACUUM INTO` and the writefile() SQL function: never into the live store, never to a target
    the gate cannot read, and `.output |cmd` / `edit()` run a program."""
    n = 0
    for m in SQL_DOT_ANY.finditer(text):
        nm = m.group(1).lower()
        full = next((f for f in _SQL_DOT_FILE_OUT if f.startswith(nm)), None)
        if full is None:
            continue
        n += 1
        if n > MAX_SQL_FILE_FUNCS:
            raise InspectionLimit('more than %d sqlite3 file dot-commands in one text' % MAX_SQL_FILE_FUNCS)
        toks = _SQL_DOT_TOKEN.findall(m.group(2))
        opts = [t for t in toks if t.startswith('-')]
        names = [_sql_dot_unquote(t) for t in toks if not t.startswith('-')]
        if full in ('backup', 'save', 'clone'):
            targets = names[-1:]                    # .backup ?DB? FILE
        else:
            if any(t.startswith('|') for t in names) or '-e' in opts:
                raise Deny('sqlite3 .%s |parancs / -e: a kimenetet egy program kapja, nem engedett.' % full)
            targets = names[:1]
        for t in targets:
            if _live_path(Word(t, '$' in t or '`' in t), state):
                _deny_live_write('sqlite3 .%s -> %s' % (full, t))
    spans = None
    for m in _SQL_WORD_EDIT.finditer(text):
        spans = _sql_inert_spans(text) if spans is None else spans
        if not _sql_inert(spans, m.start()):
            raise Deny('sqlite3 edit(): egy szerkeszto programot futtat, nem engedett.')
    n = 0
    for m in _SQL_WORD_VACUUM.finditer(text):
        n += 1
        if n > MAX_SQL_FILE_FUNCS:
            raise InspectionLimit('more than %d VACUUM in one text' % MAX_SQL_FILE_FUNCS)
        i = _sql_skip(text, m.end())
        w = _SQL_WORD_INTO.match(text, i)
        if w is None:                               # VACUUM <schema> INTO ...
            e = _sql_ident_end(text, i)
            if e < 0:
                continue
            w = _SQL_WORD_INTO.match(text, _sql_skip(text, e))
            if w is None:
                continue
        lit = _sql_single_literal(text, _sql_skip(text, w.end()), (';', ''))
        if lit is None:
            spans = _sql_inert_spans(text) if spans is None else spans
        _sql_file_target('VACUUM INTO', lit, state, lit is None and _sql_inert(spans, m.start()))
    n = 0
    for m in _SQL_WORD_WRITEFILE.finditer(text):
        i = _sql_skip(text, m.end())
        if text[i:i + 1] != '(':
            continue
        n += 1
        if n > MAX_SQL_FILE_FUNCS:
            raise InspectionLimit('more than %d writefile() in one text' % MAX_SQL_FILE_FUNCS)
        lit = _sql_single_literal(text, _sql_skip(text, i + 1), (',',))
        if lit is None:
            spans = _sql_inert_spans(text) if spans is None else spans
        _sql_file_target('writefile()', lit, state, lit is None and _sql_inert(spans, m.start()))


# ---- any argument that names the live database file ----

# Commands that only READ their file arguments (or print them as text). Everything else that is handed the
# live database file as an argument is refused: that one rule covers tar -x, unzip, gzip, zip -m, xz, open, ...
_LIVE_READONLY = frozenset((
    'cat', 'head', 'tail', 'wc', 'stat', 'ls', 'file', 'du', 'df', 'strings', 'xxd', 'hexdump', 'od', 'nl',
    'cut', 'tr', 'uniq', 'column', 'fold', 'rev', 'jq', 'yq',
    'sha256sum', 'sha1sum', 'sha512sum', 'shasum', 'md5', 'md5sum', 'b2sum', 'cksum', 'sum',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'diff', 'cmp',
    'echo', 'printf', 'test', '[', '[[', 'readlink', 'realpath', 'basename', 'dirname', 'type', 'which', 'whereis',
    'lsof', 'fuser', 'ps', 'pgrep', 'pkill', 'kill', 'mdls', 'bat', 'cd', 'pushd',
))
# handled by their own rules: the file writers, the target writers, git
_LIVE_ARG_SKIP = frozenset(_FILE_WRITERS) | _TARGET_WRITERS | frozenset(('git',))


_DYN_LIVE_FILE_HINT = re.compile(r'(?:^|/)store/(?:claudeclaw[^/]*|[^/]*\.db(?:-wal|-shm|-journal)?)$', re.I)


def _arg_candidates(word):
    """The path texts one argument word can carry: the word, the value of `--opt=VALUE` / `of=VALUE`, the
    text glued to a short option (`-oPATH`)."""
    t = word.text
    if not t or t == '-' or len(t) > 4096:
        return []
    out = []
    if t.startswith('-'):
        if '=' in t:
            out.append(t.split('=', 1)[1])
        elif not t.startswith('--') and len(t) > 2:
            out.append(t[2:])
    else:
        out.append(t)
        if '=' in t:
            out.append(t.split('=', 1)[1])
    return out


def _arg_is_live(cand, dyn, state):
    if not cand:
        return False
    if dyn or _has_placeholder(cand):
        return bool(_DYN_LIVE_FILE_HINT.search(cand))   # only a path that ENDS in store/<db file>; a dir is no file
    if _candidate_paths(cand, state, False) is None:
        # the directory is not knowable: only the unmistakable live file NAME counts
        return os.path.basename(cand.rstrip('/')) in _LIVE_DB_NAMES
    return _live_path(Word(cand), state)


def _join_word(base, member):
    """`member` (an archive member name) as extracted under the directory word `base` (None = the cwd)."""
    if base is None:
        return member
    if base.dyn or _has_placeholder(base.text):
        return None
    return Word(os.path.join(base.text, member.text), member.dyn)


_TAR_MODES = (('--create', 'c'), ('--extract', 'x'), ('--get', 'x'), ('--list', 't'), ('--append', 'r'),
              ('--update', 'u'), ('--diff', 'd'), ('--compare', 'd'))


def _live_tar(args, state):
    """tar: the archive it WRITES (-c / -r / -u), the directory it extracts into (-C) and the members it
    extracts by name must not be the live database. -t / --list and reading files into an archive are fine."""
    modes, files, dirs, members, skip = set(), [], [], [], set()
    n = len(args)
    for idx, a in enumerate(args):
        if idx in skip:
            continue
        t = a.text
        if t == '--':
            members.extend(args[idx + 1:])
            break
        if t.startswith('--'):
            nm, eq, val = t.partition('=')
            for full, md in _TAR_MODES:
                if len(nm) >= 4 and full.startswith(nm):
                    modes.add(md)
            for full, bag in (('--file', files), ('--directory', dirs)):
                if len(nm) >= 4 and full.startswith(nm):
                    if eq:
                        bag.append(Word(val, a.dyn))
                    elif idx + 1 < n:
                        bag.append(args[idx + 1])
                        skip.add(idx + 1)
            continue
        old = idx == 0 and re.fullmatch(r'[A-Za-z]+', t) is not None
        if (t.startswith('-') and len(t) > 1) or old:
            pending = []
            bundle = t.lstrip('-')
            for j, ch in enumerate(bundle):
                if ch in 'cxtruAd':
                    modes.add(ch)
                if ch in 'fC':
                    bag = files if ch == 'f' else dirs
                    rest = bundle[j + 1:]
                    if rest and t.startswith('-'):      # -fFILE / -CDIR
                        bag.append(Word(rest, a.dyn))
                        break
                    pending.append(bag)
            for k, bag in enumerate(pending):
                if idx + 1 + k < n:
                    bag.append(args[idx + 1 + k])
                    skip.add(idx + 1 + k)
            continue
        members.append(a)
    if modes & set('cru'):
        for f in files:
            if _live_path(f, state):
                _deny_live_write('tar archive -> ' + f.text)
    if 'x' in modes:
        for d in dirs:
            if _live_path(d, state, True):
                _deny_live_write('tar -x -C ' + d.text)
        for m in members:
            w = _join_word(dirs[-1] if dirs else None, m)
            if w is not None and _live_path(w, state):
                _deny_live_write('tar -x ' + m.text)


def _live_unzip(args, state):
    """unzip: the -d directory and the members named on the command line must not be the live database."""
    dirs, listing, skip = [], False, set()
    for idx, a in enumerate(args):
        t = a.text
        if idx in skip or t == '--' or not t.startswith('-') or t.startswith('--') or len(t) < 2:
            continue
        for j, ch in enumerate(t[1:], 1):
            if ch == 'd':
                rest = t[j + 1:]
                if rest:
                    dirs.append(Word(rest, a.dyn))
                elif idx + 1 < len(args):
                    dirs.append(args[idx + 1])
                    skip.add(idx + 1)
                break
            if ch in 'xPn':
                break
            if ch in 'ltvzZpc':
                listing = True
    if listing:
        return
    for d in dirs:
        if _live_path(d, state, True):
            _deny_live_write('unzip -d ' + d.text)
    pos = _positional(args, ('-d', '-x', '-P', '-n'))
    for m in pos[1:]:
        w = _join_word(dirs[-1] if dirs else None, m)
        if w is not None and _live_path(w, state):
            _deny_live_write('unzip ' + m.text)


def _live_cpio_pax(name, args, seg, state):
    """cpio -p / pax -rw copy files (with -l: as HARD LINKS) and cpio -o / pax -w write an archive: the
    destination, the archive file and the linked sources must not be the live database."""
    values = 'FIOHRCED' if name == 'cpio' else 'fsxbopTUGE'
    letters, filevals, skip = set(), [], set()
    n = len(args)
    for idx, a in enumerate(args):
        if idx in skip:
            continue
        t = a.text
        if t.startswith('--'):
            nm, eq, val = t.partition('=')
            if nm == '--link':
                letters.add('l')
            elif nm == '--file' and eq:
                filevals.append(Word(val, a.dyn))
            continue
        if t.startswith('-') and len(t) > 1:
            for j, ch in enumerate(t[1:], 1):
                if ch in values:
                    v = t[j + 1:]
                    if not v and idx + 1 < n:
                        v = args[idx + 1].text
                        skip.add(idx + 1)
                    if ch in 'fFOI' and v:
                        filevals.append(Word(v, a.dyn))
                    break
                letters.add(ch)
    pos = _positional(args, tuple('-' + c for c in values))
    link = 'l' in letters
    if name == 'pax':
        copy = 'r' in letters and 'w' in letters
        if 'w' in letters and 'r' not in letters:
            for f in filevals:
                if _live_path(f, state):
                    _deny_live_write('pax -w -f ' + f.text)
        if copy and pos:
            if _live_path(pos[-1], state, True):
                _deny_live_write('pax -rw -> ' + pos[-1].text)
            if link:
                for s in pos[:-1]:
                    if _live_path(s, state, True, True, source=True):
                        _deny_live_write('pax -rw -l (hardlink) az elo store fajljara: ' + s.text)
        return
    if 'o' in letters:
        for f in filevals:
            if _live_path(f, state):
                _deny_live_write('cpio -o -> ' + f.text)
    if 'p' in letters:
        if pos and _live_path(pos[-1], state, True):
            _deny_live_write('cpio -p -> ' + pos[-1].text)
        if link:
            prev = seg.prev if seg is not None else None
            pn, _c, pa, _v = resolve_call(prev.words) if prev is not None and prev.words else (None, None, [], set())
            if pn not in ('echo', 'printf', 'ls', 'find'):
                raise Deny('cpio -p -l (hardlink): a linkelt fajlok listajat a kapu nem latja, ezert nem engedett.')
            for s in pa:
                if _live_path(s, state, True, True, source=True):
                    _deny_live_write('cpio -p -l (hardlink) az elo store fajljara: ' + s.text)


def _handle_live_args(name, args, seg, state):
    """One rule for every command not handled above: an argument word that names a live database file
    (claudeclaw.db, -wal, -shm, -journal, or the same inode under another name) is refused unless the
    command only reads it (_LIVE_READONLY). The store DIRECTORY alone is not a file and passes."""
    if name in _LIVE_ARG_SKIP or name in _LIVE_READONLY or name in state.funcs:
        return                  # (a function of the script itself: its body is in the text and was looked at)
    if name in ('tar', 'bsdtar', 'gtar', 'gnutar'):
        _live_tar(args, state)
        return
    if name == 'unzip':
        _live_unzip(args, state)
        return
    if name in ('cpio', 'pax'):
        _live_cpio_pax(name, args, seg, state)
        return
    for w in args:
        for cand in _arg_candidates(w):
            _charge(state, len(cand))
            if _arg_is_live(cand, w.dyn, state):
                _deny_live_write('%s %s' % (name[:20], w.text))


# ---- generic fallback: a command the gate has no handler for may still carry the payload ----

_GENERIC_EXEMPT = frozenset((
    # print / search / compare text; they never run their arguments
    'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'uniq', 'cut', 'tr',
    'grep', 'egrep', 'fgrep', 'diff', 'cmp', 'jq', 'yq', 'column', 'fold', 'nl', 'rev',
    'test', '[', '[[', 'true', 'false', ':', 'ls', 'tree', 'stat', 'file', 'du', 'df', 'basename', 'dirname',
    'realpath', 'readlink', 'date', 'pwd', 'which', 'type', 'whereis', 'sleep', 'hostname', 'uname',
    'whoami', 'id', 'printenv', 'wait', 'exit', 'return', 'read', 'set', 'unset', 'export', 'declare',
    'readonly', 'local', 'typeset', 'cd', 'pushd', 'popd', 'alias', 'history', 'help',
    # shell constructs whose word list is data for the loop / case, not a command
    'for', 'case', 'select', 'in', 'function',
    # file writers that never execute their arguments (their targets were already looked at:
    # _handle_filewrite for cp / mv / ln / ..., _handle_target_writers for rm / truncate / chmod / ...)
    'cp', 'mv', 'ln', 'link', 'install', 'dd', 'tee', 'ditto', 'scp', 'sponge', 'mkdir', 'touch', 'rm', 'rmdir',
    'chmod', 'chown', 'truncate',
    # their DATA payload is prose or JSON, not a command
    'curl', 'http', 'https',
    # test / lint / format runners (reached through npx too)
    'vitest', 'jest', 'tsc', 'eslint', 'prettier', 'shellcheck', 'mocha', 'playwright',
    'pbcopy', 'pbpaste', 'say', 'shasum', 'sha256sum', 'md5', 'md5sum',
    'kill', 'pkill', 'pgrep', 'ps', 'lsof',
))
# Tools that can run a command through one of their options (a pager, a pre-processor, a compressor,
# an alias, an extension) and so are exempt from the generic scan ONLY when no such option is there.
# sed (the `e` command, `s///e`) and open are not exempt at all.
_GH_DATA_SUBS = frozenset(('pr', 'issue', 'release', 'run', 'search', 'label', 'repo', 'workflow', 'status',
                           'mr', 'ci', 'pipeline'))


def _cond_exempt(name, args):
    texts = [a.text for a in args]
    if name == 'rg':
        return not any(re.match(r'--(?:pre|hostname-bin)', t) for t in texts)
    if name in ('ag', 'ack'):
        return not any(t.startswith('--pag') for t in texts)
    if name == 'sort':
        return not any(t.startswith('--co') for t in texts)
    if name in ('less', 'more'):
        for t in texts:
            if t[:1] in ('+', '!'):
                return False
            if t.startswith('-') and not re.fullmatch(r'-[NRSiIFXrnqsEMmw0-9]+', t):
                return False
        return True
    if name == 'man':
        for t in texts:
            if t.startswith('-') and not re.fullmatch(r'-(?:[akfwWhV]+|-(?:all|apropos|whatis|where|help|version))', t):
                return False
        return True
    if name in ('gh', 'glab'):
        sub = next((t for t in texts if not t.startswith('-')), '')
        return sub in _GH_DATA_SUBS
    if name == 'wget':
        return not any(re.match(r'-[A-Za-z]*e|--ex|--use-a', t) for t in texts)
    return False


# git sub-commands whose arguments are messages, refs and paths. The options BEFORE the sub-command
# (`git -c alias.x=!cmd`, `-c core.pager=cmd`, `-c core.sshCommand=cmd`) are always looked at.
_GIT_SAFE_SUBS = frozenset((
    'log', 'grep', 'show', 'diff', 'blame', 'commit', 'add', 'status', 'stash', 'tag', 'branch', 'merge',
    'revert', 'cherry-pick', 'notes', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file',
    'show-ref', 'describe', 'shortlog', 'reflog', 'checkout', 'switch', 'restore', 'reset', 'apply',
    'diff-tree', 'diff-index', 'name-rev', 'for-each-ref', 'check-ignore', 'clean', 'rm', 'mv',
))
_GIT_GLOBAL_VALUE_FLAGS = ('-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
                           '--config-env', '--exec-path')

_RUNNERS = r'(?:npm|pnpm|yarn|npx|pnpx|tsx|ts-node|node|nodejs|bun|bunx|deno|vite-node|corepack)'
# The CLI named the way it is RUN, inside an argument that is itself a command string.
GENERIC_RUNNER_MARKER = re.compile(_RUNNERS + r'\b[^\n]{0,80}?(?:dashboard[-_]user|security[-_]reset)(?![\w-])')
GENERIC_PATH_MARKER = re.compile(r'(?<![\w./-])(?:\./|/)[\w./-]*(?:dashboard-user|security-reset)(?![\w-])')


def _git_args_to_scan(args):
    """git: all arguments, except the ones after a message/ref/path sub-command."""
    i = 0
    while i < len(args):
        t = args[i].text
        if t == '--':
            return list(args)
        if t.startswith('-'):
            i += 2 if t in _GIT_GLOBAL_VALUE_FLAGS else 1
            continue
        if t in _GIT_SAFE_SUBS:
            return list(args[:i])
        return list(args)
    return list(args)


_GIT_EXEC_LONG = ('--open-files-in-pager', '--ext-diff', '--exec')


def _long_abbrev(name, full):
    """git takes an unambiguous prefix of a long option: `--ext`, `--open-files`, `--out=...`."""
    return len(name) >= 4 and full.startswith(name)


def _git_post_sub_checks(args, state):
    """The arguments after a message/ref/path sub-command are not text-scanned, but a few options of
    those sub-commands run a program (a pager, an external diff) or write a file (--output)."""
    i = 0
    while i < len(args):
        t = args[i].text
        if t == '--':
            return
        if t.startswith('-'):
            i += 2 if t in _GIT_GLOBAL_VALUE_FLAGS else 1
            continue
        break
    else:
        return
    sub = args[i].text
    if sub not in _GIT_SAFE_SUBS:
        return
    rest = args[i + 1:]
    for k, a in enumerate(rest):
        t = a.text
        if t == '--':
            break
        if t.startswith('--'):
            name = t.split('=', 1)[0]
            if any(_long_abbrev(name, f) for f in _GIT_EXEC_LONG):
                raise Deny('git %s %s: az opcio kulso parancsot (pager, kulso diff, exec) futtat, ezert nem engedett.'
                           % (sub[:20], name[:30]))
            if _long_abbrev(name, '--output'):
                val = Word(t.split('=', 1)[1], a.dyn) if '=' in t else (rest[k + 1] if k + 1 < len(rest) else None)
                if val is not None and _live_path(val, state):
                    _deny_live_write('git --output ' + val.text)
        elif sub == 'grep' and t.startswith('-O'):
            raise Deny('git grep -O: a talalatokat egy megadott paranccsal nyitja meg, ezert nem engedett.')


def _charge(state, n):
    state.budget.chars += n
    if state.budget.chars > MAX_WORK_CHARS:
        raise InspectionLimit('the total text to inspect is above %d characters' % MAX_WORK_CHARS)


def _follow_markers(text, markers, state, depth):
    """Run the part of `text` that starts at a CLI invocation shape as a command of its own."""
    n = 0
    for rx in markers:
        for m in rx.finditer(text):
            n += 1
            if n > MAX_GENERIC_MARKERS:
                raise InspectionLimit('more than %d command shapes in one argument' % MAX_GENERIC_MARKERS)
            check_command(text[m.start():], state, depth + 1)


def _generic_fallback(name, args, seg, state, depth):
    if name in _GENERIC_EXEMPT or _cond_exempt(name, args):
        return
    scan = list(args)
    if name == 'git':
        _git_post_sub_checks(args, state)
        scan = _git_args_to_scan(args)
    for w in scan:
        for alt in w.alts:
            if re.search(r'\s', alt):       # a command string handed over as one argument
                _charge(state, len(alt))
                _follow_markers(alt, (GENERIC_RUNNER_MARKER, GENERIC_PATH_MARKER), state, depth)
    texts = [' '.join(w.text for w in scan)]
    if seg is not None:
        texts.extend(b for b, _q in seg.heredocs)
        texts.extend(seg.herestr)
    for t in texts:
        _charge(state, len(t))
        if '--password-stdin' in t and name not in _LOGIN_OK and not state.isolated_cli:
            raise Deny('--password-stdin egy olyan parancs argumentumaban, amit a kapu nem ismer: jelszot csak a '
                       'tulajdonos ad meg, agens nem.')
        hit = _sql_write_summary(t)
        if hit:
            raise Deny('iras a hitelesito tablakra (%s) egy olyan parancs argumentumaban vagy bemenetebol, amit a '
                       'kapu nem ismer (%s). Ha csak szoveg, echo/cat/grep-pel jelenitsd meg.' % (hit, name[:30]))
        _follow_markers(t, (GENERIC_RUNNER_MARKER,), state, depth)


def check_words(words, seg, state, depth):
    """Apply every rule to ONE command given as words (already past keywords)."""
    name, cmdword, args, via = resolve_call(words)
    if name is None:
        return
    state.isolated_cli = _isolated_store(seg, words, cmdword, state)
    # --password-stdin anywhere (rule 2), whatever the command and wrapper
    if (any(a.text == '--password-stdin' for a in args) and name not in _LOGIN_OK
            and not state.isolated_cli):
        raise Deny('--password-stdin: jelszot csak a tulajdonos ad meg, agens nem.')
    if name == 'env-S':
        for alt in (args[0].alts if args else []):
            check_command(alt, state, depth + 1)
        return
    if name in ('su-c', 'script-c'):
        for alt in (args[0].alts if args else []):
            check_command(alt, state, depth + 1)
        return
    if name in ('eval',):
        joined = ' '.join(a.text for a in args)
        if seg is not None and any(re.search(r'\b(?:%s)\b' % '|'.join(_DECODERS), s) for s in seg.subs):
            raise Deny('eval egy dekodolt (base64/xxd/openssl/...) kimenettel: nem ellenorizheto.')
        check_command(joined, state, depth + 1)
        return
    if name in ('source', '.'):
        if args:
            txt = _read_text_file(args[0].text, state)
            if txt is not None:
                check_shell_script(txt, state, depth)
        return
    if name in ('xargs', 'parallel') or 'xargs' in via:
        # `echo dashboard-user | xargs npm run`: the producer's words become arguments of the command
        if seg is not None and seg.prev is not None:
            pn, _pc, pa, _pv = resolve_call(seg.prev.words)
            if pn in ('echo', 'printf'):
                fed = [a for a in pa if not a.text.startswith('-')]
                if any('{}' in a.text for a in args):          # xargs -I{} : the producer replaces {}
                    joined = ' '.join(a.text for a in fed)
                    args = [Word(a.text.replace('{}', joined), a.dyn) if '{}' in a.text else a for a in args]
                else:
                    args = list(args) + fed
    if name in _SHELLS:
        if seg is not None and any(re.search(r'\b(?:%s)\b' % '|'.join(_DECODERS), s) for s in seg.subs):
            raise Deny('shell -c dekodolt (base64/xxd/openssl/...) kimenettel: nem ellenorizheto.')
        _handle_shell(name, args, seg or Seg(), state, depth)
        return
    if _PY.match(name):
        _handle_interp(name, args, seg or Seg(), state, depth, 'python')
        return
    if name in _NODEISH:
        _handle_node(name, args, seg or Seg(), state, depth)
        if name in ('bun',):
            _handle_npm_like(name, args, seg or Seg(), state, depth)
        return
    if name in _SCRIPT_LANGS:
        _handle_interp(name, args, seg or Seg(), state, depth,
                       'osascript' if name == 'osascript' else name)
        return
    if name in ('npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bunx', 'corepack'):
        _handle_npm_like(name, args, seg or Seg(), state, depth)
        return
    if name in _SQL_CLIENTS:
        _handle_sql_client(name, args, seg or Seg(), state, depth)
        return
    if name == 'find':
        _handle_find(args, seg, state, depth)
        return
    if name in ('tmux', 'screen'):
        _handle_tmux(args, state, depth)
        if name == 'screen':
            for k, a in enumerate(args):
                if a.text == 'stuff' and k + 1 < len(args):
                    check_command(args[k + 1].text, state, depth + 1)
        return
    if name in ('ssh', 'mosh'):
        _handle_ssh(args, seg, state, depth)
        return
    if name in _FILE_WRITERS:
        _handle_filewrite(name, args, state)
    if name in _TARGET_WRITERS:
        _handle_target_writers(name, args, state)
    _handle_live_args(name, args, seg, state)
    # a direct execution of the CLI or of a shell script by path: ./scripts/dashboard-user.ts, x.sh
    for alt in cmdword.alts:
        if _is_cli_name(_script_stem(alt)):
            _cli_decision(_after_cli(args), state)
            return
        if '/' in alt and alt.lower().endswith(('.sh', '.bash')):
            txt = _read_text_file(alt, state)
            if txt is not None:
                check_shell_script(txt, state, depth)
            return
    _generic_fallback(name, args, seg, state, depth)


def check_command(cmd, state, depth=0):
    if depth > MAX_NEST:
        raise InspectionLimit('nesting deeper than %d levels' % MAX_NEST)
    state.budget.calls += 1
    if state.budget.calls > MAX_CALLS:
        raise InspectionLimit('more than %d nested inspections' % MAX_CALLS)
    if len(cmd) > MAX_CMD_CHARS:
        raise InspectionLimit('the text is %d characters, the limit is %d' % (len(cmd), MAX_CMD_CHARS))
    segs = lex(cmd, state)
    _note_dir_changes(segs, state)       # a directory change ANYWHERE in the text matters for every path
    for seg in segs:
        for w in seg.out_files:
            if _live_path(w, state):
                _deny_live_write('atiranyitas: ' + w.text)
        for body in seg.subs:
            check_command(body, state, depth + 1)
        for body, quoted in seg.heredocs:
            if not quoted:       # an unquoted heredoc expands $(...) and backticks even into a data file
                for m in re.finditer(r'\$\(([^()]*)\)|`([^`]*)`', body):
                    check_command(m.group(1) or m.group(2) or '', state, depth + 1)
        if seg.words:
            check_words(seg.words, seg, state, depth)


# --------------------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------------------

def _timeout(_signum, _frame):
    sys.stderr.write('AUTH-ADMIN-KAPU: a vizsgalat nem fert bele az idokeretbe, ezert BLOKKOL.\n')
    os._exit(2)


def inspect(cmd, cwd=''):
    """Raises Deny / InspectionLimit; returns None when the command is clean."""
    state = State(cwd)
    check_command(cmd, state, 0)


def main():
    limit = HARD_TIMEOUT_S
    try:   # the env override can only make the alarm SHORTER (tests); never longer
        limit = max(1, min(HARD_TIMEOUT_S, int(os.environ.get('AUTH_ADMIN_GATE_TIMEOUT_S', HARD_TIMEOUT_S))))
    except ValueError:
        pass
    try:
        signal.signal(signal.SIGALRM, _timeout)
        signal.alarm(limit)
    except Exception:
        pass
    raw = sys.stdin.read(MAX_EVENT_CHARS + 1)
    if len(raw) > MAX_EVENT_CHARS:
        sys.stderr.write('AUTH-ADMIN-KAPU: a bemenet tul nagy a vizsgalathoz, ezert BLOKKOL.\n')
        sys.exit(2)
    try:
        ev = json.loads(raw)
        if not isinstance(ev, dict):
            raise ValueError('not an object')
    except Exception:
        sys.stderr.write('AUTH-ADMIN-KAPU: a bemenet nem olvashato, ezert BLOKKOL.\n')
        sys.exit(2)
    tool = ev.get('tool_name') or ''
    if tool != 'Bash':
        sys.exit(0)
    inp = ev.get('tool_input') or {}
    cwd = str(ev.get('cwd') or '')
    cmd = inp.get('command') if isinstance(inp, dict) else None
    if not isinstance(cmd, str):
        sys.stderr.write('AUTH-ADMIN-KAPU: a Bash parancs nem olvashato, ezert BLOKKOL.\n')
        sys.exit(2)
    try:
        inspect(cmd, cwd)
    except Deny as d:
        block(d.reason, cwd)
    except Opaque:
        block('Dekodolt (base64/xxd/openssl/gunzip/...) tartalom shellbe vagy interpreterbe: a dekodolt szoveg '
              'nem ellenorizheto, ezert nem engedett.', cwd)
    except InspectionLimit as exc:
        block('Tul nagy / tul melyen agyazott parancs, nem vizsgalhato az idokereten belul (%s), ezert '
              'nem engedi at a kapu.' % exc, cwd)
    except RecursionError:
        block('Tul melyen agyazott parancs, nem vizsgalhato, ezert nem engedi at a kapu.', cwd)
    except SystemExit:
        raise
    except BaseException as exc:  # a broken gate must never become a permissive one
        sys.stderr.write('AUTH-ADMIN-KAPU: a kapu maga hibara futott (%s: %s), ezert BLOKKOL. Ez a '
                         'kapu hibaja, nem a tied.\n' % (type(exc).__name__, exc))
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
