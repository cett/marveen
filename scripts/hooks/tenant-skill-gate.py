#!/usr/bin/env python3
"""tenant-skill-gate.py -- PreToolUse gate: a tenant's skills are usable only in that tenant's requests.

The tenant of the request being served comes from agent_tenant_context (written by the
UserPromptSubmit hook tenant-context.py). This gate then refuses:
  Skill tool     -> a tenant skill (skills.tenant_id != 'fleet') the active tenant neither owns
                    nor has been granted (skill_tenant_access)
  Read/Edit/Write/NotebookEdit/Glob/Grep -> a path INSIDE such a skill's directory
                    (<..>/.claude/skills/<dir>/... or the <..>/.claude-config/skills/<dir>/... alias,
                    which includes its companion scripts; the path is also resolved through symlinks)
  Bash           -> a command that names such a skill directory (best effort, see below)
Fleet/global skills and everything that is not a tenant skill are never touched, and calls that
cannot involve a skill directory do not even open the database.

Fail closed: no context row, an unknown or conflicting tenant, a stale context (older than
TENANT_CONTEXT_MAX_AGE_SECONDS, default 12h), an unreadable database (for a call that needs it)
or an error in this gate all block the tool call. Contract: exit 0 = allow, exit 2 = block.

KNOWN LIMITS (owner decision: the shell side is best effort): a Bash command can build a path
indirectly (variables, globs over the skills root, a symlink the same command creates before it uses it),
and a path word is followed through symlinks relative to the session cwd only (a command that cd's
elsewhere first is resolved against the wrong directory); a Glob/Grep rooted ABOVE the skills
directories is allowed (it would otherwise break every repository-wide search).
"""
import json
import os
import codecs
import re
import shlex
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import tenant_context_lib as tcl  # noqa: E402


def block(msg):
    sys.stderr.write("TENANT-SKILL-KAPU: %s\n" % msg)
    sys.exit(2)


# The only scanned field that is free text is a Bash command (Read/Edit/Write/NotebookEdit are scanned by
# their file_path / notebook_path alone, never by their content, so a large Write is not touched by this
# limit). The command is read word by word with shlex, a pure-Python lexer that grows a word by string
# concatenation, so one very long word is quadratic: a 131072-character word costs about 0.6 s (Python 3.14) to 0.7 s (3.9; 1.3 s seen on a busier machine) for the two passes, a 550 kB word
# took 13.6 s, past the host timeout, and a hook that runs into it is
# non-blocking. Over the limit the gate DENIES before shlex runs; the check is O(1). The outgoing-copy
# gate already refuses a Bash command over 128 KiB, so no command the fleet can send is above it.
MAX_BASH_COMMAND_CHARS = 131072


def block_too_large(n):
    sys.stderr.write(
        "TENANT-SKILL-KAPU: a Bash parancs tul nagy ahhoz, hogy a kapu atvizsgalja "
        "(%d karakter, a hatar %d), es egy vizsgalhatatlan parancs nem mehet at.\n" % (n, MAX_BASH_COMMAND_CHARS)
    )
    try:
        from gate_audit_lib import DenyExit  # the audit row then carries the reason code
    except Exception:  # noqa: BLE001
        sys.exit(2)
    raise DenyExit(2, 'input_too_large')


def block_path_word_too_long(n):
    sys.stderr.write(
        "TENANT-SKILL-KAPU: egy utvonal-mezo tul hosszu ahhoz, hogy a kapu feloldja "
        "(%d karakter, a hatar %d; valodi utvonal nem hosszabb), es egy feloldhatatlan utvonal nem mehet at.\n"
        % (n, MAX_PATH_WORD_CHARS)
    )
    try:
        from gate_audit_lib import DenyExit  # the audit row then carries the reason code
    except Exception:  # noqa: BLE001
        sys.exit(2)
    raise DenyExit(2, 'input_too_large')


def skill_dirs_in(text, cwd, resolve=False):
    """Skill directory names a path/command string points into (best effort).

    resolve=True also follows symlinks (os.path.realpath), so a path that reaches a skill directory through a
    link the textual pattern does not know (an alias onto the global skills root, a custom symlink) is still
    seen. realpath never raises for a missing path; a malformed one (embedded NUL) raises ValueError, which
    main() turns into a block."""
    found = []
    if not text:
        return found
    variants = [text]
    base = None
    if text.startswith("~"):
        base = os.path.expanduser(text)
    elif text.startswith("/"):
        base = text
    elif cwd:
        base = os.path.join(cwd, text)
    if base is not None:
        variants.append(os.path.normpath(base))
        if resolve:
            # A word over MAX_PATH_WORD_CHARS is not resolved as written (see there); its textual and normpath
            # variants above are matched, both linear. When the NORMALIZED word is short enough (`link/` + `x/../` * N
            # + `skill/SKILL.md` collapses to a short path) it is resolved: the cost is bounded by the short form.
            if len(text) <= MAX_PATH_WORD_CHARS:
                variants.append(os.path.realpath(base))
            elif len(variants[-1]) <= MAX_PATH_WORD_CHARS:
                variants.append(os.path.realpath(variants[-1]))
    for v in variants:
        if "skills/" not in v.lower():
            continue
        for m in tcl.SKILL_DIR_RX.finditer(v):
            if m.group(1) not in found:
                found.append(m.group(1))
    return found


