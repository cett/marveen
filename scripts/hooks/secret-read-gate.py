#!/usr/bin/env python3
"""PreToolUse read guard for the secret files of the install: the claim signing key and the token files.

TIER A, the claim signing key store/.claim-signing-key. The dashboard signs every successful approval claim with
the key in <install>/store/.claim-signing-key; the email send gate and the official sender check that signature. An
agent that can READ the key can forge the signature of a mirror server, so this hook refuses every tool call that
would read (or overwrite) that file. All the rules below apply to it, the strict text rules included.

TIER B, the token files: store/.operator-token, store/.dashboard-token, store/.claude-oauth-token,
store/.claude-oauth-token.verified, <install>/.agent-token (the main agent's) and <install>/agents/<id>/.agent-token
for EVERY id, the caller's own included (an agent never needs to read its own token: scripts/agent-api.sh reads it
for the caller and the command text never names the file). The agents directory is enumerated at decision time, once
per call (agents appear and disappear at run time); a missing directory holds no agent, an unreadable one or one with
more than MAX_AGENTS entries is a refusal, never a pass. A tier B file is reached by the same path rules as the key
(realpath, device/inode, `..`, the caller's cwd, file://, a glob expanded with dotfiles, a glob read from its text,
a recursive reader over a directory that holds an existing token file) and by its DOTTED name as the last component
of a path word wherever the path leads (`cat .agent-token` from inside agents/<id> is the likeliest real read).
It is NOT reached by the dotless spelling alone (`dashboard-token` is all over code, docs and recipes) nor by a name
inside free text or the PATTERN / --exclude value of a grep: a gate that cries wolf gets switched off. The block
reason names the file only and says "a token file is not for an agent to read or change". `--exclude=<name>` over a
directory lets a legitimate recursive search through. A recipe that names a dotted token file is a recipe to change
(run a script that reads it), not an exemption in the gate.

What it refuses (exit 2, the reason on stderr):

  * ANY tool other than Bash (Read, Edit, Write, NotebookEdit, the MCP file tools such as
    mcp__filesystem__read_text_file / write_file / edit_file / move_file / read_multiple_files, a tool that does not
    exist yet): every string in tool_input, in lists and nested objects too, is judged whatever the tool is called.
    A value under a path-like field name (path, paths, file_path, source, destination, files, url, ...) that IS the
    key file is refused: the path is resolved with os.path.realpath (symlinks and `..` segments followed, relative
    paths taken from the call's cwd, a file:// URL unwrapped, a glob expanded with dotfiles), compared with the key's
    real path and with its device/inode (a hard link), and refused when its text names the key. Any other short
    string is refused only when it resolves to the key (the text of a file being written may mention the name).
  * Grep / Glob whose path is, or is inside, the store directory, or whose glob / pattern would select the key
    below the searched directory (`.claim*`, `**/.*`, `store/.[c]*` ...).
  * Bash whose command text names the key: the file name, a glob that can match it (`store/.claim*`,
    `store/.*`, `store/.[c]*`, `.claim?signing*`, `*signing-key*`), also behind quotes, escapes, concatenation
    (`.claim-sig''ning-key`), reversed, hex or base64 spellings; a path word that resolves to the key (also through
    a symlink or a glob over the store directory); a recursive reader (grep -r, tar, cp -r, rsync, zip, find -exec,
    rg --hidden) over the store directory or a directory that holds it.

KNOWN LIMITS. This is a conservative TEXT + REALPATH denylist, not a sandbox, and it says so:
  * a name built at run time out of pieces the text does not show ($a$b, a command substitution), a
    character-code spelling, an encoding other than the ones above;
  * `cd store` followed by reading dotfiles whose names do not appear in the text of one command;
  * a Grep from a directory that holds the install, with no glob, relies on ripgrep skipping the git-ignored
    store/ directory; likewise a Grep (and a Bash rg) over agents/ or agents/<id> with no glob and no --hidden relies
    on ripgrep skipping dotfiles, where the token files sit;
  * a grep whose pattern the parse cannot tell from its files (`-f`, `-m 5`, `-er`: an option with a value) reads every
    plain word as a path; a plain simple grep reads its first word as the pattern, which is not judged as a path;
  * a process that is not a tool call of this session (a script the agent starts that reads the file);
  * the key staying readable by the same OS user: the owner chose a hook-level guard, not an OS permission.
It stops the careless or lazily prompted read, not a determined bypass.

FAIL CLOSED, no switch. Any internal error, bad input or part that does not load is exit 2 (never 1, which a
PreToolUse hook reads as "not blocking"). There is no shadow mode and no environment flag that relaxes it.
Contract: PreToolUse; stdin = the hook payload (tool_name, tool_input, cwd); exit 0 = allow, exit 2 = block.
Registered by the owner in the root hook configuration with a matcher that covers EVERY tool (`*`): the hook
leaves at once when no string of the call can name a path.
Standard library only.
"""
from __future__ import annotations

import sys

try:
    import base64
    import fnmatch
    import glob as globlib
    import itertools
    import json
    import os
    import re
    import shlex
    from urllib.parse import unquote
except BaseException as _exc:  # noqa: BLE001 -- a broken import must be a block, not exit 1
    sys.stderr.write('SECRET READ GATE: BLOCKED -- the gate cannot load (%s).\n' % type(_exc).__name__)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.dirname(os.path.dirname(HERE))
STORE = os.path.join(INSTALL, 'store')
KEY_NAME = '.claim-signing-key'
KEY_PATH = os.path.join(STORE, KEY_NAME)
# What the strict text rules of a tier A file look for in a command text: fragments of its name that no ordinary
# command contains, and the boundary form of its first word (`.claim` after a separator).
KEY_MARKERS = ('claim-signing', 'signing-key', 'claim_signing')

FILE_PATH_KEYS = ('file_path', 'notebook_path', 'path', 'filePath', 'notebookPath')
PATHISH_KEY = re.compile(r'path|file|source|dest|src|target|dir|folder|uri|url|glob|pattern|location|root|name|^from$|^to$')
MAX_STRINGS = 5000
MAX_DEPTH = 12
MAX_LENIENT = 4096     # PATH_MAX
MAX_GLOB = 50000
SEARCH_TOOLS = ('Grep', 'Glob')
ARCHIVERS = frozenset(('tar', 'gtar', 'bsdtar', 'zip', '7z', '7za', 'pax', 'cpio', 'ditto', 'rclone'))
COPIERS = frozenset(('cp', 'rsync', 'scp'))
GREP_FAMILY = frozenset(('grep', 'egrep', 'fgrep', 'ggrep', 'zgrep', 'ugrep'))
RG_FAMILY = frozenset(('rg', 'ag', 'ack'))
FIND_EXEC = frozenset(('-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'))
MAX_TEXT = 200000


class Block(Exception):
    def __init__(self, why: str, protected=None) -> None:
        super().__init__(why)
        self.protected = protected      # the Protected file the call reaches, when one is known


def deny(why: str, protected=None) -> None:
    raise Block(why, protected)


# ---------------------------------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------------------------------

def _real(path: str) -> str:
    return os.path.realpath(path)


STORE_REAL = _real(STORE)


