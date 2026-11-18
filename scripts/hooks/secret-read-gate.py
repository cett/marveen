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
BRACE_MAX_WORK = 1000000     # characters scanned for the whole command (both readings of the braces count)
_SEQ = re.compile(r'([-+]?\d+|[A-Za-z])\.\.([-+]?\d+|[A-Za-z])(?:\.\.([-+]?\d+))?')
_brace_work = [0]


class _BraceTooBig(Exception):
    pass


def _brace_group(s: str):
    """The OUTERMOST brace group of `s` that bash expands: (start, end, kind, body-or-parts). A group has a comma at its
    top level or is a sequence `x..y[..step]`; `{x}`, `{}` and `${...}` are not groups. A brace that is no group is
    skipped, so an inner group of it is still found (`{{a,b}}`). One pass with a stack of open braces: the work is linear
    in len(s) whatever the input (20000 opening braces, an unmatched one, 50000 closing ones)."""
    _brace_work[0] += len(s)
    if _brace_work[0] > BRACE_MAX_WORK:
        raise _BraceTooBig()
    stack, best = [], None      # open braces: [position, commas, is a ${ parameter expansion]
    for pos, c in enumerate(s):
        if c == '{':
            stack.append([pos, [], pos > 0 and s[pos - 1] == '$'])
        elif c == '}' and stack:
            start, commas, dollar = stack.pop()
            if dollar or (best is not None and best[0] < start):
                continue
            if commas:
                cuts = [start] + commas + [pos]
                best = (start, pos, 'list', [s[cuts[k] + 1:cuts[k + 1]] for k in range(len(cuts) - 1)])
            elif pos - start <= 64:
                seq = _SEQ.fullmatch(s[start + 1:pos])
                if seq:
                    best = (start, pos, 'seq', seq)
        elif c == ',' and stack:
            stack[-1][1].append(pos)
    return best


def _brace_sequence(m) -> list:
    """The words of `{a..b[..step]}` (see `_brace_sequence_words`). A group with a plus sign is expanded by bash (3.2 for an end,
    4+ perhaps for a step) and left as TEXT by zsh, so its text is one of its words too: next to a list group (`{x,d}{1..3..+1}`)
    the whole-word reading does not cover `d{1..3..+1}`, the zsh word."""
    words = _brace_sequence_words(m)
    # (the match is the text between the braces; the braces are the marked ones, a brace of the text is no group to expand again)
    text = _MARK['{'] + m.group(0) + _MARK['}']
    if '+' in m.group(0) and text not in words:
        words.append(text)
    return words


def _brace_sequence_words(m) -> list:
    """The words of `{a..b[..step]}`: integers (zero padded when an end has a leading zero, and the unpadded words too, see
    below) or single letters."""
    a, b, step = m.group(1), m.group(2), m.group(3)
    if a.lstrip('+-').isdigit() and b.lstrip('+-').isdigit():
        # an end may carry a plus sign: bash 3.2 expands `{0..+1}` to `0 1` (and never pads it), zsh leaves it as text. The sign is
        # part of the width below, so the superset of widths covers it; the text itself is judged as a word too (`_brace_alternatives`)
        da, db = a.lstrip('+-'), b.lstrip('+-')
        lo, hi = int(a), int(b)
        # a shell may pad when an end has a leading zero or a sign, or the step has a leading zero (see below); the width of
        # the widest of them, its sign included, bounds every width a shell uses
        zero = lambda d: len(d) > 1 and d.startswith('0')
        padded = zero(da) or zero(db) or a.startswith('-') or b.startswith('-') or bool(step and zero(step.lstrip('+-')))
        width = max(len(a), len(b), len(step or '')) if padded else None
    elif a.isalpha() and b.isalpha():
        lo, hi, width = ord(a), ord(b), None
    else:
        return [m.group(0)]      # mixed ends: bash leaves it as text
    inc = (abs(int(step)) or 1) if step else 1
    n = abs(hi - lo) // inc + 1
    if n > BRACE_MAX_ALTS:
        raise _BraceTooBig()
    seq = range(lo, hi + 1, inc) if lo <= hi else range(lo, hi - 1, -inc)
    if a.isalpha():
        return [chr(v) for v in seq]
    if width is None:
        return [('-' if v < 0 else '') + str(abs(v)) for v in seq]
    # `{1..03}`, `{01..03}`, `{-1..1}`, `{1..3..01}`: bash 3.2 does not pad (1 2 3), bash 4+ and zsh do, but each by a rule of its
    # own: zsh takes the width of the FIRST end when it starts with a zero and else of the second, the sign counts in the width, and
    # a step with a leading zero pads as well (`pad-{01..010}` is `pad-01 ... pad-010` to zsh, whose width is that of `01`).
    # The word of the shell that runs the command is any of them, so ONE superset is judged instead of a model of each rule: every
    # integer of the sequence at every width from 0 to width + 1 (the sign kept in front of the digits, which gives the width with
    # and without the sign). The words of the FINAL expansion are what the cap counts.
    out, seen = [], set()
    for k in range(width + 2):
        for v in seq:
            w = ('-' if v < 0 else '') + str(abs(v)).zfill(k)
            if w not in seen:
                seen.add(w)
                out.append(w)
                if len(out) > BRACE_MAX_ALTS:
                    raise _BraceTooBig()
    return out


def _brace_all(s: str, depth: int = 0) -> list:
    """Every word of `s` after its brace groups are expanded, outermost group first. The cap is on the size of each result
    list (a list holds only words that are also in the final one), so exactly the words of the FINAL expansion are
    counted: `{a..z}{a..z}` is 676, under the cap, and 1025 are over it."""
    if depth > 24:
        raise _BraceTooBig()
    g = _brace_group(s)
    if g is None:
        return [s]
    i, j, kind, body = g
    parts = body if kind == 'list' else _brace_sequence(body)
    out = []
    for part in parts:
        out.extend(_brace_all(s[:i] + part + s[j + 1:], depth + 1))
        if len(out) > BRACE_MAX_ALTS:
            raise _BraceTooBig()
    return out


# The pairing rule of bash's own brace expansion (braces.c), which is NOT the nesting of _brace_group: the closing brace of
# a group is the first `}` at depth zero AFTER a comma (or `..`) at depth zero, so a balanced pair in front of the commas
# (`{b},x,{}}`) does not close it, and its text becomes part of the first alternative. `${...}` and `$(...)` are passed
# through unchanged. A word is judged against BOTH readings (the union), so a shell that nests (zsh) or pairs the bash
# way is covered. Two bash rules are left out on purpose, both on the safe side: the one that ignores a `{` between
# blanks (a quoted blank would count) and the carve-out of a group with an unquoted-comma-less body (kept literal).
def _bb_skip_subst(t: str, i: int) -> int:
    """The index after the `)` that closes a command or process substitution whose body starts at `i` (a quoted
    parenthesis is a private-use character in the marked text, so only the unquoted ones count)."""
    depth, n = 0, len(t)
    while i < n:
        c = t[i]
        if c == '(':
            depth += 1
        elif c == ')':
            if depth == 0:
                return i + 1
            depth -= 1
        i += 1
    return n


def _bb_gobble(t: str, i: int, satisfy: str):
    """bash's brace_gobbler: from `i` to the first `satisfy` character at depth zero; for the closing brace one comma or
    `..` at depth zero must have been seen first. Returns (index, the character found or '')."""
    n, level = len(t), 0
    commas = 0 if satisfy == '}' else 1
    while i < n:
        c = t[i]
        nxt = t[i + 1] if i + 1 < n else ''
        if c == '$' and nxt == '{':
            level += 1
            i += 2
            continue
        if c in '$<>' and nxt == '(':
            i = _bb_skip_subst(t, i + 2)
            continue
        if c == satisfy and level == 0 and commas > 0:
            return i, c
        if c == '{':
            level += 1
        elif c == '}' and level:
            level -= 1
        elif satisfy == '}' and level == 0:
            if c == ',':
                commas += 1
            elif c == '.' and nxt == '.' and t[i + 2:i + 3] != ',':
                commas += 1
        i += 1
    return i, ''