# Absolute or ~ path words in a shell command (separator and quoting characters end a word).
_BASH_PATH_RX = re.compile(r"(?:^|(?<=[\s'\"=(]))[~/][^\s'\"`;|&<>()$*?\[\]{}\\]*")


def _shell_words(command):
    """The words of a command as the shell sees them (quotes and backslashes removed, operators split off),
    so '/abs/.cla'ude/skills/x/SKILL.md' and a backslash-escaped path are read as the path they spell.
    A command shlex cannot parse (an apostrophe in prose, an unterminated quote) yields no words: the textual
    and regex passes still run on it, it is not blocked for that."""
    words = []
    # Two readings: the command as written, and with every $'...' (ANSI-C quoting, which shlex does not
    # decode) replaced by the text it spells ($'/.\x63laude/skills/x' -> '/.claude/skills/x').
    for text in (command, _ansi_c_decoded(command)):
        # The decoded copy can be longer than the command: every `\'` inside a $'...' becomes `'"'"'`, so a
        # command inside the limit can decode to 2.5 times it. The copy is lexed too, so it has the same limit.
        if len(text) > MAX_BASH_COMMAND_CHARS:
            raise DecodedCopyTooLarge(len(text))
        try:
            lex = shlex.shlex(text, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""   # bash starts a comment only at the START of a word; shlex would also cut mid-word
            words += list(lex)
        except ValueError:
            pass
    return words


_ANSI_C_RX = re.compile(r"\$'((?:[^'\\]|\\.)*)'")


def _ansi_c_decoded(command):
    def decode(m):
        try:
            text = codecs.decode(m.group(1), "unicode_escape")
        except (UnicodeDecodeError, ValueError):
            return m.group(0)
        return shlex.quote(text)
    return _ANSI_C_RX.sub(decode, command)


# Every `~name` word is expanded with pwd.getpwnam, a directory-service lookup of ~0.15 ms on macOS, so a command of
# 20000 distinct `~nameN` words costs ~3 s inside the size limit, too close to the 10 s host timeout on a loaded
# machine. A real command names a handful of users; more distinct `~name` words than this is refused (the code
# counts words, so `~+` and `~-` count too).
MAX_TILDE_USERS = 256


class TooManyTildeUsers(Exception):
    pass


class DecodedCopyTooLarge(Exception):
    def __init__(self, n):
        super().__init__(n)
        self.n = n


# os.path.realpath is quadratic in the number of components of ONE path: a single ~65000-component path word
# (inside the command limit) took a median 2.6 s, p90 3.8 s, max 4.4 s for the whole gate on a loaded machine
# (Python 3.9), too close to the 10 s host timeout. A word over this length is therefore NOT resolved through
# symlinks (an O(1) length check per word; it bounds the realpath cost per word to ~2000 components, and the sum
# over the words to what the command limit allows). Why skip and not deny: the kernel refuses a path over
# PATH_MAX (1024 on macOS, 4096 on Linux) with ENAMETOOLONG anyway, but the in-process Python realpath would
# resolve it component by component; skipping avoids that, while a legitimate command that merely carries a long
# word with a "/" in it (`echo <base64> | base64 -d`, `python3 -c`, `git commit -m`, `curl -d`) goes through. The
# textual match and the lexical (posixpath.normpath) variant, both linear, still run on such a word, so a
# `x/../` padding cannot hide a literal skill path, and when the normalized word is within the limit it is
# resolved too (padding collapses to a short path, so a symlink behind padding is followed). A DENY (input_too_large) stays for the fields that ARE a path:
# the file_path / notebook_path of Read, Edit, Write, NotebookEdit and the path of Glob and Grep. A Glob/Grep
# pattern or glob is free text and is only skipped when long. The remaining risk: a symlink reached through one
# word that is longer than this even after normalization (a non-collapsing word) is not followed.
MAX_PATH_WORD_CHARS = 4096


class PathWordTooLong(Exception):
    def __init__(self, n):
        super().__init__(n)
        self.n = n


def _check_path_word(word):
    if len(word) > MAX_PATH_WORD_CHARS:
        raise PathWordTooLong(len(word))


def bash_skill_dirs(command, cwd=None):
    """Directory names a shell command points into: the textual match plus every path word (raw regex words
    and shell-dequoted words, relative ones joined to the session cwd) resolved through symlinks."""
    found = skill_dirs_in(command, None)
    words = {}  # a dict keeps the order and de-duplicates in O(1); a list "in" test is quadratic in the word count
    for w in _BASH_PATH_RX.findall(command) + [w for w in _shell_words(command) if "/" in w or w.startswith("~")]:
        words[w] = None
    if sum(1 for w in words if w.startswith("~") and not w.startswith("~/") and w != "~") > MAX_TILDE_USERS:
        raise TooManyTildeUsers()
    for word in words:
        for d in skill_dirs_in(word, cwd, resolve=True):
            if d not in found:
                found.append(d)
    return found


def extract(tool, inp, cwd):
    """-> list of ('skill', name) / ('dir', dirname) targets; empty when the call cannot involve a tenant skill."""
    out = []
    if tool == "Skill":
        name = str(inp.get("skill") or inp.get("name") or "").strip()
        out.append(("skill", name))
    elif tool in ("Read", "Edit", "Write", "NotebookEdit"):
        for k in ("file_path", "notebook_path"):
            _check_path_word(str(inp.get(k) or ""))
            out += [("dir", d) for d in skill_dirs_in(str(inp.get(k) or ""), cwd, resolve=True)]
    elif tool in ("Glob", "Grep"):
        for k in ("path", "pattern", "glob"):
            if k == "path":   # a pattern / glob is free text: long ones are only not resolved
                _check_path_word(str(inp.get(k) or ""))
            out += [("dir", d) for d in skill_dirs_in(str(inp.get(k) or ""), cwd, resolve=True)]
    elif tool == "Bash":
        out += [("dir", d) for d in bash_skill_dirs(str(inp.get("command") or ""), cwd)]
    return out


def main():
    try:
        ev = json.loads(sys.stdin.read())
    except Exception:
        block("a bemenet nem olvashato, ezert BLOKKOL.")
    tool = ev.get("tool_name") or ""
    inp = ev.get("tool_input") or {}
    cwd = ev.get("cwd") or ""
    if tool == "Bash" and len(str(inp.get("command") or "")) > MAX_BASH_COMMAND_CHARS:
        block_too_large(len(str(inp.get("command"))))
    try:
        targets = extract(tool, inp, cwd)
        if not targets:
            sys.exit(0)
        agent_id = ledger_lib.agent_id_from_cwd(cwd)
        con = sqlite3.connect("file:%s?mode=ro" % ledger_lib.db_path(), uri=True, timeout=3)
        try:
            skills = tcl.load_tenant_skills(con)
            ctx = tcl.read_context(con, agent_id)
            serves = ctx is None or tcl.context_still_serves(con, agent_id, ctx)
        finally:
            con.close()
        tenant, why = tcl.usable_context(ctx)
        if tenant is not None and not serves:
            tenant, why = None, "az agens mar nincs engedelyezve a(z) '%s' tenanthez" % ctx["tenant_id"]
        for kind, value in targets:
            need_all = False
            if kind == "skill":
                cands = [s for s in skills if value in s["names"]]
            else:
                # An exact-case match is the directory the path names; only without one does the case-insensitive
                # match stand in (a case-insensitive volume), and then EVERY candidate must be usable, so a
                # tenant's own "Foo" never opens another tenant's "foo".
                exact = [s for s in skills if s["dir"] == value]
                cands = exact or [s for s in skills if (s["dir"] or "").casefold() == value.casefold()]
                need_all = not exact
            if not cands:
                continue  # fleet/global/plugin skill or not a skill at all
            if tenant is None:
                block("a(z) '%s' tenant-skill nem hasznalhato: %s. Tenant-skill csak a sajat tenantja keresehez tartozik." % (value, why))
            usable = all if need_all else any
            if not usable(tcl.skill_accessible(s, tenant) for s in cands):
                block("a(z) '%s' skill masik tenanthez tartozik, ez a keres a(z) '%s' tenanthe. A skill ebben a keresben nem hasznalhato." % (value, tenant))
    except SystemExit:
        raise
    except DecodedCopyTooLarge as exc:
        block_too_large(exc.n)
    except PathWordTooLong as exc:
        block_path_word_too_long(exc.n)
    except TooManyTildeUsers:
        block("a Bash parancs tobb mint %d kulonbozo ~nev szot tartalmaz, ezt a kapu nem vizsgalja at, ezert BLOKKOL." % MAX_TILDE_USERS)
    except Exception as exc:
        block("a kapu maga hibara futott (%s: %s), ezert BLOKKOL. Ez a kapu hibaja, nem a tied." % (type(exc).__name__, exc))
    sys.exit(0)


if __name__ == "__main__":
    # OTel H5b: count this run's outcome after the verdict (best effort, never changes it; see
    # gate_audit_lib.py). A missing or broken audit module leaves the gate exactly as it was.
    try:
        from gate_audit_lib import audited
    except Exception:  # noqa: BLE001
        audited = None
    if audited is None:
        main()
    else:
        audited('tenant-skill-gate', main, deny_row=True)