class Protected:
    """One file the gate guards. tier 'A' is the claim signing key (the strict text rules apply to it); `dir_real`
    is the real path of the directory the file is expected in, `real` the real path of the file itself."""
    __slots__ = ('name', 'path', 'real', 'dir_real', 'tier')

    def __init__(self, name: str, path: str, tier: str) -> None:
        self.name = name
        self.path = path
        self.real = _real(path)
        self.dir_real = _real(os.path.dirname(path))
        self.tier = tier


# The protected-file set; every rule below loops over it. Tier A: the claim signing key (strict text rules). Tier B:
# the token files, matched by path, by dotted name and by glob, never by a bare mention of the name in text.
AGENTS = os.path.join(INSTALL, 'agents')
AGENT_TOKEN = '.agent-token'
STORE_TOKEN_NAMES = ('.operator-token', '.dashboard-token', '.claude-oauth-token', '.claude-oauth-token.verified')
TIER_B_NAMES = frozenset(STORE_TOKEN_NAMES + (AGENT_TOKEN,))
MAX_AGENTS = 1000      # entries of the agents directory the gate looks through; more is a refusal
_FIXED = (Protected(KEY_NAME, KEY_PATH, 'A'),
          *(Protected(n, os.path.join(STORE, n), 'B') for n in STORE_TOKEN_NAMES),
          Protected(AGENT_TOKEN, os.path.join(INSTALL, AGENT_TOKEN), 'B'))
_ENUMERATED: list = []


def _protected_files() -> tuple:
    """The fixed files plus the token file of EVERY agent directory, enumerated now (agents appear and disappear
    at run time; once per call). A missing agents directory holds no agent; an unreadable one, or one with more
    entries than MAX_AGENTS, is a refusal, never a pass."""
    if not _ENUMERATED:
        files = list(_FIXED)
        try:
            with os.scandir(AGENTS) as it:
                for n, entry in enumerate(it):
                    if n >= MAX_AGENTS:
                        deny('the agents directory holds more entries than the gate checks', Protected(AGENT_TOKEN, os.path.join(INSTALL, AGENT_TOKEN), 'B'))
                    files.append(Protected(AGENT_TOKEN, os.path.join(AGENTS, entry.name, AGENT_TOKEN), 'B'))
        except (FileNotFoundError, NotADirectoryError):
            pass
        except OSError:
            deny('the agents directory cannot be read', Protected(AGENT_TOKEN, os.path.join(INSTALL, AGENT_TOKEN), 'B'))
        _ENUMERATED.append(tuple(files))
    return _ENUMERATED[0]


def _absolute(path: str, cwd: str) -> str:
    p = os.path.expanduser(path)
    return p if os.path.isabs(p) else os.path.join(cwd, p)


def _unwrap_file_url(path: str) -> str:
    if path[:7].lower() == 'file://':
        path = unquote(path[7:])
        if not path.startswith('/'):
            path = '/' + path.split('/', 1)[1] if '/' in path else path      # file://localhost/x or file://host/x: the host is dropped
    return path


def _protected_hit(path: str, cwd: str, by_text: bool = True):
    """The protected file `path` is, resolves to, or is another name (a hard link) for; None when it is none of
    them. by_text: also when the text of the path merely names a tier A file."""
    path = _unwrap_file_url(path)
    files = _protected_files()
    if by_text:
        low = path.lower().replace('\\', '')
        for f in files:
            if f.tier == 'A' and f.name in low:
                return f
    abs_path = _absolute(path, cwd)
    real = _real(abs_path)
    for f in files:
        if real == f.real or (by_text and f.tier == 'A' and os.path.basename(real) == f.name):
            return f
    if by_text:
        # a tier B file is also hit by its DOTTED name as the last component of the path, wherever the path leads
        # (also quoted, also upper case on a case-insensitive volume); a bare mention in free text is not a path
        for last in (os.path.basename(path.rstrip('/')), os.path.basename(real)):
            if last.lower() in TIER_B_NAMES:
                return next(f for f in files if f.name == last.lower())
    for f in files:
        try:
            a, b = os.stat(abs_path), os.stat(f.path)
        except OSError:
            continue
        if (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino):
            return f
    return None