def _bb_expand(t: str, depth: int = 0) -> list:
    """The words bash makes of the marked text `t` by brace expansion (its braces.c, see above). Same caps as _brace_all."""
    if depth > 200:
        raise _BraceTooBig()
    _brace_work[0] += len(t)
    if _brace_work[0] > BRACE_MAX_WORK:
        raise _BraceTooBig()
    i, c = _bb_gobble(t, 0, '{')
    pre = t[:i]
    if c != '{':
        return [pre]
    start = i + 1
    j, c2 = _bb_gobble(t, start, '}')
    if c2 != '}':
        return [t]      # no closing brace: bash leaves the text (or fails the command); the nesting reading covers the rest
    amble = t[start:j]
    if ',' not in amble:
        seq = _SEQ.fullmatch(amble) if len(amble) <= 64 else None
        if seq:
            tack = _brace_sequence(seq)
        elif j + 1 < len(t):
            tack = ['{' + amble + '}']      # no expansion: the braces stay and the rest of the word is looked at
        else:
            return [t]
    else:
        tack, k = [], 0
        while True:
            e, ch = _bb_gobble(amble, k, ',')
            tack.extend(_bb_expand(amble[k:e], depth + 1))
            if len(tack) > BRACE_MAX_ALTS:
                raise _BraceTooBig()
            if not ch:
                break
            k = e + 1
    out = [pre + x for x in tack]
    post = t[j + 1:]
    if post:
        rest = _bb_expand(post, depth + 1)
        if len(out) * len(rest) > BRACE_MAX_ALTS:
            raise _BraceTooBig()
        out = [a + b for a in out for b in rest]
    return out


# A quoted or escaped brace, comma, dollar or parenthesis is literal to the shell: it is swapped for a private-use
# character while the expansion runs, and swapped back in the alternatives.
_MARK = {'{': '', '}': '', ',': '', '$': '', '(': '', ')': ''}
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
        if len(word) > BRACE_MAX_WORD:      # over the cap: judged without a search for groups
            if '{' in word:
                deny('a long word of the command holds a brace and its quoting could not be read (brace expansion)')
            return [word]
        try:
            unread = _brace_group(str(word)) is not None or _bb_expand(str(word)) != [str(word)]
        except _BraceTooBig:
            unread = True
        if unread:
            deny('a word of the command holds a brace group and its quoting could not be read (brace expansion)')
        return [word]
    if len(mask) != len(word) or any(ch in _UNMARK for ch in word):
        deny('a word of the command could not be read for brace expansion')
    marked = ''.join(_MARK[ch] if (m and ch in _MARK) else ch for ch, m in zip(word, mask))
    if '{' not in marked or ('..' not in marked and ',' not in marked):
        return [word]      # the braces, if any, are quoted
    try:
        if len(word) > BRACE_MAX_WORD:      # over the cap, with an unquoted brace in it: refused without a search
            raise _BraceTooBig()
        alts = list(dict.fromkeys(_brace_all(marked) + _bb_expand(marked)))      # both readings of the braces
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


_SPACE = ' \t\r\n'
_SPAN_BUDGET = 30      # characters (per character of the text) that the end finders of the ${ } and $[ ] spans may read in all: linear
_SCAN_DEPTH = 16      # nested command substitutions the quote scanner follows; deeper is "state unknown"


def _shlex_view(line: str):
    """What `shlex.split(posix=True)` makes of `line`, as raw indices: [(kept, shq, start, end)] per word, or None when
    it does not parse. The text of a word is the characters at its kept indices (a quote or the backslash of an escape is
    not kept); `shq` is the set of kept indices that shlex reads as quoted or escaped (shlex toggles at EVERY double quote,
    so after an inner quote it reads the rest of a command substitution the other way round); the span is where the word
    lies in `line`."""
    words, n, i = [], len(line), 0
    while i < n:
        if line[i] in _SPACE:
            i += 1
            continue
        start, kept, shq = i, [], set()
        while i < n and line[i] not in _SPACE:
            c = line[i]
            if c == '\\':
                if i + 1 >= n:
                    return None
                kept.append(i + 1)
                shq.add(i + 1)
                i += 2
            elif c == "'":
                j = line.find("'", i + 1)
                if j == -1:
                    return None
                kept.extend(range(i + 1, j))
                shq.update(range(i + 1, j))
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
                    if d == '\\':
                        if i + 1 >= n:
                            return None
                        if line[i + 1] in '"\\':
                            kept.append(i + 1)
                            shq.add(i + 1)
                        else:
                            kept.extend((i, i + 1))      # shlex keeps the backslash before any other character
                            shq.update((i, i + 1))
                        i += 2
                    else:
                        kept.append(i)
                        shq.add(i)
                        i += 1
            else:
                kept.append(i)
                i += 1
        words.append((kept, shq, start, i))
    return words


_WORD_END = ' \t\n;&|()<>'      # ends the delimiter word of a here-document
def _comment_ok_after(text: str, i: int) -> bool:
    """May a `#` open a comment right after `text[i]`? (bash 3.2 and zsh.) Yes at the start of a word: after a blank, a tab, a
    newline, `;`, `(` and `)`, and after a `|` or `&` that is a control operator (`|`, `||`, `&`, `&&`). NO right after a
    redirection operator, where the `#x` is the target word: `<`, `>`, `>>`, `<>`, `>&`, `<&`, `&>`, `>|`, `|&`, `<<<`. A
    `#` taken for a comment where the shell reads code hides the commands behind it; a `#` taken for code where the shell
    reads a comment only refuses more."""
    c = text[i]
    if c in ' \t\n;()':
        return True
    if c == '|':      # `>|` and `|&` are redirections
        return text[i - 1:i] != '>' and text[i + 1:i + 2] != '&'
    if c == '&':      # `>&`, `<&`, `|&` and `&>` are redirections
        return text[i - 1:i] not in ('>', '<', '|') and text[i + 1:i + 2] != '>'
    return False


def _command_start(text: str, i: int) -> bool:
    """Is `text[i]` the first character of a command: the start of the text, or only blanks behind a `;`, `(`, a newline that no
    backslash continues, or a control operator (`|`, `||`, `&`, `&&`, not a redirection)? Anything else (a word, a keyword, `{`,
    `)`) is no certain command start, and the caller then reads on as code."""
    k = i - 1
    while k >= 0 and text[k] in ' \t':
        k -= 1
    if k < 0 or text[k] in ';(':
        return True
    if text[k] == '\n':
        return text[k - 1:k] != '\\'
    return text[k] in '|&' and _comment_ok_after(text, k)
_HEREDOC_BAD = object()          # _heredoc_operator: the delimiter word has an unterminated quote


def _heredoc_operator(text: str, i: int):
    """The here-document operator at `text[i:]` (`<<` or `<<-`; a here-string `<<<` has no delimiter word, the next character
    is a `<`): (delimiter, strip_tabs, quoted, end) where `quoted` says that the delimiter word has a quote or a backslash in it (the body is then a literal),
    None when no delimiter word follows (not a here-document), _HEREDOC_BAD when a quote of the word is not closed."""
    n, j, strip = len(text), i + 2, False
    if j < n and text[j] == '-':
        strip, j = True, j + 1
    while j < n and text[j] in ' \t':
        j += 1
    delim, quoted = [], False
    while j < n and text[j] not in _WORD_END:
        c = text[j]
        if c == '\\':
            quoted = True
            if j + 1 < n:
                delim.append(text[j + 1])
            j += 2
        elif c == '$' and text.startswith("'", j + 1):
            # `<<$'EOF'`: an ANSI-C string is a quoted part of the delimiter word, read by bash's rule (a backslash escapes the
            # next character, the quote included). Its first reading (bash, cut at a NUL) is the delimiter
            k = _ansi_c_end(text, j)
            if k == -1:
                return _HEREDOC_BAD
            quoted = True
            delim.append(_ansi_span_value(_ansi_span_tokens(text[j + 2:k - 1]), False, lambda: 0)[0])
            j = k
        elif c == '$' and text.startswith('"', j + 1):
            j += 1      # `<<$"EOF"`: a locale string is a double-quoted one, the `$` is no part of the word
        elif c == "'":
            k = text.find("'", j + 1)
            if k == -1:
                return _HEREDOC_BAD
            quoted = True
            delim.append(text[j + 1:k])
            j = k + 1
        elif c == '"':
            quoted, k = True, j + 1
            while k < n and text[k] != '"':
                if text[k] == '\\' and k + 1 < n and text[k + 1] in '"\\$`':
                    k += 1
                delim.append(text[k])
                k += 1
            if k >= n:
                return _HEREDOC_BAD
            j = k + 1
        else:
            delim.append(c)
            j += 1
    if not delim:
        return None
    return ''.join(delim), strip, quoted, j


