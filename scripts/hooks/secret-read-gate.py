#!/usr/bin/env python3
"""PreToolUse read guard for the claim signing key: store/.claim-signing-key.

The dashboard signs every successful approval claim with the key in <install>/store/.claim-signing-key; the
email send gate and the official sender check that signature. An agent that can READ the key can forge the
signature of a mirror server, so this hook refuses every tool call that would read (or overwrite) that file.

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
    store/ directory;
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
    pass


def deny(why: str) -> None:
    raise Block(why)


# ---------------------------------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------------------------------

def _real(path: str) -> str:
    return os.path.realpath(path)


KEY_REAL = _real(KEY_PATH)
STORE_REAL = _real(STORE)


def _absolute(path: str, cwd: str) -> str:
    p = os.path.expanduser(path)
    return p if os.path.isabs(p) else os.path.join(cwd, p)


def _is_key_file(path: str, cwd: str, by_text: bool = True) -> bool:
    """True when `path` is, resolves to, or is another name (a hard link) for the key file; by_text: also when its
    text merely names the key."""
    if path[:7].lower() == 'file://':
        path = unquote(path[7:])
        if not path.startswith('/'):
            path = '/' + path.split('/', 1)[1] if '/' in path else path      # file://localhost/x or file://host/x: the host is dropped
    if by_text and KEY_NAME in path.lower().replace('\\', ''):
        return True
    abs_path = _absolute(path, cwd)
    real = _real(abs_path)
    if real == KEY_REAL or (by_text and os.path.basename(real) == KEY_NAME):
        return True
    try:
        a, b = os.stat(abs_path), os.stat(KEY_PATH)
        return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
    except OSError:
        return False


def _inside(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def _covers_store(path: str, cwd: str) -> bool:
    """The directory `path` is the store directory or holds it."""
    return _inside(STORE_REAL, _real(_absolute(path, cwd)))


def _brace_expand(pat: str, depth: int = 0) -> list:
    m = re.search(r'\{([^{}]*)\}', pat)
    if not m or depth > 4:
        return [pat]
    out = []
    for alt in m.group(1).split(','):
        out.extend(_brace_expand(pat[:m.start()] + alt + pat[m.end():], depth + 1))
    return out[:200]


def _shell_glob(pat: str) -> str:
    """A shell word's glob in the spelling Python's fnmatch / glob understand: bash negates a bracket with `^` as
    well as `!`, fnmatch only with `!`."""
    return re.sub(r'\[\^', '[!', pat)


def _may_match_key(pat: str) -> bool:
    """Could the shell glob `pat` select the key's file name? A POSIX class ([[:lower:]]) is not translated: it is
    judged as a match."""
    return '[:' in pat or fnmatch.fnmatchcase(KEY_NAME, _shell_glob(pat))


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


def _glob_matches_key(glob: str, rel_dir: str, any_depth: bool) -> bool:
    """Could `glob`, applied below a searched directory, select the key? rel_dir is the path from that directory to
    the store directory. any_depth: a pattern without a slash matches the file name at any depth (a ripgrep
    glob); otherwise the whole relative path has to match (the Glob tool)."""
    rel_key = KEY_NAME if rel_dir in ('', '.') else rel_dir.rstrip('/') + '/' + KEY_NAME
    for alt in _brace_expand(glob.strip().replace('\\', '/')):
        alt = alt[2:] if alt.startswith('./') else alt
        if not alt:
            continue
        if '/' not in alt.strip('/') and any_depth:
            if fnmatch.fnmatchcase(KEY_NAME, alt.lstrip('!')):
                return True
            continue
        try:
            if _glob_regex(alt.lstrip('/')).fullmatch(rel_key):
                return True
        except re.error:
            return True      # a pattern we cannot read is judged as one that matches
    return False


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
            if _is_key_file(text, cwd) or _word_reaches_key(text, cwd):
                deny('the call reads or writes the claim signing key (%s) through the field %s' % (KEY_NAME, field[:40]))
        elif text and len(text) <= MAX_LENIENT and '\n' not in text and '\x00' not in text:
            if _word_reaches_key(text, cwd, by_text=False):
                deny('the call reads or writes the claim signing key (%s) through the field %s' % (KEY_NAME, field[:40]))


def check_file_tool(tool: str, ti: dict, cwd: str) -> None:
    check_any_tool(tool, ti, cwd)
    for key in FILE_PATH_KEYS:
        v = ti.get(key)
        if v is None:
            continue
        if not isinstance(v, str):
            deny('the %s of the call is not text' % key)
        if _is_key_file(v, cwd):
            deny('the call reads or writes the claim signing key (%s)' % KEY_NAME)
    if tool not in SEARCH_TOOLS:
        return
    given = ti.get('path')
    base_real = _real(_absolute(given if isinstance(given, str) and given else cwd, cwd))
    if _inside(base_real, STORE_REAL):
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
        if _glob_matches_key(full.lstrip('/'), os.path.relpath(STORE_REAL, '/'), False):
            deny('the pattern could match the claim signing key (%s)' % KEY_NAME)
    elif _inside(STORE_REAL, base_real) and _glob_matches_key(selector, os.path.relpath(STORE_REAL, base_real), tool == 'Grep'):
        deny('the glob could match the claim signing key (%s)' % KEY_NAME)


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
    hexed = KEY_NAME.encode().hex()
    for form in _spellings(text):
        if 'claim-signing' in form or 'signing-key' in form or 'claim_signing' in form or _BOUNDARY_CLAIM.search(form):
            return True
        if KEY_NAME[::-1] in form:
            return True
        if hexed in re.sub(r'\\x|%|0x|\\u00|\s', '', form):
            return True
        for m in _STORE_SEGMENT.finditer(form):
            for alt in _brace_expand(m.group(1)):
                if alt and (alt == KEY_NAME or (re.search(r'[*?\[]', alt) and _may_match_key(alt))):
                    return True
    raw = text[:MAX_TEXT].encode('utf-8', 'ignore')
    for pad in (0, 1, 2):
        # the middle of the encoding does not depend on the bytes around the name
        inner = base64.b64encode(b'\x00' * pad + KEY_NAME.encode()).decode()[4:-4]
        for variant in (inner, inner.replace('+', '-').replace('/', '_')):
            if variant and variant.encode() in raw:
                return True
    return False


def _commands(text: str) -> list:
    """The simple commands of a shell text as token lists. Never raises: an unparsable line is cut at spaces."""
    out = []
    for line in re.split(r'[\n;]|&&|\|\||\||&(?!>)', text[:MAX_TEXT]):
        line = line.strip()
        if not line:
            continue
        try:
            toks = shlex.split(line, posix=True)
        except ValueError:
            toks = [re.sub(r'[\\\'"]', '', w) for w in line.split()]
        out.append(toks)
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


def _word_reaches_key(word: str, cwd: str, by_text: bool = True) -> bool:
    if not word or (word.startswith('-') and '/' not in word):
        return False
    return any(_is_key_file(c, cwd, by_text) for c in _expand_word(word, cwd))


def _has_flag(toks: list, short: str, longs: tuple) -> bool:
    for w in toks[1:]:
        if w.startswith('--'):
            if w.split('=', 1)[0] in longs:
                return True
        elif w.startswith('-') and len(w) > 1 and any(c in w[1:] for c in short):
            return True
    return False


def _excludes_store(toks: list) -> bool:
    for i, t in enumerate(toks):
        if t.startswith('--exclude'):
            val = t.split('=', 1)[1] if '=' in t else (toks[i + 1] if i + 1 < len(toks) else '')
            if re.fullmatch(r'(?:\./)?(?:\*/)?store/?', val.strip()):
                return True
    return False


def _covers_dir(path: str, cwd: str) -> bool:
    try:
        return os.path.isdir(_absolute(path, cwd)) and _covers_store(path, cwd)
    except (OSError, ValueError):
        return True


def check_bash(cmd: str, cwd: str) -> None:
    if _names_key_in_text(cmd):
        deny('the command names the claim signing key (%s) or a glob that could match it' % KEY_NAME)
    for toks in _commands(cmd):
        toks = _skip_wrappers(toks)
        if not toks:
            continue
        for w in toks[1:]:
            if _word_reaches_key(w, cwd):
                deny('a path in the command resolves to the claim signing key')
        head = os.path.basename(toks[0])
        operands = [w for w in toks[1:] if w and not w.startswith('-')]
        covering = [w for w in operands if any(_covers_dir(c, cwd) for c in _expand_word(w, cwd))]
        grep_recursive = head in GREP_FAMILY and (_has_flag(toks, 'rR', ('--recursive', '--dereference-recursive'))
                                                  or ('-d' in toks and 'recurse' in toks))
        if grep_recursive and len(operands) <= 1 and _covers_dir(cwd, cwd):
            covering = [cwd]      # grep -r PATTERN searches the current directory
        if not covering:
            continue
        if _excludes_store(toks):
            continue
        if grep_recursive:
            deny('a recursive grep over a directory that holds the store would read the claim signing key')
        if head in RG_FAMILY and any(w in ('--hidden', '--no-ignore', '--no-ignore-vcs', '--unrestricted') or re.fullmatch(r'-[A-Za-z]*u+[A-Za-z]*', w) for w in toks[1:]):
            deny('a search that includes hidden or ignored files over a directory that holds the store would read the claim signing key')
        if head in ARCHIVERS or (head in COPIERS and _has_flag(toks, 'rRaA', ('--recursive', '--archive'))):
            deny('copying or archiving a directory that holds the store would take the claim signing key')
        if head == 'find' and any(w in FIND_EXEC for w in toks) and '-prune' not in toks:
            deny('find -exec over a directory that holds the store could read the claim signing key')


# ---------------------------------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------------------------------

def decide(raw: str) -> None:
    try:
        payload = json.loads(raw)
    except Exception:  # noqa: BLE001
        deny('the hook input is not JSON')
    if not isinstance(payload, dict) or not isinstance(payload.get('tool_name'), str) or not isinstance(payload.get('tool_input'), dict):
        deny('the hook input has no tool_name or its tool_input is not an object')
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
        sys.stderr.write('SECRET READ GATE: BLOCKED -- %s. The key store/%s is not for an agent to read or change.\n' % (why, KEY_NAME))
        sys.exit(2)
    except BaseException as exc:  # noqa: BLE001 -- fail closed: a bug is a block
        sys.stderr.write('SECRET READ GATE: BLOCKED -- internal error while checking the call (%s).\n' % type(exc).__name__)
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