def _inside(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def _covered_files(path: str, cwd: str) -> list:
    """The protected files whose directory is `path` or lies below it: a recursive reader over `path` reaches them."""
    base = _real(_absolute(path, cwd))
    return [f for f in _protected_files() if _inside(f.dir_real, base)]


def _brace_expand(pat: str, depth: int = 0) -> list:
    m = re.search(r'\{([^{}]*)\}', pat)
    if not m or depth > 4:
        return [pat]
    out = []
    for alt in m.group(1).split(','):
        out.extend(_brace_expand(pat[:m.start()] + alt + pat[m.end():], depth + 1))
    return out[:200]


BRACE_MAX_ALTS = 1024        # alternatives one word may expand to
BRACE_MAX_WORD = 2048        # characters of a word the expansion reads
BRACE_MAX_WORK = 2000000     # characters scanned for the whole command
_SEQ = re.compile(r'(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?')
_brace_work = [0]


class _BraceTooBig(Exception):
    pass


def _brace_group(s: str):
    """The first brace group of `s` that bash expands: (start, end, kind, body-or-parts). A group has a comma at its top
    level or is a sequence `x..y[..step]`; `{x}`, `{}` and `${...}` are not groups. A brace that is no group is skipped,
    so an inner group of it is still found (`{{a,b}}`)."""
    _brace_work[0] += len(s)
    if _brace_work[0] > BRACE_MAX_WORK:
        raise _BraceTooBig()
    i = s.find('{')
    while i != -1:
        if i == 0 or s[i - 1] != '$':
            depth, commas, j = 0, [], i
            while j < len(s):
                c = s[j]
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        break
                elif c == ',' and depth == 1:
                    commas.append(j)
                j += 1
            if j < len(s) and depth == 0:
                if commas:
                    cuts = [i] + commas + [j]
                    return i, j, 'list', [s[cuts[k] + 1:cuts[k + 1]] for k in range(len(cuts) - 1)]
                seq = _SEQ.fullmatch(s[i + 1:j])
                if seq:
                    return i, j, 'seq', seq
        i = s.find('{', i + 1)
    return None


def _brace_sequence(m) -> list:
    """The words of `{a..b[..step]}`: integers (zero padded like bash when an end has a leading zero) or single letters."""
    a, b, step = m.group(1), m.group(2), m.group(3)
    if a.lstrip('-').isdigit() and b.lstrip('-').isdigit():
        da, db = a.lstrip('-'), b.lstrip('-')
        lo, hi = int(a), int(b)
        padded = (len(da) > 1 and da.startswith('0')) or (len(db) > 1 and db.startswith('0'))
        width = max(len(da), len(db)) if padded else 0
    elif a.isalpha() and b.isalpha():
        lo, hi, width = ord(a), ord(b), 0
    else:
        return [m.group(0)]      # mixed ends: bash leaves it as text
    inc = (abs(int(step)) or 1) if step else 1
    n = abs(hi - lo) // inc + 1
    if n > BRACE_MAX_ALTS:
        raise _BraceTooBig()
    seq = range(lo, hi + 1, inc) if lo <= hi else range(lo, hi - 1, -inc)
    if a.isalpha():
        return [chr(v) for v in seq]
    return [('-' if v < 0 else '') + str(abs(v)).zfill(width) for v in seq]


def _brace_all(s: str, budget: list, depth: int = 0) -> list:
    if depth > 24:
        raise _BraceTooBig()
    g = _brace_group(s)
    if g is None:
        return [s]
    i, j, kind, body = g
    parts = body if kind == 'list' else _brace_sequence(body)
    out = []
    for part in parts:
        for alt in _brace_all(s[:i] + part + s[j + 1:], budget, depth + 1):
            budget[0] += 1
            if budget[0] > BRACE_MAX_ALTS:
                raise _BraceTooBig()
            out.append(alt)
    return out


# A quoted or escaped brace, comma or dollar is literal to the shell: it is swapped for a private-use character while
# the expansion runs, and swapped back in the alternatives.
_MARK = {'{': '', '}': '', ',': '', '$': ''}
_UNMARK = {v: k for k, v in _MARK.items()}


def _brace_alternatives(word: str) -> list:
    """Every word a shell makes of `word` by brace expansion, the word itself first. `agents/a/{.agent-token,x}` is
    two paths, `{src/k,x}` too, `.agent-toke{n..n}` one; the gate judges each alternative as a path of its own.
    Quote aware: only an UNQUOTED brace group expands. In bash and zsh a brace inside single or double quotes, or behind a
    backslash, is literal (`'{"a": 1, "b": 2}'`, `\\{x,y\\}`), so quoted JSON or code is not expanded and not refused; a
    partly quoted word (`"agents/my dir/"{.agent-token,x}`) expands at its unquoted braces and the quotes are gone from
    the alternatives. Fail closed, with no exception: a word whose unquoted expansion goes over a cap (more than
    BRACE_MAX_ALTS alternatives, longer than BRACE_MAX_WORD characters, more than BRACE_MAX_WORK characters of work for
    the command, nested too deep), and a word that holds a brace group while its quote state could not be determined
    (`mask` is None), are refused."""
    if '{' not in word or ('..' not in word and ',' not in word):
        return [word]
    mask = getattr(word, 'mask', None)
    if mask is None:
        marked = str(word)
        if _brace_group(marked) is not None:
            deny('a word of the command holds a brace group and its quoting could not be read (brace expansion)')
        return [word]
    if len(mask) != len(word) or any(ch in _UNMARK for ch in word):
        deny('a word of the command could not be read for brace expansion')
    marked = ''.join(_MARK[ch] if (m and ch in _MARK) else ch for ch, m in zip(word, mask))
    if '{' not in marked or ('..' not in marked and ',' not in marked):
        return [word]      # the braces, if any, are quoted
    try:
        if len(word) > BRACE_MAX_WORD:
            raise _BraceTooBig()
        alts = _brace_all(marked, [0])
    except _BraceTooBig:
        deny('a word of the command expands to more paths than the gate can look through (brace expansion)')
    plain = [''.join(_UNMARK.get(ch, ch) for ch in a) for a in alts]
    return [word] + [a for a in plain if a != word]


def _shell_glob(pat: str) -> str:
    """A shell word's glob in the spelling Python's fnmatch / glob understand: bash negates a bracket with `^` as
    well as `!`, fnmatch only with `!`."""
    return re.sub(r'\[\^', '[!', pat)


def _may_match_name(pat: str, name: str) -> bool:
    """Could the shell glob `pat` select the file name `name`? A POSIX class ([[:lower:]]) is not translated: it is
    judged as a match."""
    return '[:' in pat or fnmatch.fnmatchcase(name, _shell_glob(pat))


def _glob_regex(pat: str):
    """A path glob as a regex: `**` spans directories, `*` and `?` stay inside one segment and DO match a
    leading dot (the conservative reading: a tool that skips dotfiles is not relied on)."""
    i, out = 0, ''
    while i < len(pat):
        c = pat[i]
        if pat.startswith('**/', i):
            out += '(?:.*/)?'
            i += 3
            continue
        if pat.startswith('**', i):
            out += '.*'
            i += 2
            continue
        if c == '*':
            out += '[^/]*'
        elif c == '?':
            out += '[^/]'
        elif c == '[':
            j = pat.find(']', i + 2)
            if j == -1:
                out += re.escape(c)
            else:
                body = pat[i + 1:j]
                if body[:1] in ('!', '^'):
                    body = '^' + body[1:]
                out += '[' + body.replace('\\', '\\\\') + ']'
                i = j
        else:
            out += re.escape(c)
        i += 1
    return re.compile(out)


def _glob_matches_name(glob: str, rel_dir: str, name: str, any_depth: bool) -> bool:
    """Could `glob`, applied below a searched directory, select the file `name`? rel_dir is the path from that
    directory to the directory the file sits in. any_depth: a pattern without a slash matches the file name at any
    depth (a ripgrep glob); otherwise the whole relative path has to match (the Glob tool)."""
    rel_key = name if rel_dir in ('', '.') else rel_dir.rstrip('/') + '/' + name
    for alt in _brace_expand(glob.strip().replace('\\', '/')):
        alt = alt[2:] if alt.startswith('./') else alt
        if not alt:
            continue
        if '/' not in alt.strip('/') and any_depth:
            if fnmatch.fnmatchcase(name, alt.lstrip('!')):
                return True
            continue
        try:
            if _glob_regex(alt.lstrip('/')).fullmatch(rel_key):
                return True
        except re.error:
            return True      # a pattern we cannot read is judged as one that matches
    return False


def _glob_selects_protected(glob: str, base_real: str, any_depth: bool, rooted: bool = False):
    """The protected file `glob` could select when applied below `base_real` (rooted: `glob` is already an
    absolute pattern with its slash removed, tested from the filesystem root); None when it selects none."""
    base = '/' if rooted else base_real
    for f in _protected_files():
        if rooted or _inside(f.dir_real, base_real):
            if _glob_matches_name(glob, os.path.relpath(f.dir_real, base), f.name, any_depth):
                return f
    return None


# ---------------------------------------------------------------------------------------------------
# File tools
# ---------------------------------------------------------------------------------------------------

def _collect_strings(value, key: str, depth: int, out: list) -> None:
    """Every string of a tool argument with the name of the field it sits under (lists keep the field name; the
    keys of an object are strings too)."""
    if depth > MAX_DEPTH:
        deny('a tool argument is nested too deeply to be checked')
    if isinstance(value, str):
        out.append((key, value))
    elif isinstance(value, dict):
        for k, v in value.items():
            out.append((key, str(k)))
            _collect_strings(v, str(k), depth + 1, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _collect_strings(v, key, depth + 1, out)
    if len(out) > MAX_STRINGS:
        deny('a tool argument holds too many strings to be checked')


def check_any_tool(tool: str, ti: dict, cwd: str) -> None:
    """The key may not be reached through any tool, whatever its name or field names are."""
    strings: list = []
    _collect_strings(ti, '', 0, strings)
    for field, text in strings:
        if tool in SEARCH_TOOLS and field == 'pattern':
            continue         # Grep: a regular expression is content; Glob: a name filter. The search rules below judge both
        if PATHISH_KEY.search(field.lower()):
            f = _protected_hit(text, cwd) or _word_reaches(text, cwd)
            if f:
                deny('the call reads or writes the claim signing key (%s) through the field %s' % (KEY_NAME, field[:40]), f)
        elif text and len(text) <= MAX_LENIENT and '\n' not in text and '\x00' not in text:
            f = _word_reaches(text, cwd, by_text=False)
            if f:
                deny('the call reads or writes the claim signing key (%s) through the field %s' % (KEY_NAME, field[:40]), f)


def check_file_tool(tool: str, ti: dict, cwd: str) -> None:
    check_any_tool(tool, ti, cwd)
    for key in FILE_PATH_KEYS:
        v = ti.get(key)
        if v is None:
            continue
        if not isinstance(v, str):
            deny('the %s of the call is not text' % key)
        hit = _protected_hit(v, cwd)
        if hit:
            deny('the call reads or writes the claim signing key (%s)' % KEY_NAME, hit)
    if tool not in SEARCH_TOOLS:
        return
    given = ti.get('path')
    base_real = _real(_absolute(given if isinstance(given, str) and given else cwd, cwd))
    if any(f.tier == 'A' and _inside(base_real, f.dir_real) for f in _protected_files()):
        deny('a search inside the store directory could return the claim signing key')
    selector = ti.get('glob') if tool == 'Grep' else ti.get('pattern')
    if selector is None:
        return
    if not isinstance(selector, str):
        deny('the glob of the call is not text')
    if KEY_NAME in selector.lower().replace('\\', ''):
        deny('the glob could match the claim signing key (%s)' % KEY_NAME)
    if os.path.isabs(selector) or '..' in selector.replace('\\', '/').split('/'):
        # an absolute pattern names its own directory, and `..` leaves the searched one: test the joined pattern from the root
        full = selector if os.path.isabs(selector) else os.path.normpath(os.path.join(base_real, selector))
        hit = _glob_selects_protected(full.lstrip('/'), base_real, False, rooted=True)
        if hit:
            deny('the pattern could match the claim signing key (%s)' % KEY_NAME, hit)
    else:
        hit = _glob_selects_protected(selector, base_real, tool == 'Grep')
        if hit:
            deny('the glob could match the claim signing key (%s)' % KEY_NAME, hit)


# ---------------------------------------------------------------------------------------------------
# Bash
# ---------------------------------------------------------------------------------------------------

_BOUNDARY_CLAIM = re.compile(r'(?:^|[/\s=:(,;|&<>{\[])\.claim', re.I)
_STORE_SEGMENT = re.compile(r'store/+([^\s/;|&<>()]*)')


def _spellings(text: str) -> list:
    t = text[:MAX_TEXT]
    t = re.sub(r"\$(?=['\"])", '', t)                  # $'..' / $".." : ANSI-C quoting
    plain = re.sub(r'[\\\'"`]', '', t)                 # quotes, backquotes and escapes removed
    glued = re.sub(r'\+|\$@|\$\*|\$\{\}', '', plain)   # 'a'+'b', "$@" empties
    return [t.lower(), plain.lower(), glued.lower()]


def _names_key_in_text(text: str) -> bool:
    """The strict text rules of a tier A file: its name anywhere in the text, in every spelling."""
    for f in _protected_files():
        if f.tier != 'A':
            continue
        hexed = f.name.encode().hex()
        for form in _spellings(text):
            if any(m in form for m in KEY_MARKERS) or _BOUNDARY_CLAIM.search(form):
                return True
            if f.name[::-1] in form:
                return True
            if hexed in re.sub(r'\\x|%|0x|\\u00|\s', '', form):
                return True
            for m in _STORE_SEGMENT.finditer(form):
                for alt in _brace_expand(m.group(1)):
                    if alt and (alt == f.name or (re.search(r'[*?\[]', alt) and _may_match_name(alt, f.name))):
                        return True
        raw = text[:MAX_TEXT].encode('utf-8', 'ignore')
        for pad in (0, 1, 2):
            # the middle of the encoding does not depend on the bytes around the name
            inner = base64.b64encode(b'\x00' * pad + f.name.encode()).decode()[4:-4]
            for variant in (inner, inner.replace('+', '-').replace('/', '_')):
                if variant and variant.encode() in raw:
                    return True
    return False


class _QWord(str):
    """A word of a command with the quote state of its characters: `mask[i]` is True when character i was quoted or
    escaped in the command text (a quoted or escaped brace, comma or dollar is literal to the shell). `mask` is None when
    that state could not be determined. Everything else treats it as the plain str it is."""
    mask = None


def _scan_masks(line: str):
    """[(text, mask)] per word, read the way `shlex.split(posix=True)` reads it, or None when the line does not parse."""
    words, cur, mask, in_word, i, n = [], [], [], False, 0, len(line)
    while i < n:
        c = line[i]
        if c in ' \t\r\n':
            if in_word:
                words.append((''.join(cur), mask))
                cur, mask, in_word = [], [], False
            i += 1
            continue
        in_word = True
        if c == '\\':
            if i + 1 >= n:
                return None
            cur.append(line[i + 1])
            mask.append(True)
            i += 2
        elif c == "'":
            j = line.find("'", i + 1)
            if j == -1:
                return None
            cur.extend(line[i + 1:j])
            mask.extend([True] * (j - i - 1))
            i = j + 1
        elif c == '"':
            i += 1
            while True:
                if i >= n:
                    return None
                d = line[i]
                if d == '"':
                    i += 1
                    break
                if d == '\\' and i + 1 < n and line[i + 1] in '"\\':
                    cur.append(line[i + 1])
                    mask.append(True)
                    i += 2
                    continue
                cur.append(d)
                mask.append(True)
                i += 1
        else:
            cur.append(c)
            mask.append(False)
            i += 1
    if in_word:
        words.append((''.join(cur), mask))
    return words


def _words(line: str) -> list:
    """The words of one simple command, with the quote state of each (`_QWord`). Never raises: an unparsable line is
    cut at spaces, and its words carry no quote state."""
    try:
        toks = shlex.split(line, posix=True)
    except ValueError:
        out = []
        for w in line.split():
            q = _QWord(re.sub(r'[\\\'"]', '', w))
            out.append(q)
        return out
    scanned = _scan_masks(line)
    agree = scanned is not None and len(scanned) == len(toks) and all(t == s[0] for t, s in zip(toks, scanned))
    out = []
    for k, t in enumerate(toks):
        q = _QWord(t)
        q.mask = scanned[k][1] if agree else None      # the scanner and shlex must read the same words, or the state is unknown
        out.append(q)
    return out


def _commands(text: str) -> list:
    """The simple commands of a shell text as token lists. Never raises: an unparsable line is cut at spaces."""
    out = []
    for line in re.split(r'[\n;]|&&|\|\||\||&(?!>)', text[:MAX_TEXT]):
        line = line.strip()
        if line:
            out.append(_words(line))
    return out


def _pipelines(text: str) -> list:
    """The pipelines of a shell text: a list of segments (token lists) per pipeline. A pipeline ends at `;`, a newline,
    `&&`, `||` or `&`; its segments are cut at a single `|` (`|&` too)."""
    out = []
    for stmt in re.split(r'[\n;]|&&|\|\||&(?!>)', text[:MAX_TEXT].replace('|&', '|')):
        segs = [_words(s.strip()) for s in stmt.split('|') if s.strip()]
        if len(segs) > 1:
            out.append(segs)
    return out


_WRAPPERS = ('env', 'command', 'exec', 'nohup', 'sudo', 'time', 'nice', 'builtin')


def _skip_wrappers(toks: list) -> list:
    i = 0
    while i < len(toks):
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[i]) or os.path.basename(toks[i]) in _WRAPPERS:
            i += 1
            continue
        break
    return toks[i:]


def _expand_word(word: str, cwd: str) -> list:
    """The paths a shell word names; a glob is expanded and dotfiles are included (the conservative reading)."""
    w = os.path.expanduser(word)
    if re.search(r'[*?\[]', w):
        try:
            if '[:' in w and _inside(_real(_absolute(os.path.dirname(w) or '.', cwd)), STORE_REAL):
                return [KEY_PATH]      # a POSIX class over the store directory: judged as selecting the key
            found = list(itertools.islice(globlib.iglob(_shell_glob(_absolute(w, cwd)), include_hidden=True), MAX_GLOB + 1))
            return [KEY_PATH] if len(found) > MAX_GLOB else found      # too many matches to look through: judged as selecting the key
        except (OSError, ValueError):
            return [w]
    return [w]


_POSIX_CLASS = {'lower': 'a-z', 'upper': 'A-Z', 'alpha': 'a-zA-Z', 'alnum': 'a-zA-Z0-9', 'digit': '0-9', 'xdigit': '0-9a-fA-F',
                'punct': '!-/:-@\\[-`{-~', 'print': ' -~', 'graph': '!-~', 'space': ' \\t\\n', 'blank': ' \\t', 'cntrl': '\\x00-\\x1f', 'word': 'a-zA-Z0-9_'}


def _posix_to_ranges(pat: str) -> str:
    """`[[:lower:]]` -> `[a-z]`: _glob_regex reads a bracket up to its first `]`, so a POSIX class has to be spelled out
    first. An unknown class name is read as any character."""
    return re.sub(r'\[:(\w+):\]', lambda m: _POSIX_CLASS.get(m.group(1), '\\x00-\\x7f'), pat)


def _tier_b_glob_selects(word: str, cwd: str):
    """The tier B file a shell word with a glob could select, from its TEXT (a file that does not exist yet, an agent
    whose token has not been written, is selected too). `*` and `?` match a leading dot: the conservative reading."""
    w = os.path.expanduser(word)
    if not re.search(r'[*?\[]', w):
        return None
    for alt in _brace_expand(w):
        p = _absolute(alt, cwd)
        glob_at = re.search(r'[*?\[]', p)
        if glob_at is None:
            # an alternative of a brace word that has no glob (`{*,.agent-token}`, a JSON text `{"a": 1, "b": "*"}`): it
            # names one path, no pattern to read; judged as a plain path, of EITHER tier (a link to the key counts), so
            # that a brace word the crash used to block by accident (`src/{k,x*}`) stays refused
            hit = _protected_hit(alt, cwd, True)
            if hit is not None:
                return hit
            continue
        cut = glob_at.start()
        slash = p.rfind('/', 0, cut)
        prefix, rest = (p[:slash] or '/'), p[slash + 1:]
        spellings = {os.path.normpath(p), os.path.join(_real(prefix), rest)}
        for spelled in spellings:
            try:
                rx = _glob_regex(_posix_to_ranges(_shell_glob(spelled)).lstrip('/'))
            except re.error:
                return next(f for f in _protected_files() if f.tier == 'B')      # a pattern we cannot read matches
            for f in _protected_files():
                if f.tier != 'B':
                    continue
                for target in (f.path, os.path.join(f.dir_real, f.name)):
                    if rx.fullmatch(os.path.normpath(target).lstrip('/')):
                        return f
    return None


def _word_reaches(word: str, cwd: str, by_text: bool = True):
    """The protected file a shell word reaches (itself, through a link, or through a glob); None when none."""
    if not word or (word.startswith('-') and '/' not in word):
        return None
    for c in _expand_word(word, cwd):
        f = _protected_hit(c, cwd, by_text)
        if f:
            return f
    return _tier_b_glob_selects(word, cwd)


def _has_flag(toks: list, short: str, longs: tuple) -> bool:
    for w in toks[1:]:
        if w.startswith('--'):
            if w.split('=', 1)[0] in longs:
                return True
        elif w.startswith('-') and len(w) > 1 and any(c in w[1:] for c in short):
            return True
    return False


_RECURSIVE_LONGS = ('recursive', 'dereference-recursive')
# Every long option name of the grep family, the GNU and the BSD names together. A word the user types is read the way
# getopt_long reads it: an exact name wins, otherwise it is a PREFIX and every name that starts with it is a candidate.
_GREP_LONGS = frozenset((
    'basic-regexp', 'extended-regexp', 'fixed-regexp', 'fixed-strings', 'perl-regexp', 'regexp', 'file', 'ignore-case', 'no-ignore-case',
    'word-regexp', 'line-regexp', 'null-data', 'no-messages', 'invert-match', 'version', 'help', 'max-count', 'byte-offset', 'line-number',
    'line-buffered', 'with-filename', 'label', 'no-filename', 'only-matching', 'quiet', 'silent', 'binary-files', 'text', 'directories',
    'devices', 'include', 'exclude', 'exclude-from', 'exclude-dir', 'include-dir', 'files-without-match',
    'files-with-matches', 'count', 'initial-tab', 'null', 'before-context', 'after-context', 'context', 'color', 'colour', 'binary',
    'unix-byte-offsets', 'no-group-separator', 'group-separator', 'mmap', 'smart-case', 'hidden', 'no-ignore', 'no-ignore-vcs',
    'unrestricted', 'glob', 'iglob', 'grep', 'message')) | frozenset(_RECURSIVE_LONGS)


def _resolve_grep_long(name: str) -> list:
    """The grep long options a typed name may mean: the name itself when it is one, else every option it is a prefix of."""
    if name in _GREP_LONGS:
        return [name]
    return sorted(n for n in _GREP_LONGS if name and n.startswith(name))


def _grep_option_effects(toks: list) -> tuple:
    """What the options of a grep command line do to its reach, from ONE resolver for the long names. Returns
    (recursive, unknown, consumed):
    `recursive`: some option reads a directory operand recursively. A long name counts when ANY candidate it may mean
    is `recursive` or `dereference-recursive` (a prefix two options share, `--re` or `--d`, makes a real grep stop with
    an error, and a mixed one is refused anyway: fail closed, the gate does not guess how an implementation resolves it),
    or when it is `--directories` (any prefix that names it, the value inline `--dir=recurse` or the next word) with an
    ACTION that is not exactly `read` or `skip`. The short `-d ACTION` is read the same way (`-d recurse`, `-drecurse`,
    `-nd recurse`; a value-taking letter before the `d`, as in `-ed`, `-A3d`, swallows it, so that `d` is no option).
    `unknown`: a long name that is no option and no prefix of one; the caller refuses it when the command names a
    directory that holds a protected file (fail closed, as for the exclude parse).
    `consumed`: the index of every word taken as an ACTION value, so that it is not counted as a file operand.
    Words after `--` are operands and are not read."""
    recursive, unknown, consumed = False, False, set()
    for i in range(1, len(toks)):
        t = toks[i]
        if t == '--':
            break
        if i in consumed:
            continue
        val = None
        if t.startswith('--') and len(t) > 2:
            name, eq, inline = t[2:].partition('=')
            cands = _resolve_grep_long(name)
            if not cands:
                unknown = True
            else:
                if any(c in _RECURSIVE_LONGS for c in cands):
                    recursive = True
                if 'directories' in cands:      # a prefix shared with another option would be mixed, and is refused above
                    val = inline if eq else (toks[i + 1] if i + 1 < len(toks) else '')
                    if not eq and i + 1 < len(toks):
                        consumed.add(i + 1)
        elif re.fullmatch(r'-[A-Za-z0-9]+', t):
            letters = t[1:]
            k = letters.find('d')
            if k >= 0 and all(c in SAFE_SHORT for c in letters[:k]):
                val = letters[k + 1:] or (toks[i + 1] if i + 1 < len(toks) else '')
                if not letters[k + 1:] and i + 1 < len(toks):
                    consumed.add(i + 1)
        if val is not None and val not in ('read', 'skip'):
            recursive = True
    return recursive, unknown, consumed


def _exclude_values(toks: list, strict: bool = False) -> list:
    """The values of the `--exclude` / `--exclude-dir` options of a grep (`--exclude=V`, `--exclude V`). They count ONLY
    when the whole command parses without doubt: every option is a known one that takes no value (SAFE_SHORT / SAFE_LONG),
    a `-e` / `-f` / `--regexp` / `--file` whose value is consumed, or one of `--exclude` / `--exclude-dir` / `--include`.
    Anything else (a long option with a value and no `=` such as `--label X`, an abbreviated or unknown long option, a
    short cluster with a value-taking letter) may swallow the next word, so the parse could disagree with grep about
    which word is an option: then NO exclude counts (fail closed).
    `strict` (tier B) keeps only the `--exclude` shape: an `--include*` or an `--exclude-dir*` anywhere in the command
    voids every exclude (the last matching include / exclude wins in grep, so an include can re-include the excluded
    file, and a directory exclude never excludes a file)."""
    if not toks or os.path.basename(toks[0]) not in EXCLUDE_HEADS:
        return []
    out, consumed = [], set()
    for i, t in enumerate(toks):
        if i == 0:
            continue      # the command itself
        if t == '--':
            break      # after `--` every word is an operand
        if i in consumed:
            continue
        if t.startswith('--'):
            name, eq, val = t[2:].partition('=')
            if name in ('exclude', 'exclude-dir', 'include'):
                if strict and name != 'exclude':
                    return []      # tier B: an include or a directory exclude in the command, whatever its order
                if name != 'include':
                    out.append(val if eq else (toks[i + 1] if i + 1 < len(toks) else ''))
                if not eq:
                    consumed.add(i + 1)      # the value of a filter option is that value, not an option of ours
            elif name in ('regexp', 'file'):
                if not eq:
                    consumed.add(i + 1)
            elif name not in SAFE_LONG or eq:
                return []      # unknown, abbreviated, or value-taking without a clear value: fail closed
        elif re.fullmatch(r'-[A-Za-z0-9]+', t):
            if t in ('-e', '-f'):
                consumed.add(i + 1)      # a pattern / pattern-file option: the next word is its value
            elif not all(c in SAFE_SHORT for c in t[1:]):
                return []      # a short option cluster with a value-taking letter (`-er`, `-cf`, `-A2`, `-5`)
        elif t.startswith('-') and t != '-':
            return []      # an option shape the parse does not know
    return out


def _excludes_store(toks: list) -> bool:
    return any(re.fullmatch(r'(?:\./)?(?:\*/)?store/?', val.strip()) for val in _exclude_values(toks))


def _excludes_file(toks: list, f: Protected, base_real: str) -> bool:
    """A recursive reader over `base_real` that excludes the protected file `f` does not read it. Tier A: the store is
    excluded (the key sits in it). Tier B: ONE shape only. The grep carries `--exclude=NAME` (or `--exclude NAME`) whose
    NAME is the token file's dotted name EXACTLY (no slash, no glob, no `./`, no case folding), every `--exclude` of the
    command names it, there is no `--include*`, no `--exclude-dir*` and no `--exclude-from` anywhere, and no word of the
    command holds `$`, a backtick or `{` (an unresolved word can carry an include: `$EXTRA`, `$(echo --include='*')`,
    `{--include=*,}`). Anything else excludes nothing: the implementations differ in the order they apply include and
    exclude, so the gate does not depend on it."""
    if f.tier == 'A':
        return _excludes_store(toks)
    if any(c in w for w in toks for c in ('$', '`', '{')):
        return False
    vals = _exclude_values(toks, strict=True)
    return bool(vals) and all(v == f.name for v in vals)


def _covered_dir_files(path: str, cwd: str) -> list:
    """(real directory, protected file) pairs a recursive reader over `path` reaches: `path` is a directory that holds
    the key's directory (tier A, whether or not the key exists) or an existing tier B token file."""
    try:
        if not os.path.isdir(_absolute(path, cwd)):
            return []
        base = _real(_absolute(path, cwd))
        return [(base, f) for f in _covered_files(path, cwd) if f.tier == 'A' or os.path.lexists(f.path)]
    except (OSError, ValueError):
        return [(_real(cwd), f) for f in _protected_files()]      # cannot tell: judged as reaching every file


# Options whose VALUE is a filter or a pattern, not a path: a name there is not a read (`--exclude=.agent-token`).
FILTER_FLAGS = frozenset(('exclude', 'include', 'exclude-dir', 'include-dir', 'regexp', 'glob', 'iglob', 'grep', 'message'))
FILTER_HEADS = GREP_FAMILY | RG_FAMILY | frozenset(('git', 'tar', 'gtar', 'bsdtar', 'rsync', 'zip'))
# Short options of grep / rg that take NO value, and long options likewise: only a command made of these (plus -e / the
# filter options) lets the first plain word be read as the PATTERN.
SAFE_SHORT = frozenset('rRnilLcvwxsHhoEFGPaIzZqTyUb')
SAFE_LONG = frozenset(('recursive', 'dereference-recursive', 'ignore-case', 'line-number', 'hidden', 'no-ignore', 'no-ignore-vcs', 'unrestricted',
                       'files-with-matches', 'files-without-match', 'count', 'invert-match', 'word-regexp', 'line-regexp', 'fixed-strings',
                       'extended-regexp', 'perl-regexp', 'no-messages', 'with-filename', 'no-filename', 'only-matching', 'smart-case', 'quiet'))
# Commands whose --exclude option is a real filter (find, cp, zip and the rest have none: the word is an operand there).
EXCLUDE_HEADS = GREP_FAMILY      # tar is out (its bundled `czf` word and `-f` value hide the archive name), rsync too (`--filter`, `-e`, `--files-from` take values)


def _nonpath_words(toks: list) -> set:
    """Indexes of the words that are a pattern or a filter value, not a path: the value of --exclude / --include /
    --regexp / --glob / --grep / --message (inline or the next word), of `-e` (grep, rg) and `-m` (git), and the
    PATTERN of a grep that was given none with -e / --regexp / -f. The dotted-name rule skips them."""
    head = os.path.basename(toks[0]) if toks else ''
    skip: set = set()
    if head not in FILTER_HEADS:
        return skip
    is_grep = head in GREP_FAMILY or head in RG_FAMILY
    pattern_given = False
    unclear = False      # an option with a value the parse cannot place: then NO word is guessed to be the pattern
    for i in range(1, len(toks)):
        t = toks[i]
        if t == '--':
            break      # every word after `--` is an operand, never an option
        if t.startswith('--') and len(t) > 2:
            name, eq, _ = t[2:].partition('=')
            if name in ('regexp', 'file'):
                pattern_given = True      # the patterns come from the option: the plain words are all files
            if name in FILTER_FLAGS:
                skip.add(i)
                if not eq and i + 1 < len(toks):
                    skip.add(i + 1)
                pattern_given = pattern_given or name == 'regexp'
        elif is_grep and re.fullmatch(r'-[A-Za-z0-9]+', t):
            letters = t[1:]
            if letters[-1] in 'eg' and all(c in SAFE_SHORT for c in letters[:-1]):
                if i + 1 < len(toks):
                    skip.add(i + 1)      # `-e PATTERN`, `-ne PATTERN`, rg `-g GLOB`
                pattern_given = pattern_given or letters[-1] == 'e'
            elif not all(c in SAFE_SHORT for c in letters):
                unclear = True           # `-f`, `-m 5`, `-er`, `-A3`: a value is attached or follows, which word is the pattern is unclear
        if t.startswith('--') and len(t) > 2 and t[2:].partition('=')[0] not in SAFE_LONG | FILTER_FLAGS | {'regexp', 'file'}:
            unclear = True      # an unknown or ABBREVIATED long option (`--fil=pats`): which word is the pattern is unclear
        elif head == 'git' and t in ('-m', '-S', '-G') and i + 1 < len(toks):
            skip.add(i + 1)
    if is_grep and not pattern_given and not unclear and '--' not in toks:
        for i in range(1, len(toks)):
            if i not in skip and not toks[i].startswith('-'):
                skip.add(i)      # the PATTERN, the first word that is not an option
                break
    return skip


def _word_variants(w: str) -> list:
    """A word and the paths it may carry glued to something else: a redirection (`<.agent-token`, `>x`), a substitution
    or quote around it (`$(cat x)`, `'x')`), an assignment or an option value (`X=path`, `--file=path`), a `host:path`."""
    out = [w]
    s = w.lstrip('<>&')
    for cand in (s, s.strip('()`;|&<>"\'$')):
        if cand and cand not in out:
            out.append(cand)
    if '=' in s or ':' in s:
        out.extend(p for p in re.split(r'[=:,]', s) if p)
    return out


# A tier B dotted name INSIDE a longer word (the code of `python3 -c "open('store/<name>')"`, `$(cat x/<name>)`): preceded
# by a path separator, a quote, a paren, `=`, `:`, a backtick or `$`, and not followed by another name character. A name
# after a space (free text: "the <name> file") is not a hit.
_TIER_B_EMBEDDED = re.compile(r"(?:^|[/'\"(=:`$])(" + '|'.join(re.escape(n) for n in sorted(TIER_B_NAMES, key=len, reverse=True)) + r")(?![A-Za-z0-9_.\-])", re.I)


def _embedded_token(w: str):
    m = _TIER_B_EMBEDDED.search(w)
    if not m:
        return None
    name = m.group(1).lower()
    return next((f for f in _protected_files() if f.name == name), None)


def _find_roots(toks: list) -> list:
    """The words of a find that may be a start directory: every word that is not an option (the over-approximation the
    other readers use), plus `.` when no start directory leads the expression: GNU find then searches the cwd."""
    roots = [w for w in toks[1:] if w and not w.startswith('-')]
    i = 1
    while i < len(toks) and toks[i] in ('-H', '-L', '-P', '-E', '-X', '-x', '-s', '-d'):
        i += 1
    if i >= len(toks) or toks[i][:1] in ('-', '(', '!', ','):
        roots.append('.')      # no leading start directory
    return roots


def _find_reach(toks: list, cwd: str):
    """The ONE decision for a find whose file list ends up in a reader (`-exec`, or a pipe into xargs / parallel): the
    protected file the find reaches over its start directories, or None. A `-prune` anywhere is the carve-out (the
    walk can skip the store, and no filter is parsed any further). Both callers use this function, so the two
    routes cannot judge differently."""
    if '-prune' in toks:
        return None
    for w in _find_roots(toks):
        for alt in _brace_alternatives(w):
            for c in _expand_word(alt, cwd):
                for _base, f in _covered_dir_files(c, cwd):
                    return f
    return None


# The command word an xargs / parallel hands the found files to: these read them (or run what the word says).
LAUNCHER_READERS = (GREP_FAMILY | RG_FAMILY | frozenset((
    'cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'cut', 'sort', 'strings', 'xxd', 'od', 'base64', 'nl', 'tac', 'cp', 'mv', 'tar', 'zip',
    'gzip', 'diff', 'gsed', 'gawk')))
LAUNCHER_INTERPRETERS = frozenset(('sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby'))
# xargs / parallel options as getopt reads them: (short letters without a value, short letters that take a value (attached
# or the next word), short letters with an optional attached value, long names without a value, long names with a
# value (`=V` or the next word), long names with an optional `=V`). Anything else is not decided: deny.
_LAUNCHER_OPTS = {
    'xargs': ('0oprtx', 'nPLsIJERSda', 'iel', frozenset(('null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty')),
              frozenset(('max-args', 'max-procs', 'max-chars', 'delimiter', 'arg-file', 'process-slot-var')), frozenset(('replace', 'eof', 'max-lines'))),
    'parallel': ('0kXmqrtvuU', 'jnNPSaI', '', frozenset(('null', 'keep-order', 'will-cite', 'no-notice', 'bar', 'eta', 'progress', 'verbose', 'xargs', 'no-run-if-empty')),
                 frozenset(('jobs', 'max-args', 'max-procs', 'replace', 'sshlogin', 'arg-file')), frozenset()),
}


def _launcher_command(toks: list) -> tuple:
    """(command word, decided) of an xargs / parallel word list: the first word after its own options. `decided` is
    False when an option is not a known one or the command word cannot be read without running a shell (a variable,
    a substitution, a glob, a leading dash behind a wrapper): the caller refuses it (fail closed)."""
    noval, valued, optional, lnoval, lvalued, loptional = _LAUNCHER_OPTS[os.path.basename(toks[0])]
    i = 1
    while i < len(toks):
        t = toks[i]
        if t == '--':
            i += 1
            break
        if t.startswith('--'):
            name, eq, _ = t[2:].partition('=')
            if name in lnoval and not eq:
                i += 1
            elif name in lvalued:
                i += 1 if eq else 2
            elif name in loptional:
                i += 1
            else:
                return None, False
            continue
        if t.startswith('-') and len(t) > 1:
            letters, step = t[1:], 1
            for j, c in enumerate(letters):
                if c in noval:
                    continue
                if c in valued:
                    step = 1 if letters[j + 1:] else 2      # the value is attached, or it is the next word
                    break
                if c in optional:
                    break
                return None, False
            i += step
            continue
        break
    rest = _skip_wrappers(toks[i:])
    if not rest:
        return None, True      # no command word: xargs runs echo
    word = rest[0]
    if not word or word.startswith('-') or re.search(r'[$`(){}<>*?\[\]\\]', word):
        return None, False
    return os.path.basename(word), True


def _check_find_pipe(segs: list, cwd: str) -> None:
    """`find ... | xargs READER`: the first segment of a pipeline is a find that reaches a protected file and a later
    segment is an xargs / parallel whose command word is a reader or an interpreter (or cannot be decided). The find
    judgment is `_find_reach`, the same one `find -exec` uses. Not covered (accepted limits): `while read f; do cat
    "$f"; done`, `for f in $(find ...)`, `ls -R | xargs`, a find that is not the FIRST segment, a launcher behind a
    wrapper that takes options (`nice -n5 xargs`), and any other consumer of the list (`xargs git add`, a hash tool)."""
    src = _skip_wrappers(segs[0])
    if not src or os.path.basename(src[0]) != 'find':
        return
    consumers = [t for t in (_skip_wrappers(s) for s in segs[1:]) if t and os.path.basename(t[0]) in _LAUNCHER_OPTS]
    if not consumers:
        return
    reached = _find_reach(src, cwd)
    if reached is None:
        return
    for t in consumers:
        word, decided = _launcher_command(t)
        if not decided or (word is not None and (word in LAUNCHER_READERS or word in LAUNCHER_INTERPRETERS)):
            deny('a find over a directory that holds the store piped into %s would read the claim signing key' % os.path.basename(t[0]), reached)


def check_bash(cmd: str, cwd: str) -> None:
    _brace_work[0] = 0      # the brace expansion work cap is per command
    if _names_key_in_text(cmd):
        deny('the command names the claim signing key (%s) or a glob that could match it' % KEY_NAME)
    plain_cmd = re.sub(r"\$(?=['\"])", '', cmd)      # $'..' / $"..": ANSI-C quoting, read as plain quotes
    for segs in _pipelines(plain_cmd):
        _check_find_pipe(segs, cwd)
    for all_toks in _commands(plain_cmd):
        toks = _skip_wrappers(all_toks)
        skip = {i + len(all_toks) - len(toks) for i in _nonpath_words(toks)}
        # every word, the assignments and wrappers in front of the command included: `F=.agent-token cat "$F"`
        for idx, w in enumerate(all_toks):
            if idx in skip:
                continue
            for alt in _brace_alternatives(w):      # a brace word is several paths: each one is judged
                for v in _word_variants(alt):
                    f = _word_reaches(v, cwd)
                    if f:
                        deny('a path in the command resolves to the claim signing key', f)
                f = _embedded_token(alt)
                if f:
                    deny('a path in the command names a token file', f)
        if not toks:
            continue
        head = os.path.basename(toks[0])
        opt_recursive, opt_unknown, dir_values = _grep_option_effects(toks) if head in GREP_FAMILY else (False, False, set())
        # the ACTION word of `-d ACTION` / `--directories ACTION` is the option's value, not a file operand
        operands = [w for idx, w in enumerate(toks) if idx and w and not w.startswith('-') and idx not in dir_values]
        covering = []
        for w in operands:
            # the operand COUNT above is the one of the typed words; the directories they cover include every brace alternative
            pairs = [pr for alt in _brace_alternatives(w) for c in _expand_word(alt, cwd) for pr in _covered_dir_files(c, cwd)]
            if pairs:
                covering.append(pairs)
        if opt_unknown and covering:
            # a long option that is no known grep option nor a prefix of one: which reach it has is not decided
            deny('a grep option the gate does not know, over a directory that holds a protected file', covering[0][0][1])
        grep_recursive = head in GREP_FAMILY and (_has_flag(toks, 'rR', ('--recursive', '--dereference-recursive'))
                                                  or opt_recursive
                                                  # the former check, kept so no verdict loosens: `-d` and the word `recurse` anywhere
                                                  or ('-d' in toks and 'recurse' in toks))
        if grep_recursive and len(operands) <= 1:
            own = _covered_dir_files(cwd, cwd)
            if own:
                covering = [own]      # grep -r PATTERN searches the current directory
        if head == 'find' and any(w in FIND_EXEC for w in toks):
            f = _find_reach(toks, cwd)      # the same decision the find | xargs check uses
            if f:
                deny('find -exec over a directory that holds the store could read the claim signing key', f)
        # a recursive reader reaches a protected file unless the command excludes it
        reached = next((f for pairs in covering for base, f in pairs if not _excludes_file(toks, f, base)), None)
        if reached is None:
            continue
        if grep_recursive:
            deny('a recursive grep over a directory that holds the store would read the claim signing key', reached)
        if head in RG_FAMILY and any(w in ('--hidden', '--no-ignore', '--no-ignore-vcs', '--unrestricted') or re.fullmatch(r'-[A-Za-z]*u+[A-Za-z]*', w) for w in toks[1:]):
            deny('a search that includes hidden or ignored files over a directory that holds the store would read the claim signing key', reached)
        if head in ARCHIVERS or (head in COPIERS and _has_flag(toks, 'rRaA', ('--recursive', '--archive'))):
            deny('copying or archiving a directory that holds the store would take the claim signing key', reached)


# ---------------------------------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------------------------------

def _note_session(event):
    '''Hand the session id of the event to the audit module, which files it as the trace_id of a deny row. Nothing
    else of the event goes with it. Never raises and never changes the verdict.'''
    try:
        from gate_audit_lib import note_event
        note_event(event)
    except Exception:  # noqa: BLE001 -- the audit is optional; the verdict never depends on it
        pass


def decide(raw: str) -> None:
    try:
        payload = json.loads(raw)
    except Exception:  # noqa: BLE001
        deny('the hook input is not JSON')
    if not isinstance(payload, dict) or not isinstance(payload.get('tool_name'), str) or not isinstance(payload.get('tool_input'), dict):
        deny('the hook input has no tool_name or its tool_input is not an object')
    _note_session(payload)
    tool, ti = payload['tool_name'], payload['tool_input']
    cwd = payload.get('cwd') if isinstance(payload.get('cwd'), str) and payload.get('cwd') else os.getcwd()
    if tool == 'Bash':
        cmd = ti.get('command')
        if not isinstance(cmd, str):
            deny('the command of a Bash call is not text')
        check_bash(cmd, cwd)
        return
    check_file_tool(tool, ti, cwd)


def main() -> None:
    try:
        decide(sys.stdin.read())
    except Block as why:
        if why.protected is not None and why.protected.tier == 'B':
            # tier B: generic wording, the file NAME only (never a path, an agent id or content)
            sys.stderr.write('SECRET READ GATE: BLOCKED -- a token file is not for an agent to read or change (%s).\n' % why.protected.name)
        else:
            sys.stderr.write('SECRET READ GATE: BLOCKED -- %s. The key store/%s is not for an agent to read or change.\n' % (why, KEY_NAME))
        sys.exit(2)
    except BaseException as exc:  # noqa: BLE001 -- fail closed: a bug is a block
        sys.stderr.write('SECRET READ GATE: BLOCKED -- internal error while checking the call (%s).\n' % type(exc).__name__)
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
        audited('secret-read-gate', main, deny_row=True)