def _heredoc_body(text: str, i: int, here: tuple, quoted: list, out):
    """Skip the body of one here-document that starts at the line start `i`; returns the index after its delimiter line (the
    end of the text when the delimiter never comes, which is what a shell does too). An UNQUOTED delimiter makes the body a
    double-quote-like text: command substitutions in it run at once and an apostrophe is a literal; they are appended to
    `out` when it is given. A quoted delimiter makes the body a literal. Returns None when a substitution is not closed."""
    delim, strip, qd = here
    n = len(text)
    while i < n:
        eol = text.find('\n', i)
        end = n if eol == -1 else eol
        line = text[i:end]
        if (line.lstrip('\t') if strip else line) == delim:
            return min(end + 1, n)
        if qd or out is None:
            i = end + 1
            continue
        k = i
        while k < n and text[k] != '\n':      # a substitution may run past the end of the line
            if text[k] == '\\':
                k += 2
                continue
            j = _body_at(text, k, quoted, out, True)
            if j is None:
                return None
            k = j if j != k else k + 1
        i = k + 1
    return n


def _bash_subst(line: str, i: int, closer: str, quoted: list, depth: int):
    """The body of `$( ... )` (closer ')') or of a backtick pair (closer '`'), which the shell reads as a command of its own,
    so an UNQUOTED context: a quote inside it opens a span of its own, `)` closes it only at parenthesis depth zero outside
    quotes. `quoted[k]` is set for the characters that are quoted or escaped there. A comment (a `#` at the start of a word,
    to the end of its line) holds no quote and no parenthesis, and the body of a here-document (read from the line after its
    operator) is skipped by its own rules. Arithmetic, `$(( ... ))`, is read the same way: a shift `<<` with a quote or a
    newline in it is then taken for a here-document and the text is refused when it does not close (fail closed, never a
    body hidden: a here-document body is judged as a text that can hold substitutions). Returns the index after the
    closer, or None when it is unterminated or nested too deep (the quote state is then unknown)."""
    if depth > _SCAN_DEPTH:
        return None
    n, parens = len(line), 0
    ws, pending = True, []
    while i < n:
        c = line[i]
        if c == closer and parens == 0:
            return i + 1
        if closer == ')':
            if c == '(':
                parens += 1
            elif c == ')':
                parens -= 1
        if c == '\\':
            if i + 1 >= n:
                return None
            quoted[i] = quoted[i + 1] = True
            ws = ws and line[i + 1] == '\n'      # a backslash-newline is not there for the shell
            i += 2
        elif c == "'":
            j = line.find("'", i + 1)
            if j == -1:
                return None
            for k in range(i, j + 1):
                quoted[k] = True
            i, ws = j + 1, False
        elif c == '"':
            quoted[i] = True
            i = _bash_dq(line, i + 1, quoted, depth + 1)
            ws = False
            if i is None:
                return None
        elif c == '$' and i + 1 < n and line[i + 1] == '(':
            i = _bash_subst(line, i + 2, ')', quoted, depth + 1)
            ws = False
            if i is None:
                return None
        elif c == '$' and i + 1 < n and line[i + 1] in '{[':
            # A `)` or `(` inside a `${ }` or `$[ ]` span (a parameter expansion's default value, `${Y:-)}`) is not a
            # real paren: skipped whole, as the matched-pair scan of bash and zsh does, so the body does not end there.
            i = _no_heredoc_end(line, i, quoted)
            ws = False
        elif c == '`' and closer == ')':
            i = _bash_subst(line, i + 1, '`', quoted, depth + 1)
            ws = False
            if i is None:
                return None
        elif c == '#' and ws and closer == ')':
            j = line.find('\n', i)
            i = n if j == -1 else j      # the newline itself stays: a pending here-document starts after it
        elif c == '\n' and pending:
            i += 1
            for here in pending:
                i = _heredoc_body(line, i, here, quoted, None)
            pending, ws = [], True
        elif c == '<' and line.startswith('<<', i):
            op = _heredoc_operator(line, i)
            if op is _HEREDOC_BAD:
                return None
            if op is None:
                i, ws = i + 2, False      # `<<<` and its target: a `#` right behind is no comment
            else:
                pending.append(op[:3])
                i, ws = op[3], False
        else:
            ws = _comment_ok_after(line, i)
            i += 1
    return None


def _bash_dq(line: str, i: int, quoted: list, depth: int):
    """The body of a double-quoted span, from the character after the opening quote: every character is quoted, except
    those of a command substitution inside it (see _bash_subst). Returns the index after the closing quote, or None."""
    n = len(line)
    while i < n:
        c = line[i]
        quoted[i] = True
        if c == '"':
            return i + 1
        if c == '\\':
            if i + 1 >= n:
                return None
            quoted[i + 1] = True
            i += 2
        elif c == '$' and i + 1 < n and line[i + 1] == '(':
            quoted[i + 1] = False
            i = _bash_subst(line, i + 2, ')', quoted, depth)
            if i is None:
                return None
        elif c == '`':
            i = _bash_subst(line, i + 1, '`', quoted, depth)
            if i is None:
                return None
        else:
            i += 1
    return None


def _bash_view(line: str):
    """The quote state the SHELL sees: (quoted, spans). `quoted[k]` is True when character k is quoted or escaped; a command
    substitution inside double quotes is an unquoted context again (_bash_subst). `spans` are the words, split at spaces
    outside quotes. None when a quote or substitution is unterminated."""
    n, i = len(line), 0
    quoted, spans = [False] * n, []
    while i < n:
        if line[i] in _SPACE:
            i += 1
            continue
        start = i
        while i < n and line[i] not in _SPACE:
            c = line[i]
            if c == '\\':
                if i + 1 >= n:
                    return None
                quoted[i] = quoted[i + 1] = True
                i += 2
            elif c == "'":
                j = line.find("'", i + 1)
                if j == -1:
                    return None
                for k in range(i, j + 1):
                    quoted[k] = True
                i = j + 1
            elif c == '"':
                quoted[i] = True
                i = _bash_dq(line, i + 1, quoted, 0)
                if i is None:
                    return None
            else:
                i += 1
        spans.append((start, i))
    return quoted, spans


def _scan_masks(line: str):
    """[(text, mask)] per word: the text is what `shlex.split(posix=True)` makes of the line and `mask[k]` says whether the
    shell quotes (or escapes) that character. The two readers are separate (shlex toggles at every double quote, the shell
    nests a quote inside a command substitution), so the characters come from the first and their quote state from the
    second. None when the line does not parse or the readers do not agree on where the words lie."""
    sv, bv = _shlex_view(line), _bash_view(line)
    if sv is None or bv is None:
        return None
    quoted, spans = bv
    if [(s, e) for _k, _q, s, e in sv] != spans:
        return None
    # a character is quoted only if BOTH readers say so: bash 3.2 expands the braces of `"$(cat "a/{x,y}")"` textually, its
    # brace expansion toggles at every double quote like shlex does, while a newer bash and zsh nest the quotes; whichever
    # reading leaves a brace unquoted, the gate expands it (the judgment is a superset)
    return [(''.join(line[k] for k in kept), [quoted[k] and k in shq for k in kept]) for kept, shq, _s, _e in sv]


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


# Reserved words after which a command follows in the same piece (`{ cmd`, `! cmd`, `if cmd`, `then cmd`, `do cmd`): they are
# skipped like a wrapper, so the reader behind them is the head that gets judged.
_KEYWORD_HEADS = frozenset(('{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do'))


def _skip_wrappers(toks: list) -> list:
    i = 0
    while i < len(toks):
        w = toks[i]
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w) or os.path.basename(w) in _WRAPPERS or w in _KEYWORD_HEADS:
            i += 1
            continue
        if w == 'function':
            i += 2      # `function name {`: the name is no command
            continue
        if w == 'case':
            j = next((k for k in range(i + 1, len(toks)) if toks[k].endswith(')')), None)
            if j is None:
                i += 1      # no label in this piece: the head that follows is judged as it stands
            else:
                i = j + 1      # `case x in x) cmd`: the command follows the label
            continue
        if w.endswith(')') and not w.startswith('$') and '=' not in w and i + 1 < len(toks):
            i += 1      # a case label `x)` or a function header `f()`: the command follows it
            continue
        break
    return toks[i:]


def _empty_head_variants(all_toks: list):
    """The command as typed, then the same command with each leading word that holds a command substitution or a backtick pair
    dropped, or cut back to the text behind its last `)` or backtick (`$(:)grep` is the word `grep`). Such a word can expand to
    nothing at run time (`$(true) grep -rn foo .` runs the grep), which the text cannot show: the word behind it is then the
    head, so it is judged as the head as well (a superset: a word that is never empty only makes the second reading an
    over-refusal). At most BODY_MAX_DEPTH variants, the last one with every such word dropped."""
    yield all_toks
    toks, n = _skip_wrappers(all_toks), 0
    while toks and re.search(r'\$\(|`', toks[0]):
        n += 1
        head = len(all_toks) - len(toks)
        tail = re.split(r'[)`]', toks[0])[-1]
        if len(tail) >= len(toks[0]):      # no closer in the word (`$(a`): nothing to cut back to, so the word goes (every round shortens the list or the word)
            tail = ''
        all_toks = all_toks[:head] + ([tail] if tail else []) + all_toks[head + 1:]
        toks = _skip_wrappers(all_toks)
        if n < BODY_MAX_DEPTH or not (toks and re.search(r'\$\(|`', toks[0])):
            yield all_toks


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


BODY_MAX_DEPTH = 8              # nested command bodies the gate judges; deeper is refused
BODY_MAX_WORK = 4 * MAX_TEXT    # characters handed to _judge across all bodies of one command (each call also costs BODY_CALL_COST)
BODY_CALL_COST = 1000
_FUNSUB_NEXT = ('', ' ', '\t', '\n', '|')      # what may follow `${` of a funsub; '' is the end of the text (an unclosed `${`)
_body_work = [0]


def _arith_bodies(text: str, start: int, end: int, quoted: list, out: list, depth: int) -> bool:
    """The command bodies inside an arithmetic span `text[start:end]` (`$(( ))`, `$[ ]`, a `(( ))` command). Bash expands the
    span as if it stood in double quotes: a `'` is a literal and shields nothing, `<<` is a shift (no here-document, so a
    quote behind it does not open a delimiter word), `#` opens no comment, and `$( )` and a backtick pair run wherever a
    backslash does not escape them. The command reading of the same span (`_bash_subst`) takes a `'` for a quote and `<<"x"`
    for a delimiter, which hides a body from it: this reading finds what that one hides. Bodies are appended to `out`.
    False when a body does not close or the nesting is too deep (the caller refuses the text)."""
    if depth > _SCAN_DEPTH:
        return False
    i = start
    while i < end:
        c = text[i]
        if c == '\\':
            i += 2      # the character behind a backslash is a literal; a body can only start at a `$` or a backtick, both of which a backslash escapes
        elif c == '$' and text.startswith('{', i + 1) and text[i + 2:i + 3] in _FUNSUB_NEXT:
            deny('the command uses a ${ ...; } command substitution, which the gate does not look into')
        elif c == '$' and text.startswith('((', i + 1):
            j = _bash_subst(text, i + 2, ')', quoted, depth + 1)      # a nested arithmetic span: read it the same way
            if j is None or not _arith_bodies(text, i + 2, j - 1, quoted, out, depth + 1):
                return False
            i = j
        elif c == '$' and text.startswith('(', i + 1) or c == '`':
            s = i + (2 if c == '$' else 1)
            j = _bash_subst(text, s, ')' if c == '$' else '`', quoted, depth + 1)
            if j is None:
                return False
            out.append(text[s:j - 1])
            i = j
        else:
            i += 1
    return True


def _quoted_end(text: str, i: int, quoted: list, nest: bool) -> int:
    """`text[i]` is a `$` before `[` or `{`: the index after the closer, counted with quotes skipped and with a nested `$( )`,
    backtick pair and `${ }` skipped as a whole (a closer inside them closes nothing, as in the matched-pair scan of bash and
    zsh). `nest` says whether a bare opener inside counts one level deeper (the plain count does, `${X:-{}` is open to it) or
    not (bash 3.2 closes at the first closer, `${X:-{}` is a complete span to it; zsh does not run that text). -1 when
    nothing closes."""
    op, cl = ('[', ']') if text[i + 1] == '[' else ('{', '}')
    n, depth, k = len(text), 1, i + 2
    end, done = -1, False
    while k < n and depth:
        c = text[k]
        if c == '\\':
            k += 2
            continue
        if c in '\'"':
            j = text.find(c, k + 1)
            if j == -1:
                break
            k = j + 1
            continue
        if c == '`' or (c == '$' and text.startswith('(', k + 1)):
            j = _bash_subst(text, k + (1 if c == '`' else 2), '`' if c == '`' else ')', quoted, 0)
            if j is None:
                break
            k = j
            continue
        if c == '$' and text.startswith('{', k + 1):
            k = _count_end(text, k)      # the matching `}`, counted plainly (no recursion)
            if k == -1:
                break
            continue
        depth += (c == op and nest) - (c == cl)
        k += 1
    else:
        end, done = (k if depth == 0 else -1), True
    # The budget of the span ends (see _no_heredoc_end). A scan that broke off may have read to the end of the text inside a
    # nested finder (k is then -1 or a stale index): it is charged the whole rest, never less than it read and never a
    # negative amount.
    quoted[n] -= (min(k, n) if done else n) - i
    return end


def _no_heredoc_end(text: str, i: int, quoted: list) -> int:
    """`text[i]` is a `$` before `[` or `{`: the index after the closer that ends the span, the LATEST of the ends a shell may
    take: the closers counted plainly (`_count_end`), counted with quotes and nested substitutions skipped (`_quoted_end`),
    and the same without counting a bare opener. A reading that finds no closer is no end: it used to be the end of the text,
    which turned the comment and here-document rules off for everything behind (`${X:-'{'}` is closed to a shell but open to
    the plain count, so the `# it's` after it read as code, its quote swallowed the next body, and a shell ran it). When no
    reading closes, no shell does either (it is a syntax error and nothing behind runs): `i + 2`, so that the text behind is
    scanned as code from there on. No here-document starts inside (`$[ 1<<2 ]` is a shift, `${X//<<E/y}` a pattern), so a too
    short end would read the rest of a pattern as a here-document and swallow the commands behind it, while a too long end
    only keeps a real here-document from being recognised (its text is then judged as code: refused, never allowed unread)."""
    n = len(text)
    if quoted[n] <= 0:
        # The budget of the span ends is spent: thousands of spans that none closes, or a text built to burn it. No end is
        # right for the rest (the end of the text turns the comment and here-document rules off, so a quote in a comment
        # could hide a body; the short end is the quadratic one): the command is refused.
        deny('the command holds more ${ } and $[ ] spans than the gate reads')
    plain = _count_end(text, i)
    quoted[n] -= (n if plain == -1 else plain) - i
    ends = (plain, _quoted_end(text, i, quoted, True), _quoted_end(text, i, quoted, False))
    return max(max(ends), i + 2)


def _resume_end(text: str, i: int, quoted: list, latest: int) -> int:
    """Where the code scan goes on behind a `$[ ]` span whose arithmetic reading ran up to `latest` (`_no_heredoc_end`): the
    EARLIEST end that a quote-aware reading closes, `latest` when none does. The LATEST end is right for the arithmetic reading
    (a body anywhere in the span is found) and wrong for the code behind it: when it is longer than the span of the shell
    (`$[ '[' ]` is closed to a shell and open to the plain count, which went on to a `]` of the text behind), the commands
    between the two ends were read as arithmetic and a bare `( cmd )` or `<( cmd )` there stayed hidden. The text between
    the ends is now read as code as well: a superset."""
    if quoted[len(text)] <= 0:
        deny('the command holds more ${ } and $[ ] spans than the gate reads')
    ends = [e for e in (_quoted_end(text, i, quoted, True), _quoted_end(text, i, quoted, False)) if e != -1]
    return min(ends) if ends else latest


def _body_at(text: str, i: int, quoted: list, out: list, in_dq: bool):
    """If a command body starts at `i`, append its text to `out` and return the index after it; return `i` when none
    starts there, None when the body is not closed. Bodies: `$( )`, backticks, and (outside double quotes) `<( )`,
    `>( )` and a bare `( )` group, a subshell. `$(( ))` is read as a body too (its text, `( ... )`, is a harmless
    subshell, and a substitution inside it is found one level down): a superset."""
    c = text[i]
    if c == '$' and text.startswith('{', i + 1) and text[i + 2:i + 3] in _FUNSUB_NEXT:
        # bash 5.3 `${ cmd; }` and `${| cmd; }` run cmd in the current shell: a command body without a `$(`. Such a text is
        # a bad substitution to an older bash, so nothing legitimate is lost by refusing it
        deny('the command uses a ${ ...; } command substitution, which the gate does not look into')
    if c == '$' and text.startswith('(', i + 1):
        start, closer = i + 2, ')'
    elif c == '`':
        start, closer = i + 1, '`'
    elif not in_dq and c in '<>' and text.startswith('(', i + 1):
        start, closer = i + 2, ')'
    elif not in_dq and c == '(':
        start, closer = i + 1, ')'
    else:
        return i
    end = _bash_subst(text, start, closer, quoted, 0)
    if end is None:
        return None
    body = text[start:end - 1]
    out.append(body)
    if closer == ')' and text.startswith('(', start) and (c == '$' or c == '('):
        # `$(( ))` and a `(( ))` command: the span is also arithmetic, which bash expands like a double-quoted text
        if not _arith_bodies(text, start, end - 1, quoted, out, 0):
            return None
    if closer == '`':
        plain = re.sub(r'\\([`\\$])', r'\1', body)      # the backslash rule of backticks; the raw text is judged as well
        if plain != body:
            out.append(plain)
    return end


def _count_end(text: str, i: int) -> int:
    """`text[i]` is a `$` before `[` or `{`: the index after the matching closer, counted with no quote state (-1 when there is
    none). One of the ends `_no_heredoc_end` takes the latest of."""
    op, cl = ('[', ']') if text[i + 1] == '[' else ('{', '}')
    depth, k, n = 1, i + 2, len(text)
    while k < n and depth:
        depth += (text[k] == op) - (text[k] == cl)
        k += 1
    return k if depth == 0 else -1


def _find_bodies(text: str):
    """The OUTERMOST command bodies of a shell text (a body inside a body is found when that body is judged): `$( )`,
    backticks, `<( )`, `>( )` and `( )`, in the open and inside double quotes. A single-quoted span is a literal. None
    when a quote or a body is not closed (the caller refuses it). One pass, linear in the text."""
    n = len(text)
    quoted = [False] * n + [_SPAN_BUDGET * n + 10000]      # filled by _bash_subst; shared so that the pass stays linear; the last cell: _span_end budget
    out, i = [], 0
    ws, pending, arith_end = True, [], -1      # at the start of a word; here-documents waiting for their line; end of a `$[ ]`
    dup = 0      # 1: the word behind a `>&` or `<&` has not started; 2: inside it (up to an unquoted blank or operator)
    while i < n:
        c = text[i]
        if dup:
            if c in ' \t':
                if dup == 2 and i >= arith_end:      # (a blank inside a `${ }` of the word does not end it either)
                    dup = 0
            elif c in '\n;|&()<>' and i >= arith_end:      # (a `;` inside a `${ }` of the word does not end it)
                dup = 0
            else:
                dup = 2
        if c == '&' and text[i - 1:i] in ('>', '<') and i > 0:
            dup = 1
        if c == '\\':
            ws = ws and text[i + 1:i + 2] == '\n'      # a backslash-newline is not there for the shell
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            if j == -1:
                return None
            if dup:
                # bash 3.2 expands the WORD behind `>&` and `<&` without removing the quotes: `>&'$(R)'` and `>&2'$(R)'` run R.
                # Every single-quoted span of the word is read like a double-quoted text, which finds what the quotes would hide
                if not _arith_bodies(text, i + 1, j, quoted, out, 0):
                    return None
            i, ws = j + 1, False
        elif c == '"':
            i, ws = i + 1, False
            while True:
                if i >= n:
                    return None
                d = text[i]
                if d == '"':
                    i += 1
                    break
                if d == '\\':
                    i += 2
                    continue
                if d == '$' and text.startswith('[', i + 1):
                    # `"$[ ... ]"`: the same arithmetic span as in the open. A quote inside it is a literal to the arithmetic
                    # reading but a quote to this scan (`"$[ "'$(R)'" ]"` runs the body in zsh): the span is consumed whole
                    j = _no_heredoc_end(text, i, quoted)
                    if not _arith_bodies(text, i + 2, j, quoted, out, 0):
                        return None
                    i = _resume_end(text, i, quoted, j)
                    continue
                j = _body_at(text, i, quoted, out, True)
                if j is None:
                    return None
                i = j if j != i else i + 1
        elif c == '#' and ws and i >= arith_end:
            # a comment: no quote and no body in it; the newline stays for a pending here-document. Not inside a `${ }` or a
            # `$[ ]`: `${X: # -a}` is an offset expression, and the text behind its `}` is code
            j = text.find('\n', i)
            i = n if j == -1 else j
        elif c == '\n' and pending:
            i, ws = i + 1, True
            for here in pending:
                i = _heredoc_body(text, i, here, quoted, out)
                if i is None:
                    return None
            pending = []
        elif c == '<' and text.startswith('<<', i) and i >= arith_end:
            # `$[ 1<<2 ]` is a shift: no here-document starts inside the old arithmetic brackets
            op = _heredoc_operator(text, i)
            if op is _HEREDOC_BAD:
                return None
            if op is None:
                i, ws = i + 2, False      # `<<<` and its target: a `#` right behind is no comment
            else:
                pending.append(op[:3])
                i, ws = op[3], False
        elif c == '$' and text.startswith('[', i + 1):
            # `$[ ... ]`: arithmetic, expanded like a double-quoted text (see _arith_bodies); the span is consumed whole
            j = _no_heredoc_end(text, i, quoted)
            if not _arith_bodies(text, i + 2, j, quoted, out, 0):
                return None
            arith_end = max(arith_end, j)      # no comment and no here-document in the span, whatever end the code scan resumes at
            i, ws = _resume_end(text, i, quoted, j), False
        else:
            if c == '$' and i >= arith_end and text[i + 1:i + 2] in ('[', '{'):      # one scan per span: linear
                arith_end = max(arith_end, _no_heredoc_end(text, i, quoted))
            j = _body_at(text, i, quoted, out, False)
            if j is None:
                return None
            if j != i:
                # a `#` right behind the `)` of a subshell opens a comment; behind `$( )` or `<( )` it is part of the word. A `(`
                # that is not at the start of a command is no subshell to zsh (`echo (a)#x $(R)`, `x(a)#x $(R)`: a glob group, a
                # qualifier, a function header), and the `#x` there is a word: it stays code
                i, ws = j, c == '(' and _command_start(text, i)
            else:
                i, ws = i + 1, _comment_ok_after(text, i)
    return out


def _lex_commands(text: str):
    """The simple commands of a shell text as lists of words, split the way the shell splits (`_commands` cuts at `;`
    and `|` even inside quotes, which is fine for the head of a piece and useless for the ARGUMENT of `bash -c "a; b"`).
    Quotes are removed from the words; a command substitution or a `$[ ]` is kept in its word as it stands (its body is
    judged on its own); a comment and the body of a here-document are skipped. `;`, `&`, `|`, `(` and `)` end a command
    (`>&2` and `<&3` do not). None when a quote or a substitution is not closed. One pass, linear."""
    n = len(text)
    quoted = [False] * n + [_SPAN_BUDGET * n + 10000]      # scratch of _bash_subst; the last cell: the budget of the span ends
    cmds, cur, word, has = [], [], [], False
    ws, pending, arith_end = True, [], -1
    i = 0
    while i < n:
        c = text[i]
        if c == '$' and i >= arith_end and text[i + 1:i + 2] in ('[', '{'):
            arith_end = max(arith_end, _no_heredoc_end(text, i, quoted))      # `${X//<<E/y}`: a pattern, no here-document in it
        if c in ' \t' or c == '\n' or c in ';&|()':
            if c == '&' and word and word[-1][-1:] in ('>', '<'):
                word.append(c)      # `>&2`, `<&3`: part of the word
                i += 1
                continue
            if has:
                cur.append(''.join(word))
                word, has = [], False
            if c not in ' \t':
                if cur:
                    cmds.append(cur)
                    cur = []
                if c == '(' and i >= arith_end and text.startswith('(', i + 1):
                    # `(( 1 << 2 ))`: a shift, no here-document starts inside; one scan per span: linear
                    depth, k = 0, i
                    while k < n:
                        depth += (text[k] == '(') - (text[k] == ')')
                        k += 1
                        if depth == 0:
                            break
                    arith_end = max(arith_end, k if depth == 0 else n)
            ws = _comment_ok_after(text, i)
            i += 1
            if c == '\n' and pending:
                for here in pending:
                    i = _heredoc_body(text, i, here, quoted, None)
                pending = []
        elif c == '#' and ws:
            j = text.find('\n', i)
            i = n if j == -1 else j
        elif c == '\\':
            if i + 1 >= n:
                return None
            if text[i + 1] != '\n':      # a backslash-newline is not there for the shell
                word.append(text[i + 1])
                has, ws = True, False
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            if j == -1:
                return None
            word.append(text[i + 1:j])
            has, ws = True, False
            i = j + 1
        elif c == '"':
            has, ws = True, False
            i += 1
            while True:
                if i >= n:
                    return None
                d = text[i]
                if d == '"':
                    i += 1
                    break
                if d == '\\':
                    if i + 1 >= n:
                        return None
                    e = text[i + 1]
                    if e in '"\\$`':
                        word.append(e)
                    elif e != '\n':
                        word.append(d + e)
                    i += 2
                    continue
                if d == '`' or (d == '$' and text.startswith('(', i + 1)):
                    j = _bash_subst(text, i + 1, '`', quoted, 0) if d == '`' else _bash_subst(text, i + 2, ')', quoted, 0)
                    if j is None:
                        return None
                    word.append(text[i:j])
                    i = j
                    continue
                word.append(d)
                i += 1
        elif c == '`' or (c == '$' and text.startswith('(', i + 1)):
            j = _bash_subst(text, i + 1, '`', quoted, 0) if c == '`' else _bash_subst(text, i + 2, ')', quoted, 0)
            if j is None:
                return None
            word.append(text[i:j])
            has, ws = True, False
            i = j
        elif c == '$' and text.startswith('[', i + 1):
            depth, k = 1, i + 2
            while k < n and depth:
                depth += (text[k] == '[') - (text[k] == ']')
                k += 1
            word.append(text[i:k])
            has, ws = True, False
            i = k
        elif c == '<' and text.startswith('<<', i) and i >= arith_end:
            op = _heredoc_operator(text, i)
            if op is _HEREDOC_BAD:
                return None
            if op is None:      # a here-string `<<<`
                word.append('<<')
                has, ws = True, False
                i += 2
            else:
                pending.append(op[:3])
                i = op[3]
        else:
            word.append(c)
            has, ws = True, False
            i += 1
    if has:
        cur.append(''.join(word))
    if cur:
        cmds.append(cur)
    return cmds


_SHELLS = frozenset(('bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'csh', 'tcsh', 'fish', 'rbash', 'rksh', 'rzsh', 'pdksh', 'yash', 'ksh93', 'busybox'))
_UNREADABLE_HEAD = re.compile(r'[$`*?\[{]')      # a variable, a substitution, a glob or a brace in the word that would be the shell
_C_CLUSTER = re.compile(r'-[A-Za-z]*c[A-Za-z]*')
# long options of a shell: without a value, and with a value (the next word, or `=V`); any other long option is not decided
_SHELL_LONG_PLAIN = frozenset(('login', 'noprofile', 'norc', 'posix', 'restricted', 'verbose', 'debugger', 'noediting', 'help', 'version',
                               'dump-strings', 'dump-po-strings', 'pretty-print', 'no-rcs', 'no-globalrcs'))
_SHELL_LONG_VALUED = frozenset(('rcfile', 'init-file'))
_EXEC_MAX_HEADS = 32      # shell words and `eval` in one command that the gate looks behind; more is refused
# a text that cannot be read is refused when it names a shell or `eval` (an apostrophe in plain prose keeps its old verdict)
_SHELL_WORD = re.compile(r'(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash|mksh|csh|tcsh|fish|eval)(?![\w-])')


def _shell_c_texts(words: list, i: int) -> list:
    """The command texts a shell word hands to `-c`: `words[i:]` are the words after the shell. The options are read as a
    shell reads them (a cluster such as `-lc`, `-o NAME`, `+o NAME`, `-O NAME`, `--rcfile FILE`, `--` ends them); the first
    word that is no option is the command string when a `-c` was seen, a script file otherwise. When the place of that
    string is not decided (an unknown long option may take a value) every later word is a text: a superset."""
    c_seen, n = False, len(words)
    while i < n:
        w = words[i]
        if w == '--':
            return [words[i + 1]] if c_seen and i + 1 < n else []
        if len(w) > 1 and w[0] in '-+':
            if w.startswith('--'):
                name, eq, _v = w[2:].partition('=')
                if name in _SHELL_LONG_PLAIN and not eq:
                    i += 1
                elif name in _SHELL_LONG_VALUED:
                    i += 1 if eq else 2
                else:
                    # not decided: the value of `--name=VALUE` may be a text (fish `--init-command=CMD`), and so may every later word
                    return ([_v] if eq else []) + words[i + 1:]
                continue
            takes = 0
            for ch in w[1:]:
                if ch == 'c':
                    c_seen = True
                elif ch in 'oO':
                    takes += 1      # `-o NAME`, `-O SHOPT`: the next word is the value
                elif ch in 'CRT':
                    return words[i + 1:]      # fish `-C CMD` runs a command, ksh `-R FILE` takes a value: not decided
            i += 1 + takes
            continue
        return [w] if c_seen else []
    return []


def _exec_texts(words: list) -> list:
    """The shell texts a simple command (its words, quotes removed) hands to another shell: the string of `bash -c`, `sh -c`
    and the other shells, and the joined arguments of `eval`. Found at ANY place of the command, so a wrapper with options,
    `xargs ... sh -c`, `find -exec sh -c`, `timeout 5 bash -c` and `ssh host bash -c` need no list of their own. A text
    is judged like the body of a substitution (`_judge`). Accepted limit: a text built at run time (`bash -c "$X"`)."""
    out, seen = [], 0
    for k, w in enumerate(words):
        head = os.path.basename(w)
        # a shell by name, or a word the gate cannot read (`$sh`, `/bin/ba?h`, a substitution) that is followed by a `-c` cluster
        unreadable = _UNREADABLE_HEAD.search(w) and k + 1 < len(words) and _C_CLUSTER.fullmatch(words[k + 1])
        if head in _SHELLS or unreadable:
            out.extend(_shell_c_texts(words, k + 1))
        elif head == 'eval':
            args = words[k + 1:]
            if args[:1] == ['--']:
                args = args[1:]
            if args:
                out.append(' '.join(args))
        else:
            continue
        seen += 1
        if seen > _EXEC_MAX_HEADS:
            deny('the command hands text to more shells than the gate can look through')
    return out


# ---------------------------------------------------------------------------------------------------
# ANSI-C quoting: $'...'
# ---------------------------------------------------------------------------------------------------
# A `$'...'` string is NOT a plain single-quoted one: a backslash escapes the next character (the closing quote included, so
# `$'\''` is ONE string holding an apostrophe), and the escapes make characters (`\x2e` is a dot, `\n` a newline). Every scanner
# below reads a `'` as the start of a literal that ends at the next `'`: given `echo $'\'' $(R) $'a'` it pairs the quotes the
# wrong way round and takes the live `$(R)` for the inside of a literal. So the text is REWRITTEN before any scanner sees it:
# each `$'...'` that the shell reads as an ANSI-C string (not one inside single or double quotes, a comment, behind a
# backslash or in a here-document body) is replaced by the plain single-quoted string of its VALUE (`'` as `'\''`), the same
# word to every later rule, and the value a path rule, a text rule and a `bash -c` string need. The shells disagree about a few
# escapes, so a span can have several readings (bash 3.2 and zsh 5.9 were run on every case): an unknown escape `\q` keeps
# its backslash in bash and loses it in zsh (`\<newline>` in the first is a line continuation of the text another shell is
# handed), `\cX` is a control character to bash and the two characters `cX` to zsh, `\x`, `\u` and `\U` without a digit are
# literal to bash and a NUL to zsh, and a NUL cuts the string (bash: the rest of the span; zsh keeps it until the argument
# is handed to a program, which cuts the rest of the WORD). The readings are judged one by one: two sets of the escape
# rules, and for every NUL three readings (the rest of the span cut, the NUL dropped, the rest of the word cut). A text with
# more than _ANSI_MAX_VARIANTS readings is refused.

_ANSI_MAX_VARIANTS = 32
_ANSI_SIMPLE = {'a': '\x07', 'b': '\b', 'e': '\x1b', 'E': '\x1b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v',
                '\\': '\\', "'": "'", '"': '"', '?': '?'}
_HEXDIGITS = '0123456789abcdefABCDEF'


def _ansi_c_end(text: str, i: int) -> int:
    """`text[i:i + 2]` is `$'`: the index after the closing quote of the ANSI-C string (a backslash escapes the next character),
    -1 when it does not close."""
    n, j = len(text), i + 2
    while j < n:
        c = text[j]
        if c == '\\':
            j += 2
        elif c == "'":
            return j + 1
        else:
            j += 1
    return -1


def _ansi_span_tokens(body: str) -> list:
    """The pieces of the text between the quotes of a `$'...'` string: ('s', text) for what every shell reads the same way,
    ('unk', q) an escape of a character without a meaning, ('c', X) `\\cX`, ('nul',) a NUL, ('nd', letter) a `\\x`, `\\u` or
    `\\U` without a digit."""
    toks, buf, i, n = [], [], 0, len(body)

    def flush():
        if buf:
            toks.append(('s', ''.join(buf)))
            del buf[:]

    while i < n:
        c = body[i]
        if c != '\\' or i + 1 >= n:
            buf.append(c)
            i += 1
            continue
        q = body[i + 1]
        i += 2
        if q in _ANSI_SIMPLE:
            buf.append(_ANSI_SIMPLE[q])
        elif q in '01234567':
            j = i
            while j < n and j < i + 2 and body[j] in '01234567':
                j += 1
            v = int(q + body[i:j], 8) & 0xFF
            i = j
            if v == 0:
                flush()
                toks.append(('nul',))
            else:
                buf.append(chr(v))
        elif q in 'xuU':
            j = i
            while j < n and j - i < {'x': 2, 'u': 4, 'U': 8}[q] and body[j] in _HEXDIGITS:
                j += 1
            if j == i:
                flush()
                toks.append(('nd', q))
                continue
            v, digits, i = int(body[i:j], 16), body[i:j], j
            if v == 0:
                flush()
                toks.append(('nul',))
            elif v > 0x10FFFF or 0xD800 <= v <= 0xDFFF:
                buf.append('\\' + q + digits)      # no character: the text stays
            else:
                buf.append(chr(v))
        elif q == 'c' and i < n:
            flush()
            toks.append(('c', body[i]))
            i += 1
        else:
            flush()
            toks.append(('unk', q))
    flush()
    return toks


def _ansi_is_nul(tok: tuple, drop: bool) -> bool:
    """Is the piece a point where one of the readings makes a NUL (`drop`: the zsh rules, else the bash rules)?"""
    kind = tok[0]
    return kind == 'nul' or (kind == 'nd' and drop) or (kind == 'c' and tok[1] == '@' and not drop)


def _ansi_span_value(toks: list, drop: bool, pick) -> tuple:
    """(value, word_break) of one span under one set of escape rules. `pick()` is called once for every NUL point and says what
    that NUL does: 0 the rest of the span is cut, 1 the NUL is dropped, 2 the rest of the span is cut and the word ends there
    (the zsh reading: the argument is cut at the NUL by the program that gets it). word_break is True for a 2 that came."""
    out, cut, brk = [], False, False
    for tok in toks:
        if _ansi_is_nul(tok, drop):
            p = pick()
            if not cut and p != 1:
                cut, brk = True, p == 2
            continue
        kind = tok[0]
        if kind == 's':
            piece = tok[1]
        elif kind == 'unk':
            piece = tok[1] if drop else '\\' + tok[1]
        elif kind == 'c':
            piece = 'c' + tok[1] if drop else chr(ord(tok[1]) & 0x1F)
        else:      # ('nd', letter) under the bash rules
            piece = '\\' + tok[1]
        if not cut:
            out.append(piece)
    return ''.join(out), brk


class _AnsiScan:
    """One pass over a shell text that finds the `$'...'` strings the shell reads as ANSI-C and copies everything else. The
    context rules are the shell's: single quotes (no escape), double quotes (`$'` is two literal characters there; a
    substitution inside them is code again), a comment (a `#` at the start of a word), a backslash, `$( )`, backticks, `${ }`,
    `$[ ]` and the body of a here-document (a literal one is copied, an unquoted one holds substitutions, which are code).
    `out` holds text pieces and, for a string, the index of its tokens in `spans`."""

    def __init__(self, text: str, zsh_pid_quote: bool = False):
        self.t, self.n, self.out, self.spans = text, len(text), [], []
        # `$$'..'`: bash 3.2 reads the process id and then a plain quote, zsh 5.9 the process id and then an ANSI-C string
        self.zsh_pid_quote = zsh_pid_quote

    def code(self, i: int, closer, depth: int) -> int:
        """Unquoted code from `i` up to (and with) `closer` (None: the end of the text); returns the index after it."""
        if depth > _SCAN_DEPTH:
            deny('the command nests command bodies deeper than the gate can look through')
        t, n, out = self.t, self.n, self.out
        parens, pending = 0, []
        ws = closer in (None, ')', '`')      # at the start of a word (a `#` opens a comment); not inside a ${ } or $[ ]
        while i < n:
            c = t[i]
            if c == closer and parens == 0:
                out.append(c)
                return i + 1
            if closer == ')':
                parens += (c == '(') - (c == ')')
            elif closer == ']':
                parens += (c == '[') - (c == ']')
            if c == '\\':
                out.append(t[i:i + 2])
                ws = ws and t[i + 1:i + 2] == '\n'      # a backslash-newline is not there for the shell
                i += 2
            elif c == "'":
                j = t.find("'", i + 1)
                if j == -1:
                    out.append(t[i:])
                    return n
                out.append(t[i:j + 1])
                i, ws = j + 1, False
            elif c == '"':
                out.append(c)
                i, ws = self.dq(i + 1, depth + 1), False
            elif c == '$':
                nxt = t[i + 1:i + 2]
                ws = False
                if nxt == "'":
                    j = _ansi_c_end(t, i)
                    if j == -1:
                        i += 1      # not closed: the `$` goes, the quote stays an open one, as it always was
                    else:
                        self.spans.append(_ansi_span_tokens(t[i + 2:j - 1]))
                        out.append(len(self.spans) - 1)
                        i = j
                elif nxt == '$':
                    out.append('$$')      # the process id
                    i += 2
                    if self.zsh_pid_quote and t[i:i + 1] == "'":
                        # the zsh reading: the quote behind the process id opens an ANSI-C string (`t[i - 1:i + 1]` is `$'`);
                        # in the bash 3.2 reading (the other scan) it is an ordinary quote
                        j = _ansi_c_end(t, i - 1)
                        if j != -1:
                            self.spans.append(_ansi_span_tokens(t[i + 1:j - 1]))
                            out.append(len(self.spans) - 1)
                            i = j
                elif nxt in ('(', '{', '['):
                    out.append(c + nxt)
                    i = self.code(i + 2, {'(': ')', '{': '}', '[': ']'}[nxt], depth + 1)
                else:
                    out.append(c)
                    i += 1
            elif c == '`':
                out.append(c)
                i, ws = self.code(i + 1, '`', depth + 1), False
            elif c == '#' and ws and closer not in ('}', ']'):
                j = t.find('\n', i)
                j = n if j == -1 else j
                out.append(t[i:j])
                i = j
            elif c == '\n' and pending:
                out.append(c)
                i, ws = i + 1, True
                for here in pending:
                    i = self.heredoc(i, here, depth)
                pending = []
            elif c == '<' and t.startswith('<<', i) and closer not in ('}', ']'):
                op = _heredoc_operator(t, i)
                if op is _HEREDOC_BAD:
                    out.append(t[i:])
                    return n
                if op is None:      # a here-string `<<<`
                    out.append('<<')
                    i, ws = i + 2, False
                else:
                    pending.append(op[:3])
                    out.append(t[i:op[3]])
                    i, ws = op[3], False
            else:
                out.append(c)
                ws = _comment_ok_after(t, i)
                i += 1
        return n

    def dq(self, i: int, depth: int) -> int:
        """The inside of a double-quoted text from `i`: the index after the closing quote (the end of the text when none)."""
        t, n, out = self.t, self.n, self.out
        while i < n:
            c = t[i]
            if c == '"':
                out.append(c)
                return i + 1
            if c == '\\':
                out.append(t[i:i + 2])
                i += 2
            elif c == '$' and t[i + 1:i + 2] in ('(', '{', '['):
                nxt = t[i + 1]
                out.append(c + nxt)
                i = self.code(i + 2, {'(': ')', '{': '}', '[': ']'}[nxt], depth + 1)
            elif c == '`':
                out.append(c)
                i = self.code(i + 1, '`', depth + 1)
            else:
                out.append(c)
                i += 1
        return n

    def heredoc(self, i: int, here: tuple, depth: int) -> int:
        """The body of one here-document from the line start `i`: the index after its delimiter line. A literal body is copied;
        an unquoted one is a double-quote-like text whose substitutions are code."""
        delim, strip, literal = here
        t, n, out = self.t, self.n, self.out
        while i < n:
            eol = t.find('\n', i)
            end = n if eol == -1 else eol
            if (t[i:end].lstrip('\t') if strip else t[i:end]) == delim:
                out.append(t[i:end + 1])
                return min(end + 1, n)
            if literal:
                out.append(t[i:end + 1])
                i = end + 1
                continue
            k = i
            while k < n and t[k] != '\n':      # a substitution may run past the end of the line
                ch = t[k]
                if ch == '\\':
                    out.append(t[k:k + 2])
                    k += 2
                elif ch == '$' and t[k + 1:k + 2] in ('(', '{', '['):
                    nxt = t[k + 1]
                    out.append(ch + nxt)
                    k = self.code(k + 2, {'(': ')', '{': '}', '[': ']'}[nxt], depth + 1)
                elif ch == '`':
                    out.append(ch)
                    k = self.code(k + 1, '`', depth + 1)
                else:
                    out.append(ch)
                    k += 1
            if k < n:
                out.append('\n')
            i = k + 1
        return n


def _ansi_c_variants(text: str) -> list:
    """The readings of a shell text with its ANSI-C strings replaced by their values (see above); [text] when it has none.
    A text with `$$'` is scanned twice, once for each reading of the quote behind the process id (bash 3.2: an ordinary quote,
    zsh 5.9: the start of an ANSI-C string); the variants of both are judged and the cap on the readings is shared."""
    if "$'" not in text:
        return [text]
    scans = []
    for zsh_pid_quote in ((False, True) if "$$'" in text else (False,)):
        scan = _AnsiScan(text, zsh_pid_quote)
        scan.code(0, None, 0)
        scans.append(scan)
    if not any(scan.spans for scan in scans):
        return [''.join(scans[0].out)]
    plans, total = [], 0
    for scan in scans:
        sensitive = any(tok[0] in ('unk', 'nd', 'c') for toks in scan.spans for tok in toks)
        for drop in ((False, True) if sensitive else (False,)):
            points = sum(1 for toks in scan.spans for tok in toks if _ansi_is_nul(tok, drop))
            plans.append((scan, drop, points))
            total += 3 ** points
    if total > _ANSI_MAX_VARIANTS:
        deny('the command holds more ANSI-C strings with several readings than the gate looks through')
    seen, result = set(), []
    for scan, drop, points in plans:
        out, spans = scan.out, scan.spans
        for choice in itertools.product((0, 1, 2), repeat=points):
            picks = iter(choice)
            parts = []
            for piece in out:
                if isinstance(piece, str):
                    parts.append(piece)
                    continue
                value, brk = _ansi_span_value(spans[piece], drop, picks.__next__)
                parts.append("'" + value.replace("'", "'\\''") + "'" + (' ' if brk else ''))
            variant = ''.join(parts)
            if variant not in seen:
                seen.add(variant)
                result.append(variant)
    return result


def _judge_text(text: str, cwd: str, depth: int) -> None:
    """Judge a shell text under every reading of it (the work caps stay shared):
      * as it stands, and with its backslash-newline pairs removed. The shell removes such a pair before it reads anything but a
        comment (and a single-quoted text), so `"$\\<newline>(cmd)"` runs cmd while the finder sees no `$(`, and `$\\<newline>'x'`
        is an ANSI-C string. A superset (a pair inside a comment ends the comment at its newline, which only the first knows);
      * with each ANSI-C string by its value (`_ansi_c_variants`) and the `$` of a `$"..."` locale string removed (it is a
        double-quoted text);
      * with `|&` as `|` when a `#` is glued to it: zsh takes `|&` for a pipe, so the `#` behind it opens a comment there, where
        the gate reads a word, and a here-document operator in that word would swallow the lines behind it (bash 3.2 has no `|&`)."""
    seen = set()
    for t in (text, text.replace('\\\n', '')):
        if t in seen:
            continue
        seen.add(t)
        for variant in _ansi_c_variants(t):
            if variant != text and _names_key_in_text(variant):
                # the text rules on the VALUE of the ANSI-C strings: `$'\x2eclaim-signing-key'` names the key
                deny('the command names the claim signing key (%s) or a glob that could match it' % KEY_NAME)
            plain = re.sub(r'\$(?=")', '', variant)
            _judge(plain, cwd, depth)
            if '|&#' in plain:      # (behind a blank both readings take a `#` for a comment: only the glued one differs)
                _judge(plain.replace('|&', '|'), cwd, depth)


def check_bash(cmd: str, cwd: str) -> None:
    _brace_work[0] = 0      # the brace expansion work cap is per command
    _body_work[0] = 0
    if len(cmd) > MAX_TEXT:
        # every scan below stops at MAX_TEXT characters: a reader behind that point is never seen, so the text is refused
        # (fail closed) rather than judged by its head alone. The reason does not quote the text.
        deny('the command is longer than %d characters, which the gate does not read to the end' % MAX_TEXT)
    if _names_key_in_text(cmd):
        deny('the command names the claim signing key (%s) or a glob that could match it' % KEY_NAME)
    _judge_text(cmd, cwd, 0)


def _judge(plain_cmd: str, cwd: str, depth: int) -> None:
    """ONE judgment for a shell text, the whole command or the body of a command substitution, a backtick pair, a process
    substitution or a subshell: every rule runs on a body exactly as on the top level (a body is an unquoted context of its
    own, also where it sits inside double quotes). The bodies are found on the whole text first, because the command splitter
    cuts at `;` and `|` even inside `$( )`. A body that does not parse, nesting past BODY_MAX_DEPTH and the work budget
    are refusals (generic reason, never the text). The string of `bash -c` (and sh, zsh, dash, ksh) and the arguments of
    `eval` are judged the same way (`_exec_texts`). Accepted limits: a body built at run time (`bash -c "$X"`), heredoc
    bodies of a command that RUNS them as a script, `source`, `python -c`, aliases and functions defined earlier."""
    _body_work[0] += len(plain_cmd) + BODY_CALL_COST
    if depth > BODY_MAX_DEPTH or _body_work[0] > BODY_MAX_WORK:
        deny('the command nests command bodies deeper than the gate can look through')
    for segs in _pipelines(plain_cmd):
        _check_find_pipe(segs, cwd)
    for all_toks in [v for typed in _commands(plain_cmd) for v in _empty_head_variants(typed)]:
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
    bodies = _find_bodies(plain_cmd[:MAX_TEXT])
    if bodies is None:
        # unread text: refused when it could hold a body (`(` or a backtick anywhere); a stray apostrophe in a text with
        # neither (`echo it's fine`) keeps the verdict it always had
        if re.search(r'[(`]', plain_cmd[:MAX_TEXT]):
            deny('a command body of the command could not be read (an unterminated quote or substitution)')
        bodies = []
    for body in bodies:
        _judge(body, cwd, depth + 1)
    # the text another shell is handed: `bash -c ARG`, `eval ARGS` (also behind xargs, find -exec, a wrapper with options)
    lexed = _lex_commands(plain_cmd[:MAX_TEXT])
    if lexed is None:
        if _SHELL_WORD.search(plain_cmd[:MAX_TEXT]):
            deny('a command text of the command could not be read (an unterminated quote or substitution)')
        lexed = []
    for words in lexed:
        for text in _exec_texts(words):
            _judge_text(text, cwd, depth + 1)      # a command of its own: read under every reading, as the top-level text


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
