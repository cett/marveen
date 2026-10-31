#!/usr/bin/env python3
"""PreToolUse gate on the MAIN agent's outbound email: Hungarian copy QA.

Why this exists (Szabi, 2026-08-10 12:57): a licence-delivery email went out to a
client with every accent stripped ("Szia Balint, itt van a Marveen licenckulcsod
es a telepito"). It was the second accent incident that day -- the first was a
client-facing spreadsheet the same morning. Szabi asked for a gate that inspects
outgoing copy BEFORE the send and rejects it if something is wrong.

Note the seam this fills. `scripts/email-send-gate.mjs` already gates outbound
email, but it gates SUB-AGENTS (it is wired by writeAgentSettingsFromProfile()
guarded by `name !== MAIN_AGENT_ID`) and it is a hard deny, not a content check.
Nothing at all ran on the main agent's own sends -- and the main agent is the one
that actually writes to customers.

What it checks, all three from standing owner rules in CLAUDE.md:
  1. Hungarian text that is missing its accents (the incident above).
  2. Em dash (U+2014) -- forbidden in every deliverable.
  3. Owner-specific NAME rules (misspelled surnames etc.) -- loaded from an
     untracked local rules file (GATEPERSIST816), never hardcoded here.

FAIL-CLOSED ON AN UNREADABLE BODY. If the call looks like a send but the body
cannot be recovered (e.g. `send.py ... < $SP/body.txt`, where $SP is a shell
variable this hook cannot resolve), the gate BLOCKS. A send whose content cannot
be inspected defeats the point of the gate, so "I could not read it" must not
mean "let it through". The block message says how to make it inspectable.

Contract: PreToolUse. Reads the hook payload on stdin, exit 0 = allow,
exit 2 = block (stderr goes back to the model).
"""
import bisect
import json
import os
import re
import sys

# --- what counts as an email send -------------------------------------------
# KAPUHATOKOR822 (2026-08-22, NEGY hamis pozitiv egy delutanon, HAROM
# muvelet-tipuson: inter-agent uzenet, sqlite-iras, fajl-OLVASAS): a korabbi
# szures a TELJES parancs-stringben kereste a kuldes-mintakat, igy egy
# inter-agent curl JSON-torzse ('"to":' a boritekban + 'send.py' a szoveg
# TARTALMABAN), egy hirlevel-szoveget iro sqlite-parancs vagy a send-script
# puszta elolvasasa is kuldesnek latszott. A kapu levelnek olvasta azt, ami
# uzenet A RENDSZERROL -- es pont arrol a temarol nemitotta volna el a
# flottat, amirol a legfontosabb beszelni (Iris tetje: egy valodi incidenst
# nem lehetne jelenteni rola).
#
# A szures ezert PARANCS-POZICIORA megy, nem tartalomra: elobb kivagjuk a
# heredoc-torzseket es az idezett stringeket (a tartalom igy nem tud parancs-
# nak latszani), majd pipeline/szekvencia-szegmensenkent a MEGHIVOTT programot
# nezzuk. Kuldes az, ahol a kuldo program fut:
#   - sendmail / msmtp / swaks a program-pozicioban (ezek csak kuldeni tudnak);
#   - send.py TENYLEGES futtatasa (python vagy kozvetlen ut) --to cimzettel a
#     SAJAT szegmenseben (a --help/olvasas igy nem trigger);
#   - graph-mail futtatasa `send` alparanccsal;
#   - curl/wget, amelynek IDEZETLEN URL-tokenje az api.resend.com-ra mutat
#     (a -d payloadban idezett elofordulas nem szamit -- az tartalom).
# MASODIK KOR (Marveen adverzarialis merese, msg 14282): az elso valtozat a
# quoted stringeket VAKON vagta ki, ezert ket hamis negativot nyitott -- az
# IDEZOJELES URL a curl sajat argumentum-helyen (a curl SZOKASOS irasmodja!)
# es a burkolo hejj `-c` string-argumentuma atment. A gyoker: az idezojel a
# TARTALOM ellen jo hatar, de nem mondja meg, hogy a token URL- vagy
# PROGRAM-POZICIOBAN all-e. Ezert a kivagas helyett QUOTE-TUDATOS tokenizalas
# fut (shlex): az idezett token EGY tokenkent, poziciojaval egyutt erkezik --
# a curl idezojeles URL-argumentuma igy vizsgalhato, mikozben egy -d payload
# belsejeben emlitett domain tovabbra is csak tartalom (az URL-minta a token
# ELEJERE horgonyzott). A wrapper hejj (`sh -c "..."`) string-argumentuma
# rekurzivan elemzodik.
# A heredoc-kivagas SORREND-FUGGETLEN (Marveen 3. kore, msg 14286): a
# hatarolo utani SOR-MARADEK (pl. atiranyitas: <<EOF > fajl) a parancs
# resze es MEGMARAD -- csak a torzs esik ki. Enelkul (a) forditott
# sorrendnel a torzs parancsnak latszott (FP), (b) a bevezeto sor
# eldobasa a heredoc-taplalt VALODI kuldot vesztette volna el (FN).
#
# A heredoc is found by _scan_heredocs() (below), ONE LINEAR PASS, not by a regex. The old
# single regex (an intro `<<-?\s*'?(\w+)'?[^\n]*`, a newline, then a lazy body up to
# `\n<TAG>`) was superlinear on hostile input: `<<` plus a long run of word characters
# and no newline backtracked quadratically through the intro, and every never-closed opener
# re-scanned the rest of the string for its closer (50 openers x 100K did not finish in
# 90 s). A hook still running at its timeout is NOT a deny (the host treats it as
# non-blocking), so a slow classifier is a fail-OPEN. Same decision as before, bounded work.
# Mirrored in scripts/email-send-gate.mjs (scanHeredocs); keep the two identical.
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")
# KWSPLIT924: shell reserved words that put the NEXT word in command position.
# The segmenter splits on operators only, so `if true; then sendmail x; fi`
# gave the segment [then, sendmail, x] whose "program" was `then`: the send was
# not recognised and the copy audit was silently skipped (same for do / else /
# elif / { / !, and the condition after if / while / until). They are stripped
# ONLY at the head of a segment, i.e. in command position, never as separators:
# `echo then sendmail x` stays a single echo. `in` is deliberately NOT here: the
# words after it are data, and `for m in sendmail msmtp; do which $m; done` must
# stay false. `for` / `case` are not here either: the word after them is a name
# or a subject, not a command. Mirrored in email-send-gate.mjs (CMD_POSITION_KEYWORDS);
# the shared send-invocation-cases.json binds the two.
_CMD_POSITION_KEYWORDS = frozenset(("if", "then", "else", "elif", "do", "while", "until", "{", "!"))
_SENDER_PROG = re.compile(r"^(sendmail|msmtp|swaks)$", re.I)
_SENDPY = re.compile(r"^send\.py$", re.I)
# SUBAGENTMAILGATE1016: a version-suffixed interpreter (python3.12, python3.13t) is the same python.
_PYTHON = re.compile(r"^python(3(\.\d+t?)?)?$", re.I)
# A ket kapu (ez + scripts/email-send-gate.mjs) SZANDEKOSAN azonos
# felismeres-szemantikat visel, es ezt kozos eset-lista orzi
# (send-invocation-cases.json + konformancia-teszt): a divergencia
# teszt-hibakent jelenjen meg, ne incidenskent (Marveen, msg 14289).
_NODEISH = re.compile(r"^(node|tsx|ts-node|deno|bun|npx)$", re.I)
_GRAPHMAIL = re.compile(r"^graph-mail(\.ts|\.js)?$", re.I)
_WRAPPER_SHELL = re.compile(r"^(sh|bash|zsh|dash)$", re.I)
_CURLISH = re.compile(r"^(curl|wget|http)$", re.I)
# Interpreter kod-string argumentum (python -c / node -e): az interpreternek
# atadott kod MUVELET, nem tartalom -- a kod-szintu kuldes-hivasokra szurunk.
#
# KIMONDOTT HATAR (Marveen, msg 14298): tetszoleges interpreter-kod statikus
# elemzese eldonthetetlen -- ez a kapu a VELETLEN kuldest fogja meg, nem egy
# elszant kikerulot. A lenti exec-heurisztika a NAIV alakokat fedi (a kod
# process-inditast ES kuldo-programnevet egyutt tartalmaz); ennel tobbet nem
# allit, es nem is allithat.
_CODE_SEND = re.compile(
    r"\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b", re.I
)
# Issue #1853 (stylnet): the support-mail sender LOADED AS A MODULE, not run by its
# file name -- `import send`, `from send import main`, runpy, __import__/import_module,
# or a spec built from send.py. The file-name rule below never saw these, so the call
# went past the approval gate. Case-sensitive on purpose (Python names are), and
# `send` must be the whole module name: `import sendgrid_x` or a "send" word in a
# string stays out. Mirrored in email-send-gate.mjs (CODE_SEND_MODULE).
_CODE_SEND_MODULE = re.compile(
    r"\bimport\s+(?:[\w.]+\s*,\s*)*send\b(?![\w.])"
    r"|\bfrom\s+send\s+import\b"
    r"|\brunpy\b[^\n]*\bsend\b"
    r"|\b(?:__import__|import_module)\s*\(\s*['\"]send['\"]"
    r"|\bspec_from_file_location\b[^\n]*\bsend\.py\b"
    # The same class on the Graph sender (src/graph-mail.ts, export sendMail): renamed on
    # import, or reached by a string key -- the call itself then never reads `sendMail(`.
    r"|\bsendMail\s+as\b|\[\s*['\"]sendMail['\"]\s*\]"
)
_CODE_EXECISH = re.compile(
    r"\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(",
    re.I,
)
_CODE_SENDER_LIT = re.compile(r"sendmail|msmtp|swaks|send\.py", re.I)


def _code_string_sends(code: str) -> bool:
    if _CODE_SEND.search(code) or _CODE_SEND_MODULE.search(code):
        return True
    return bool(_CODE_EXECISH.search(code) and _CODE_SENDER_LIT.search(code))
# Token-ELEJERE horgonyzott cel-minta: egy URL-argumentum vagy csupasz
# domain/utvonal illik ra; egy JSON-payload ('{...api.resend.com...}') nem.
_RESEND_TARGET = re.compile(r"^(https?://)?([^/@\s]*\.)?api\.resend\.com(/|$|\s|$)", re.I)


def _url_arg(t: str) -> str:
    """curl takes its URL as `--url https://...` (two tokens, the URL is its own token) or as
    `--url=https://...` (ONE token): the target pattern is anchored to the token start, so
    the glued form is read after its `--url=` prefix. Mirrored in email-send-gate.mjs (urlArg)."""
    return t[len("--url="):] if t.startswith("--url=") else t

# RESENDGATE826: a resend-celu curl/wget csak akkor KULDES, ha a METODUS az.
# A korabbi minta metodus-vak volt, es egy read-only GET /domains (nincs torzs,
# nincs cimzett) ugyanugy fail-closed elutasitast kapott -- pont egy domain-
# verifikacios MERES akadt el rajta. A szukites iranya szigoru: a metodust
# FELISMERNI kell (explicit -X/--request/--method, vagy implicit POST a
# torzs-flagekbol); ha nem allapithato meg (valtozo, config-fajl, csonka flag),
# marad a fail-closed. Egy "nincs felismerheto torzs -> atmegy" szabaly a
# kaput utne ki, ezert ILYEN AG NINCS.
_CURL_BODY_OPTS = {
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--data-ascii", "-F", "--form", "--form-string", "--json",
    "-T", "--upload-file",
    # wget torzs-flagek
    "--post-data", "--post-file", "--body-data", "--body-file",
}
_SAFE_METHODS = {"GET", "HEAD"}


# RESENDGETTWIN1010: a httpie (`http`) metodusa POZICIONALIS (http POST URL),
# a torzse `kulcs=ertek` / `kulcs:=json` elem -- egyiket sem ismeri az alabbi
# curl/wget flag-olvaso, ezert a `http POST .../emails to=...` "read" lett, es a
# kapu atengedte. A httpie-re a metodus itt nem dontheto: fail-closed.
_HTTPIE = re.compile(r"^http$", re.I)


def _curl_resend_verdict(prog, rest):
    """'read' | 'send' | 'unknown' -- unknown a hivo oldalon fail-closed."""
    if _HTTPIE.match(prog):
        return "unknown"
    method = None
    has_body = False
    get_forced = False
    i, n = 0, len(rest)
    while i < n:
        t = rest[i]
        if t in ("-X", "--request", "--method"):
            if i + 1 >= n or not rest[i + 1].isalpha():
                return "unknown"  # csonka vagy valtozo ($METHOD) -- nem dontheto
            method = rest[i + 1].upper()
            i += 2
            continue
        if t.startswith("--request=") or t.startswith("--method="):
            m = t.split("=", 1)[1]
            if not m.isalpha():
                return "unknown"
            method = m.upper()
            i += 1
            continue
        if t in ("-G", "--get"):
            get_forced = True
            i += 1
            continue
        if t in ("-K", "--config"):
            return "unknown"  # a config-fajl rejtett metodust/torzset hordozhat
        if t in _CURL_BODY_OPTS or any(
            t.startswith(o + "=") for o in _CURL_BODY_OPTS if o.startswith("--")
        ):
            has_body = True
            i += 1
            continue
        if t.startswith("-") and not t.startswith("--") and len(t) > 1:
            # egy-kotojeles cluster (-sS, -sX POST, -sd '{}'): a betuk kotegelve
            letters = t[1:]
            if "X" in letters:
                after = letters.split("X", 1)[1]
                if after:
                    if not after.isalpha():
                        return "unknown"
                    method = after.upper()
                else:
                    if i + 1 >= n or not rest[i + 1].isalpha():
                        return "unknown"
                    method = rest[i + 1].upper()
                    i += 1
            elif "d" in letters or "F" in letters or "T" in letters:
                has_body = True
            elif "G" in letters:
                get_forced = True
            elif "K" in letters:
                return "unknown"
            i += 1
            continue
        i += 1
    if method is not None and method not in _SAFE_METHODS:
        return "send"
    if has_body and not get_forced:
        # implicit POST (curl -d/-F/--json/-T alapertelmezese), vagy egy
        # gyanus "GET torzzsel" alak -- mindketto kuldeskent kezelve
        return "send"
    return "read"
# A tovabbi kuldes-jellegu literalok, amikre a parse-hiba eseten (es CSAK
# akkor) konzervativan visszaesunk -- lasd is_send_invocation vegen.
_FALLBACK_LITERALS = re.compile(
    r"send\.py|api\.resend\.com|\bsendmail\b|\bmsmtp\b|\bswaks\b"
    r"|\bsmtplib\b|\bsendMail\s*\(", re.I
)


def _basename(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def _mask_subshell_markers(cmd: str) -> str:
    """Idezojelen KIVULI ujsor/`$(`/backtick -> `;` szeparator, hogy a shlex
    szegmens-hatarkent lassa; idezojelen BELUL a szoveg erintetlen (tartalom)."""
    out = []
    q = None  # None | "'" | '"'
    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if ch == q:
                q = None
            out.append(ch); i += 1; continue
        if ch in "'\"":
            q = ch; out.append(ch); i += 1; continue
        if ch == "\\" and i + 1 < n:
            out.append(cmd[i:i + 2]); i += 2; continue
        if ch == "\n" or ch == "`":
            out.append(";"); i += 1; continue
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            out.append(";"); i += 2; continue
        out.append(ch); i += 1
    return "".join(out)


# --- bounded heredoc scan -------------------------------------
# Hard limits, measured on 365k real Bash calls of the fleet (max command 32 KB, max 7
# heredoc openers, longest opener line 1.7 KB): each limit is 4x or more above anything
# seen. Over a limit the gate does NOT guess: it DENIES ("too large to inspect",
# fail-closed), because an inspection that cannot finish inside the hook timeout would
# otherwise let the call through.
MAX_CMD_CHARS = 131072
MAX_HEREDOC_OPENERS = 32
MAX_OPENER_LINE_CHARS = 4096
# The text the audit reads (an MCP email body, or what is recovered from a Bash command) may not be longer
# than this; over it the gate DENIES ("too large to inspect"), like the command limit above.
MAX_AUDIT_CHARS = 262144


class InspectionLimit(Exception):
    """The command is too large to inspect inside the hook timeout (the caller DENIES)."""


_HEREDOC_INTRO = re.compile(r"<<-?\s*'?(\w+)")
_LINE_RUN = re.compile(r"\w+")
_WS_CHAR = re.compile(r"\s")


def _build_closer_index(cmd: str):
    r"""Closing-line candidates of the whole command, built in ONE pass: every line that
    starts with a word-character run followed by whitespace or the end of the string (the
    old regex's `\n<TAG>(?=\s|$)`). A closer for delimiter TAG is exactly such a line
    whose run equals a PREFIX of the opener's word (the old regex backtracked `\w+` to
    shorter delimiters), so a query is a few dict lookups, not a rescan."""
    by_run = {}
    n = len(cmd)
    nl = cmd.find("\n")
    while nl != -1:
        s = nl + 1
        r = _LINE_RUN.match(cmd, s)
        if r:
            e = r.end()
            if e == n or _WS_CHAR.match(cmd, e):
                by_run.setdefault(r.group(), []).append(s)
        nl = cmd.find("\n", s)
    return by_run, sorted({len(k) for k in by_run}, reverse=True)


def _find_closer(index, word: str, min_start: int):
    """(start, delim_len) of the first closer line start >= min_start for the longest usable
    prefix of `word`, or None."""
    by_run, lengths_desc = index
    for k in lengths_desc:
        if k > len(word):
            continue
        lst = by_run.get(word[:k])
        if not lst or lst[-1] < min_start:
            continue
        return lst[bisect.bisect_left(lst, min_start)], k
    return None


_last_scan = (None, None)


def _scan_heredocs(cmd: str):
    """The matches the old regex found, left to right and non-overlapping, as tuples
    (start, intro_end, body_start, body_end, end): intro = cmd[start:intro_end] (the old
    group 1), body = cmd[body_start:body_end] (keeps its final newline), end = just past
    the closing tag. Raises InspectionLimit over a limit."""
    global _last_scan
    if _last_scan[0] == cmd:
        return _last_scan[1]
    if len(cmd) > MAX_CMD_CHARS:
        raise InspectionLimit(f"command is {len(cmd)} characters, the limit is {MAX_CMD_CHARS}")
    found = []
    index = None
    openers = 0
    i = cmd.find("<<")
    while i != -1:
        m = _HEREDOC_INTRO.match(cmd, i)
        if not m:
            i = cmd.find("<<", i + 1)
            continue
        openers += 1
        if openers > MAX_HEREDOC_OPENERS:
            raise InspectionLimit(f"more than {MAX_HEREDOC_OPENERS} heredoc openers")
        q = cmd.find("\n", m.end())
        if q != -1:
            if index is None:
                index = _build_closer_index(cmd)
            closer = _find_closer(index, m.group(1), q + 2)
            if closer:
                if q - (cmd.rfind("\n", 0, i) + 1) > MAX_OPENER_LINE_CHARS:
                    raise InspectionLimit(
                        f"a heredoc opener line is longer than {MAX_OPENER_LINE_CHARS} characters")
                end = closer[0] + closer[1]
                found.append((i, q, q + 1, closer[0], end))
                i = cmd.find("<<", end)
                continue
        i = cmd.find("<<", i + 1)
    _last_scan = (cmd, found)
    return found


def _strip_heredoc_bodies(cmd: str) -> str:
    """cmd with every heredoc BODY cut and its opening line kept (the old regex `sub` with group 1)."""
    out = []
    pos = 0
    for (_start, intro_end, _bs, _be, end) in _scan_heredocs(cmd):
        out.append(cmd[pos:intro_end])
        pos = end
    if not pos:
        return cmd
    out.append(cmd[pos:])
    return "".join(out)


def _segments_tokens(cmd: str):
    """[[token, ...], ...] szegmensenkent -- quote-tudatosan, poziciot orizve."""
    import shlex
    lex = shlex.shlex(_mask_subshell_markers(_strip_heredoc_bodies(cmd)),
                      posix=True, punctuation_chars="();|&")
    lex.whitespace_split = True
    segments, cur = [], []
    for tok in lex:
        # SEGSPLIT923: shlex(punctuation_chars) returns a RUN of operator
        # characters as ONE token, so `$(date); sendmail ...` (after the
        # subshell mask: `;date); sendmail`) yielded the token ");" -- not in
        # the list, so it did not split, `sendmail` landed mid-segment, and the
        # send was NOT recognised: the copy audit was silently skipped. The JS
        # twin (email-send-gate.mjs) said true on the same input; nothing in
        # the conformance list covered it. A token made ONLY of operator
        # characters is always an operator sequence, so it separates.
        if tok in ("|", "||", "&", "&&", ";", "(", ")", ";;", "|&") or (tok and set(tok) <= set("();|&")):
            if cur:
                segments.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        segments.append(cur)
    return segments


# SENDWRAP924: a wrapper in front of the sender -- `sudo sendmail x`,
# `time -p sendmail x`, `env -i sendmail x`, `timeout 10 sendmail x` -- made
# the wrapper the "program", so the send was not recognised and the copy audit
# was silently skipped (13 measured shapes, both copies). A wrapper is stepped
# over WITH its own flags: a flag that takes a value consumes it, so in
# `sudo -u sendmail true` the program is `true`, not `sendmail`.
# name -> (short flags taking a value, long flags taking a value, positional
# arguments before the command). An UNKNOWN long flag without `=` may or may
# not take a value, so both readings are tried and either one being a send
# counts: an unknown flag errs toward auditing, never toward skipping.
# `command -v/-V` looks a name up and runs nothing. `function NAME` and
# `coproc [NAME]` put their body in command position. Mirrored in
# email-send-gate.mjs (WRAPPERS / commandHeads); send-invocation-cases.json
# binds the two.
_WRAPPERS = {
    "time": ("fo", ("format", "output"), 0),
    "sudo": ("ughpCUrtDRT", ("user", "group", "host", "prompt", "close-from", "other-user",
                             "role", "type", "chdir", "chroot", "command-timeout"), 0),
    "env": ("uCS", ("unset", "chdir", "split-string"), 0),
    "nohup": ("", (), 0),
    "nice": ("n", ("adjustment",), 0),
    "exec": ("a", (), 0),
    "command": ("", (), 0),
    "xargs": ("ILnPsdEa", ("arg-file", "delimiter", "eof", "replace", "max-lines", "max-args",
                           "max-procs", "max-chars", "process-slot-var"), 0),
    "timeout": ("sk", ("signal", "kill-after"), 1),
    # setsid: for future use and symmetry. NOT measured local traffic: the hits the
    # first count found all sat inside quoted remote (ssh) command strings or heredoc
    # bodies, and that pattern was not quote-aware (Marveen's correction, 2026-09-24).
    "setsid": ("", (), 0),
}
_HEAD_DEPTH = 8


# A wrapper with more unknown long flags than this (`sudo --a --a --a ...`) is refused as too
# large to inspect: every flag opens one more reading of the rest, so the heads were O(n^2)
# (40k flags: 49 s here, an out-of-memory crash in the JS twin -- both fail-open). Real
# wrappers carry at most a few unknown flags.
MAX_WRAPPER_FLAG_STARTS = 32


def _command_heads(toks, _d: int = 0):
    """Every token list that can be the real command of this segment, after the
    leading assignments, command-position keywords and wrappers are stepped over."""
    skip = 0
    while skip < len(toks) and (_ENV_ASSIGN.match(toks[skip]) or toks[skip] in _CMD_POSITION_KEYWORDS):
        skip += 1
    if skip:
        toks = toks[skip:]
    if not toks:
        return [toks]
    w = _basename(toks[0])
    if _d >= _HEAD_DEPTH:
        # Still a wrapper at the depth bound: the real command is out of sight,
        # so it counts as a send (None) -- the bound errs toward auditing, like
        # an unknown flag does. It used to return the wrapper itself, and nine
        # nested wrappers + sendmail was silently skipped (Samu, #1521 review).
        return [None] if (w in _WRAPPERS or w in ("function", "coproc")) else [toks]
    if w == "function":
        return _command_heads(toks[2:], _d + 1)
    if w == "coproc":
        return _command_heads(toks[1:], _d + 1) + _command_heads(toks[2:], _d + 1)
    spec = _WRAPPERS.get(w)
    if spec is None:
        return [toks]
    short_val, long_val, positionals = spec
    i, starts = 1, []
    while i < len(toks):
        t = toks[i]
        if t == "--":
            i += 1
            break
        if t.startswith("--"):
            if "=" not in t and t[2:] in long_val:
                i += 2
                continue
            if "=" not in t:
                starts.append(i + 2)
            i += 1
            continue
        if t.startswith("-") and len(t) > 1:
            if w == "command" and ("v" in t or "V" in t):
                return []
            k = next((j for j, ch in enumerate(t[1:], 1) if ch in short_val), -1)
            i += 2 if k == len(t) - 1 else 1
            continue
        break
    if len(starts) > MAX_WRAPPER_FLAG_STARTS:
        raise InspectionLimit(f"a wrapper carries more than {MAX_WRAPPER_FLAG_STARTS} unknown long flags")
    starts.insert(0, i)
    heads = []
    for s in starts:
        heads += _command_heads(toks[s + positionals:], _d + 1)
    return heads


def _segment_is_send(toks, depth: int) -> bool:
    return any(_head_is_send(h, depth) for h in _command_heads(toks))


# SUBAGENTMAILGATE1016: the sender was recognised only with the script as the
# FIRST interpreter argument and the exact --to flag. The boundary and the
# measured bypasses are written out at pythonHeadSends in email-send-gate.mjs
# (the JS twin); send-invocation-cases.json binds the two. MAILGATEVARARGS1020
# narrowed the undecidable-path branch to the recipient flag (same place).
_PY_OPT_WITH_ARG = {"-X", "-W", "--check-hash-based-pycs"}
_RECIPIENT_FLAG = re.compile(r"^--to?(=|$)")
_UNDECIDABLE_PATH = re.compile(r"[*?[{$]")
# CPython reads a cluster of short options left to right (`-uX utf8`, `-um send`, `-msend`,
# `-uc "code"`): the first of c, m, X or W takes the rest of the token as its value, or the next
# token when nothing is left. Mirrored in email-send-gate.mjs (pythonCluster); keep the two identical.
_PY_CLUSTER = re.compile(r"^-[A-Za-z]")


def _python_cluster(t):
    """(opt, value) for a short-option cluster; the value is the rest of the token WHATEVER characters it holds
    (`-mpkg.send`, `-c"import x; ..."`). opt is None when the letters before the first non-letter hold none of
    c, m, X, W. None when t is no cluster."""
    if not _PY_CLUSTER.match(t):
        return None
    for j in range(1, len(t)):
        if t[j] in "cmXW":
            return t[j], t[j + 1:]
        if not t[j].isascii() or not t[j].isalpha():
            break
    return None, ""


def _python_script_operand(rest):
    """(script, stdin, stdin_redirect) for an interpreter's argument list."""
    stdin_redirect = False
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            return (rest[i + 1] if i + 1 < len(rest) else None), False, stdin_redirect
        if t == "-":
            return None, True, stdin_redirect
        if re.match(r"^-[cm]", t):  # code string / module: judged elsewhere
            return None, False, stdin_redirect
        cl = _python_cluster(t)
        if cl and cl[0] in ("c", "m"):
            return None, False, stdin_redirect
        if cl and cl[0] and not cl[1]:  # -X / -W at the end of a cluster: the next token is its value
            i += 2
            continue
        if t in _PY_OPT_WITH_ARG:
            i += 2
            continue
        if t.startswith("<"):
            stdin_redirect = True
            i += 2 if t == "<" else 1
            continue
        if re.match(r"^\d*>", t):
            i += 2 if re.match(r"^\d*>>?$", t) else 1
            continue
        if t.startswith("-") and len(t) > 1:
            i += 1
            continue
        return t, False, stdin_redirect
    return None, False, stdin_redirect


def flatten_substitutions(cmd: str) -> str:
    """Every unquoted command or process substitution as one undecidable word;
    see flattenSubstitutions in email-send-gate.mjs (the JS twin)."""
    out = []
    q = None
    i = 0
    n = len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(ch + cmd[i + 1])
                i += 2
                continue
            if ch == q:
                q = None
            out.append(ch)
            i += 1
            continue
        if ch in ("'", '"'):
            q = ch
            out.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(ch + cmd[i + 1])
            i += 2
            continue
        opens = ch in ("$", "<", ">") and i + 1 < n and cmd[i + 1] == "("
        if opens or ch == "`":
            depth = 1
            j = i + (2 if opens else 1)
            iq = None
            while j < n and depth > 0:
                c = cmd[j]
                j += 1
                if iq:
                    if c == iq:
                        iq = None
                    continue
                if c in ("'", '"'):
                    iq = c
                    continue
                if ch == "`":
                    if c == "`":
                        depth = 0
                    continue
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
            out.append(" $__SUBST__ ")
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# A script operand under /dev/ or /proc/ (`/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/3`, `/proc/<pid>/fd/0`,
# `/dev/./stdin`, `//dev/stdin`) is a stream or a process file, not a script on disk: the program is whatever
# it carries, as undecidable here as a glob or `$` (W-1). A general rule on the leading directory (extra
# slashes and `./` segments before it are skipped), not a list of stream names. NOT covered: a `..` that walks
# into /dev or /proc from another directory (`/tmp/../dev/stdin`). Mirrored in email-send-gate.mjs.
_DEVPROC_SCRIPT = re.compile(r"/+(?:\./+)*(?:dev|proc)/")


def _python_runs_runpy(rest) -> bool:
    """`-m runpy` (also `-mrunpy`, `-um runpy`) runs whatever the next argument names: undecidable (W-2)."""
    for i, t in enumerate(rest):
        cl = _python_cluster(t)
        if cl and cl[0] == "m":
            mod = cl[1] or (rest[i + 1] if i + 1 < len(rest) else None)
            if mod == "runpy":
                return True
    return False


def _python_head_sends(rest) -> bool:
    recipient = any(_RECIPIENT_FLAG.match(t) for t in rest)
    script, stdin, stdin_redirect = _python_script_operand(rest)
    if script is not None and _SENDPY.match(_basename(script)):
        return recipient
    if script is not None and _UNDECIDABLE_PATH.search(script):
        return recipient  # MAILGATEVARARGS1020
    if script is not None and _DEVPROC_SCRIPT.match(script):
        return recipient
    if _python_runs_runpy(rest):
        return recipient
    if stdin or (script is None and stdin_redirect):
        return recipient
    return False


def _head_is_send(toks, depth: int) -> bool:
    if toks is None:  # the depth bound was hit on a wrapper: audit it
        return True
    if not toks:
        return False
    prog = _basename(toks[0])
    rest = toks[1:]
    if _SENDER_PROG.match(prog):
        return True
    # burkolo hejj: a -c string-argumentum maga is parancs -- rekurzio
    if _WRAPPER_SHELL.match(prog) and depth < 3:
        for i, t in enumerate(rest):
            if t == "-c" and i + 1 < len(rest):
                if is_send_invocation(rest[i + 1], _depth=depth + 1):
                    return True
    # interpreter kod-string: python -c / node -e / --eval, ami kuldest hiv
    if _PYTHON.match(prog) or _NODEISH.match(prog):
        for i, t in enumerate(rest):
            if t in ("-c", "-e", "--eval") and i + 1 < len(rest) and _code_string_sends(rest[i + 1]):
                return True
    if _PYTHON.match(prog):
        # `-uc "code"`, `-c"code"`: the code string behind a cluster of short options.
        for i, t in enumerate(rest):
            cl = _python_cluster(t)
            if cl and cl[0] == "c":
                code = cl[1] or (rest[i + 1] if i + 1 < len(rest) else "")
                if code and _code_string_sends(code):
                    return True
    # send.py futtatasa (kozvetlenul, vagy python/runner utan) --to cimzettel
    candidates = [prog] + (
        [_basename(rest[0])] if rest and (_PYTHON.match(prog) or _NODEISH.match(prog)) else []
    )
    # Issue #1853: `python3 -m send` (or -m pkg.send) is the same sender run by module
    # name; it gets the same --to rule as the file-name form.
    if _PYTHON.match(prog):
        for i, t in enumerate(rest):
            if t == "-m" and i + 1 < len(rest) and rest[i + 1].rsplit(".", 1)[-1] == "send":
                candidates.append("send.py")
        # `-msend`, `-um send`: the module behind a cluster of short options.
        for i, t in enumerate(rest):
            cl = _python_cluster(t)
            if cl and cl[0] == "m":
                mod = cl[1] or (rest[i + 1] if i + 1 < len(rest) else "")
                if mod and mod.rsplit(".", 1)[-1] == "send":
                    candidates.append("send.py")
    if any(_SENDPY.match(c) for c in candidates) and any(_RECIPIENT_FLAG.match(t) for t in rest):
        return True
    if _PYTHON.match(prog) and _python_head_sends(rest):
        return True
    # an interpreter or program that cannot be resolved statically ($PY, a glob,
    # a substitution) with a recipient flag: what runs is undecidable here
    if _UNDECIDABLE_PATH.search(toks[0]) and any(_RECIPIENT_FLAG.match(t) for t in rest):
        return True
    # graph-mail kimeno alparanccsal (tsx/node runner utan is)
    if any(_GRAPHMAIL.match(_basename(t)) for t in toks) and "send" in rest:
        return True
    # curl/wget: a cel-token akkor is muvelet, ha idezojelben allt -- a
    # horgonyzott minta valasztja el a payload-belseji emlitestol.
    # RESENDGATE826: csak a TENYLEGES kuldes (POST/PUT/... vagy torzs) akad
    # fenn; a read-only GET/HEAD lekerdezes atmegy; a nem-donthato metodus
    # tovabbra is fail-closed.
    if _CURLISH.match(prog) and any(_RESEND_TARGET.match(_url_arg(t)) for t in rest):
        return _curl_resend_verdict(prog, rest) != "read"
    return False


def wrapper_depth_hit(cmd: str) -> bool:
    """True when some segment is still a wrapper at the depth bound, so it was
    counted as a send without the real command being seen (HEADDEPTH924). The
    gate uses it to say WHY it blocks: "I could not audit the letter" is the
    wrong reason for `nohup x9 git status` (Marveen, #1522 review)."""
    # Only when the depth bound is the WHOLE reason: if a visible segment is a
    # send on its own (`sendmail x; sudo x9 true`), that send is the reason,
    # and the ordinary wording must stay (Samu, #1523 review).
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False
    heads = [h for toks in segments for h in _command_heads(toks)]
    return any(h is None for h in heads) and not any(
        h is not None and _head_is_send(h, 0) for h in heads)


# Issue #1853, the heredoc form: the segmenter drops every heredoc BODY (it is data
# to the shell), but when the command that opens it is an interpreter
# (`python3 - <<'PY'`, `node <<EOF`) the body IS the program, and a send in it went
# unseen. The opening line is read up to its `<<`; when its last command word there
# is python/node-ish, the body is judged with the -c / -e code rule. A heuristic
# of the same naive class as the -c rule (see the boundary note above).
# NARROWED (Geri's #1855 review, a 14-day replay: 1 real catch, 17 false): inside a heredoc
# body the program is mostly PROSE that a script writes (an hourly report whose text held a
# card id with SENDMAIL in it, next to `subprocess`). So the exec + sender-literal half of the
# code rule takes the literal here only as a lowercase, QUOTED command word: a string that
# starts with sendmail/msmtp/swaks or ends a path in send.py, as an argv item or an os.system
# command is written. The real catch (`['python3', '.../send.py', '--to', ...]`) keeps it.
# Development heredocs that patch or test the gates, and mention `import send` in a string,
# still hit the module rule: that is the price of a naive rule, accepted.
# NOT COVERED, named so nobody counts them as covered: a program the classifier never reads --
# `python3 /tmp/x.py`, `python3 < /tmp/x.py`, `cat /tmp/x.py | python3 -`, and
# `python3 -c "exec(open('/tmp/x.py').read())"`; also a here-string fed to an interpreter
# (`python3 <<<'import send'`) and a CommonJS destructuring rename of the Graph sender
# (`const { sendMail: s } = require(...)`).
# A heredoc fed to a SHELL (`bash <<EOF`, `sh -s <<EOF`) is a shell program: its body is
# judged with this classifier itself, one level deeper (Geri/Samu, #1855).
# WRITTEN, THEN RUN IN THE SAME COMMAND (Samu/Geri, #1855: two of the three real gate-passing
# sends in the sample had this shape): `cat > $S/x.py <<'EOF' ... EOF; python3 $S/x.py`. When a
# heredoc writes a file (`cat > P <<TAG` or `cat <<TAG > P`) and the same command runs an
# interpreter or a shell on the same path token P, the body is judged as if it had been fed to
# that program directly. The match is by the exact token: `./x.py` and `x.py` are different. A
# file written by one Bash call and run by ANOTHER stays out of reach (named above).
# PIPED (Samu/Geri, #1855): `cat <<'EOF' | bash` or `| python3 -` hands the body to the
# program through the pipe on the heredoc's opening line, and it is judged the same way.
_HEREDOC_SENDER_ARGV = re.compile(r"""['"](?:[^'"\s]*/)?(?:sendmail|msmtp|swaks|send\.py)(?=['"\s])""")


def _heredoc_body_sends(body: str) -> bool:
    if _CODE_SEND.search(body) or _CODE_SEND_MODULE.search(body):
        return True
    return bool(_CODE_EXECISH.search(body) and _HEREDOC_SENDER_ARGV.search(body))


_HEREDOC_SHELL = re.compile(r"(?:^|[\s;&|(])(?:\S*/)?(?:bash|sh|zsh|dash)\b[^\n<]*$", re.I)
_HEREDOC_INTERP = re.compile(
    r"(?:^|[\s;&|(])(?:\S*/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun)\b[^\n<]*$", re.I
)


_HEREDOC_PIPE = re.compile(r"\|\s*(?:\S*/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun|bash|sh|zsh|dash)\b", re.I)
# `cat`/`tee` early on a line, then (anywhere later on the same line) a redirect or `tee`, then the target
# file. This used to be ONE pattern with a lazy `[^\n]*?` in the middle, which searched the rest of the line
# again from every `cat`/`tee` and was superlinear (a line of ` cat` x N: 40 kB 4.6 s). The head and the tail
# are separate patterns now and the tail is tried at each candidate position of the line at most once.
_HR_HEAD = re.compile(r"(?:^|[\s;&|(])(?:cat|tee)\b")
_HR_TAIL = re.compile(r"(?:>>?|\btee(?:\s+-a)?)\s*(['\"]?)([^\s'\"<>;&|]+)\1")
_HR_CAND = re.compile(r">|\btee")  # the only places _HR_TAIL can start


def _heredoc_redirect_target(text: str):
    """The file name a `cat`/`tee ... > FILE` at the start of a heredoc's line writes, or None.
    Gives what `search(...).group(2)` of the old single pattern gave."""
    tested_to = 0  # candidate positions before this index are known not to start a tail match
    nl = -1  # end of the current line; looked up again only after it is passed
    for head in _HR_HEAD.finditer(text):
        end = head.end()
        if nl < end:
            nl = text.find("\n", end)
            if nl == -1:
                nl = len(text)
        pos = max(tested_to, end)
        while True:
            cand = _HR_CAND.search(text, pos, nl)
            if cand is None:
                tested_to = max(tested_to, nl)
                break
            tail = _HR_TAIL.match(text, cand.start())
            if tail:
                return tail.group(2)
            pos = cand.start() + 1
    return None


def _written_then_run(cmd: str, written: dict, depth: int) -> bool:
    """A heredoc body written to a file that the same command then runs (see the note above)."""
    if not written:
        return False
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False
    for toks in segments:
        for head in _command_heads(toks):
            if not head:
                continue
            prog = _basename(head[0])
            args = [t for t in head[1:] if not t.startswith("-")]
            if prog.lower() == "npx" and args:
                args = args[1:]  # npx <runner> <file>
            if not args or args[0] not in written:
                continue
            body = written[args[0]]
            if (_PYTHON.match(prog) or _NODEISH.match(prog)) and _heredoc_body_sends(body):
                return True
            if _WRAPPER_SHELL.match(prog) and depth < 3 and is_send_invocation(body, _depth=depth + 1):
                return True
    return False


def _heredoc_program_sends(cmd: str, depth: int = 0) -> bool:
    written = {}
    for (start, intro_end, body_start, body_end, _end) in _scan_heredocs(cmd):
        line_start = cmd.rfind("\n", 0, start) + 1
        intro = cmd[start:intro_end]
        body = cmd[body_start:body_end]
        target = _heredoc_redirect_target(cmd[line_start:start] + intro)
        if target:
            written[target] = body
        piped = _HEREDOC_PIPE.search(intro)
        if piped:
            if _WRAPPER_SHELL.match(piped.group(1)):
                if depth < 3 and is_send_invocation(body, _depth=depth + 1):
                    return True
            elif _heredoc_body_sends(body):
                return True
        head = cmd[line_start:start]
        if _HEREDOC_INTERP.search(head):
            if _heredoc_body_sends(body):
                return True
        elif _HEREDOC_SHELL.search(head) and depth < 3:
            if is_send_invocation(body, _depth=depth + 1):
                return True
    return _written_then_run(cmd, written, depth)


def is_send_invocation(cmd: str, _depth: int = 0) -> bool:
    if _heredoc_program_sends(cmd, _depth):
        return True
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        # Parse-hiba (pl. lezaratlan idezojel): nem tudunk poziciot mondani.
        # Konzervativ visszaeses: csak akkor auditalunk, ha eros kuldes-literal
        # all a szovegben -- igy egy fura, de valodi kuldes nem csuszik at
        # neman, a tipikus belso parancsok viszont nem kapnak hamis pozitivot.
        return bool(_FALLBACK_LITERALS.search(cmd))
    if any(_segment_is_send(toks, _depth) for toks in segments):
        return True
    # the same command with every substitution as one undecidable word
    # (flatten_substitutions): the outer command keeps the word it would run
    flat = flatten_substitutions(cmd)
    if flat == cmd:
        return False
    try:
        return any(_segment_is_send(toks, _depth) for toks in _segments_tokens(flat))
    except ValueError:
        return bool(_FALLBACK_LITERALS.search(cmd))

# --- Hungarian detection (accent-insensitive markers) -----------------------
# These fire on both the correct and the stripped spelling, so a transliterated
# mail is still recognised as Hungarian -- that is the whole point.
HU_MARKERS = [
    "hogy", "nem", "vagy", "amit", "ami", "mert", "ezt", "ez a", "van", "lesz",
    "kell", "tehat", "tehát", "koszonom", "köszönöm", "szia", "sziasztok",
    "kerlek", "kérlek", "csatolva", "udvozlettel", "üdvözlettel", "levelet",
    "level", "kuldom", "küldöm", "jelezz", "irj", "írj", "mar", "már", "csak",
]

# Accentless spellings of frequent Hungarian words -> the correct form. Every
# entry is a word that CANNOT be spelled without its accent, so a hit inside
# Hungarian text is an error, not a style choice.
ACCENTLESS = {
    "es": "és", "tehat": "tehát", "koszonom": "köszönöm", "koszi": "köszi",
    "koszonjuk": "köszönjük", "kerlek": "kérlek", "kerem": "kérem",
    "kerjuk": "kérjük", "kerdes": "kérdés", "kerdesem": "kérdésem",
    "valasz": "válasz", "valaszt": "választ", "valaszol": "válaszol",
    # "levelet" NEM tartozik ide (2026-08-11, hamis pozitiv eles levelen):
    # a szotar invarianca az, hogy minden bejegyzes olyan szo, amit ekezet
    # NELKUL nem lehet leirni. A "levelet" (levél -> levelet) pont ilyen helyes
    # alak, ezert onmagara mutato bejegyzeskent allt itt, es minden korrekt
    # magyar levelet megblokkolt "levelet -> levelet" javaslattal. A "levelét"
    # (birtokos) ekezetlen alakja EGYBEESIK vele, tehat szabalykent nem is
    # eldontheto -- ezt a kapu nem tudja megfogni, es nem is szabad neki.
    "level": "levél", "levelre": "levélre",
    "elore": "előre", "elott": "előtt", "utan": "után", "kozott": "között",
    "kesz": "kész", "keszult": "készült", "keszen": "készen",
    "ervenyes": "érvényes", "ervenytelen": "érvénytelen",
    "telepito": "telepítő", "telepites": "telepítés", "telepiteni": "telepíteni",
    "ujra": "újra", "uj": "új", "ujat": "újat", "igy": "így", "ugy": "úgy",
    "tobb": "több", "tobbi": "többi", "kulon": "külön", "kuldom": "küldöm",
    "kuldtem": "küldtem", "kuldes": "küldés", "kuldunk": "küldünk",
    "fajl": "fájl", "fajlt": "fájlt", "fajlok": "fájlok",
    "hatarido": "határidő", "hataridot": "határidőt",
    "lehetoseg": "lehetőség", "lehetoseget": "lehetőséget",
    "szukseges": "szükséges", "szuksege": "szüksége",
    "mukodik": "működik", "mukodes": "működés", "muszaki": "műszaki",
    "beallitas": "beállítás", "beallitani": "beállítani",
    "elofizetes": "előfizetés", "elofizetest": "előfizetést",
    "szamla": "számla", "szamlat": "számlát", "szamlazas": "számlázás",
    "arajanlat": "árajánlat", "ar": "ár", "arak": "árak",
    "ora": "óra", "orakor": "órakor", "ev": "év", "evi": "évi",
    "honap": "hónap", "het": "hét", "hetfo": "hétfő", "csutortok": "csütörtök",
    "pentek": "péntek", "januar": "január", "februar": "február",
    "marcius": "március", "aprilis": "április", "majus": "május",
    "junius": "június", "julius": "július", "oktober": "október",
    "ket": "két", "harom": "három", "negy": "négy", "ot": "öt",
    "szivesen": "szívesen", "erteket": "értéket", "ertem": "értem",
    "jol": "jól", "rovid": "rövid", "hosszu": "hosszú", "biztonsagos": "biztonságos",
    # "megnyitni" ugyanaz a hibaosztaly, mint a fenti "levelet": onmagara mutato
    # bejegyzes egy olyan szonal, ami ekezet nelkul is helyes. Kiveve 2026-08-11,
    # MIELOTT eles levelen elsult volna.
    "eleresi": "elérési", "elerheto": "elérhető",
    "sajat": "saját", "tovabbi": "további", "tovabb": "tovább",
    "figyelmeztetes": "figyelmeztetés", "ellenorizd": "ellenőrizd",
    "ellenorzes": "ellenőrzés", "reszletek": "részletek", "resz": "rész",
    "vegen": "végén", "vegre": "végre", "elinditja": "elindítja",
    "inditas": "indítás", "masold": "másold", "masolat": "másolat",
    "gepre": "gépre", "gep": "gép", "gepen": "gépen",
    "ervenyesites": "érvényesítés", "aktivalas": "aktiválás",
    "hozzajarulas": "hozzájárulás", "elofordul": "előfordul",
    # +48 bejegyzes 2026-08-13 (EKEZETLISTA812, Szabi GO: "Vedd"). A jeloltek a
    # sajat magyar szovegeinkbol jottek (69 fajl, 60 gyakori ekezetes szo, amit a
    # lista addig nem fogott); a szures KET lepcsos volt: lokalis modell (Muse
    # Glimmer 30B) itelete + sajat felulvizsgalat. SZANDEKOSAN KIMARADT, mert az
    # ekezetlen alak onmagaban is letezo magyar szo: mar (marni), meg (igekoto),
    # kor (eletkor/korszak), fonok (fonni), var (a seb varja), kod (kod ES kod),
    # hozza, meres, lepes, szamlazz, jon, tovabbra. Az "all" -> "áll" TUDATOS
    # kivetel: nem magyar szo, de gyakori ANGOL szo; a kapu csak magyarnak mert
    # szovegen fut, ezert Szabi vallalta a kockazatot.
    "elso": "első", "ezert": "ezért", "valodi": "valódi",
    "nelkul": "nélkül", "miert": "miért", "utana": "utána",
    "kovetkezo": "következő", "szekcio": "szekció", "tenyleg": "tényleg",
    "videot": "videót", "video": "videó", "azert": "azért",
    "hivas": "hívás", "szam": "szám", "szoveg": "szöveg",
    "mas": "más", "kulso": "külső", "dontes": "döntés",
    "letezik": "létezik", "kozvetlenul": "közvetlenül", "felhasznalo": "felhasználó",
    "nema": "néma", "verzio": "verzió", "erdemes": "érdemes",
    "irja": "írja", "mostantol": "mostantól", "latszik": "látszik",
    "szoval": "szóval", "kozos": "közös", "netto": "nettó",
    "cim": "cím", "futo": "futó", "javitas": "javítás",
    "kockazat": "kockázat", "ebbol": "ebből", "mindket": "mindkét",
    "eleg": "elég", "regi": "régi", "kulonbozo": "különböző",
    "kezzel": "kézzel", "peldaul": "például", "izolalt": "izolált",
    "kozben": "közben", "udvozlettel": "üdvözlettel", "oket": "őket",
    "afa": "áfa", "allapot": "állapot", "all": "áll",
}

# GATEHOMOGLIF816 (2026-08-16, Marveen merese): 33 cirill homoglifa ult a
# memoria-sorokban es kartya-cimekben -- olvasva lathatatlan, de a grep/FTS
# nema nulla-talalatot ad, ami hianyzo emleknek latszik, nem serult adatnak.
# A szabaly a VEGYES SZORA vonatkozik (egy szon belul latin ES nem-latin betu),
# nem a cirill puszta jelenletere -- egy szandekosan idegen nyelvu idezet
# tiszta nem-latin szavai atmennek. Unicode-tudatos tokenizalas kell: a WORD
# regex latin-only, egy homoglifas szot darabokra vagna.
# THE RULE ITSELF LIVES IN scripts/lib/mixed_script.py, and is imported, not
# copied. Measured 2026-09-24: the inter-agent send gate had re-implemented it
# as "any Cyrillic or Greek letter" and refused a plain Russian quote and a
# standalone Greek symbol, both of which THIS path passes. Two gates disagreeing
# about what is legitimate teach the sender that the rule depends on which
# script they called. One source, so they cannot drift.
#
# The unit/formula exception (SCRIPT_NEUTRAL: the micro sign, superscripts and
# subscripts, so "40 µs", "100 m²" and "H₂O" are not mixed-script words) lives
# in the shared module too, so both paths get it. It is imported here as well,
# so an importer of this module keeps seeing the name.
#
# GUARDED IMPORT, FAIL-CLOSED. A bare ImportError fires during MODULE LOAD,
# escapes the __main__ net and exits 1 -- and PreToolUse reads 1 as
# NON-blocking, so the send would run UNCHECKED. That is the one outcome a gate
# must never have. The stub does NOT invent a fallback rule: a gate that cannot
# load its rule has no verdict, and "no verdict" means BLOCK. The call sites
# turn MixedScriptUnavailable into a refusal that says the rule could not be
# loaded, instead of a homoglyph finding that was never measured.
class MixedScriptUnavailable(RuntimeError):
    """The shared mixed-script rule could not be imported."""


try:
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
    from mixed_script import (  # noqa: E402
        UWORD, SCRIPT_NEUTRAL, char_script, mixed_script_words,
    )
except Exception as _mixed_exc:  # noqa: BLE001 -- deliberate fail-closed stub
    _MIXED_ERR = repr(_mixed_exc)
    UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)
    SCRIPT_NEUTRAL = frozenset()

    def char_script(ch: str) -> str:
        return "UNKNOWN"

    def mixed_script_words(text: str):
        raise MixedScriptUnavailable(_MIXED_ERR)

_char_script = char_script   # the name this file used before the extraction


EM_DASH = "—"

# GATEPERSIST816: owner-specific NAME rules load from an UNTRACKED local file,
# not from this (public-repo) script. The generic checks (accents, em dash,
# double hyphen, mixed-script) are universal Hungarian-copy QA and ship in the
# repo; a personal-name rule names a private third party, and that must not be
# published as a side effect of persisting the gate. A missing rules file is
# NOT silent: every run appends a loud line to the gate log, because a
# protection whose absence is invisible only protects until someone touches
# the tree. File shape: {"bad_name_patterns": ["<python-regex>", ...]}
_LOCAL_RULES = os.environ.get(
    "OUTGOING_COPY_GATE_RULES",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                 "store", "outgoing-copy-gate-rules.json"),
)

_GATE_LOG = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")


def _gate_log(message: str) -> None:
    """Append one TIMESTAMPED line to the gate log (local time with offset).

    A log whose entries cannot be placed in time cannot be used to check
    anything, so every line carries a stamp. Used by the inter-agent branch for
    its loud pass-throughs."""
    try:
        from datetime import datetime
        stamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(_GATE_LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {message.rstrip()}\n")
    except OSError:
        pass


def load_bad_name():
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            pats = json.load(fh).get("bad_name_patterns") or []
        if pats:
            return re.compile("|".join(pats))
    except OSError:
        pass
    except Exception:
        pass
    try:
        log_path = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"outgoing-copy-gate: NEV-SZABALY FAJL HIANYZIK/URES ({_LOCAL_RULES}) -- "
                     "a nev-ellenorzes NEM fut; potold a store/outgoing-copy-gate-rules.json-t.\n")
    except OSError:
        pass
    return None


def _name_correction() -> str:
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            corr = json.load(fh).get("correction") or ""
        return (" " + corr) if corr else ""
    except Exception:
        return ""


BAD_NAME = load_bad_name()
ACCENTED = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")


def _strip_tags(text: str) -> str:
    """Replace every `<...>` tag (one or more characters between '<' and the first '>') with a
    space, in one linear pass. The output is what the old regex substitution gave.

    The regex looked for a '>' from every '<' that had none after it, so a body full of '<' and
    no '>' was quadratic (550 kB: ~40 s). A hook still running at its timeout is not a deny, so
    a slow audit is a fail-open. Here the '>' is found with one forward search that every later
    '<' reuses. A '<' directly followed by '>' is not a tag (the regex needs one character
    between), exactly as before.
    """
    out = []
    copied = 0  # text[:copied] is already in `out`
    scan = 0  # next position to look for a '<'
    gt = -2  # first '>' at or after the last probe; -1 = none left, -2 = not probed yet
    while True:
        lt = text.find("<", scan)
        if lt == -1:
            break
        if gt != -1 and gt <= lt:
            gt = text.find(">", lt + 1)
        if gt == -1:
            break  # no '>' left, so no later '<' can close either
        if gt == lt + 1:
            scan = lt + 1  # "<>": no body, not a tag
            continue
        out.append(text[copied:lt])
        out.append(" ")
        copied = scan = gt + 1
    out.append(text[copied:])
    return "".join(out)


# GATEKOTOJEL817 + GATEHYPH816 (2026-08-19 este, ket hamis pozitiv elo
# gazda-beszelgetesben, ot perc alatt): a kapu nem tett kulonbseget PROZA es
# AZONOSITO kozott. (1) `Drive-ot` -- az idegen tulajdonnevhez a magyar
# toldalek kotojellel kapcsolodik (ez a HELYES iras), de a betu-only WORD
# tokenizalo a kotojelnel vagott, es a maradek `ot` darabot onallo magyar
# szonak nezte (ot -> öt). (2) `Video atalakitas` -- egy Drive-mappa NEVE a
# szovegben: mondatkozi nagybetus szo, azonosito, nem proza. A javitas a
# TOKENIZALAS, nem a szotar (szo-kivetel a valodi hibakat is atengedne):
#   - kotojeles alaknal a TELJES szoalak vizsgalando (a `drive-ot` egeszkent
#     nincs a szotarban -> atmegy; az onallo `ot` prozaban tovabbra is bukik);
#   - a MONDATKOZI nagybetus szo azonosito/tulajdonnev -> kimarad; mondat
#     elejen (. ! ? : ujsor vagy lista-jel utan) a nagybetu normal proza,
#     ott tovabbra is vizsgaljuk.
HYPHEN_WORD = re.compile(r"[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+(?:-[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+)*")


def _at_sentence_start(text: str, idx: int) -> bool:
    i = idx - 1
    while i >= 0 and text[i] in " \t\"'([{":
        i -= 1
    if i < 0:
        return True
    ch = text[i]
    if ch in ".!?:\n":
        return True
    if ch in "-*•":
        j = i - 1
        while j >= 0 and text[j] in " \t":
            j -= 1
        return j < 0 or text[j] == "\n"
    return False


# Case endings and suffixes that follow a number after a hyphen in Hungarian prose (2027-es, 3-as, 5-os, 10-ig,
# 1-re, 8-szor ...). Every one of them is a correct accentless spelling.
NUMBER_ENDINGS = frozenset((
    "es", "as", "os", "ik", "ig", "ra", "re", "ban", "ben", "nak", "nek", "tol", "tel", "val", "vel", "en", "on", "an",
    "hoz", "hez", "bol", "rol", "szor", "szer", "szeres", "edik", "adik", "odik", "i", "ei", "ai",
))


def accent_check_tokens(prose: str):
    """(lowercase alak, kezdo-pozicio) parok az ekezet-vizsgalathoz."""
    out = []
    for m in HYPHEN_WORD.finditer(prose):
        tok = m.group(0)
        # A case ending hung on a number ("2027-es", "10-es", "3-as", "5-os", "1-jen"): the word regex starts
        # the token after the hyphen, and a bare "es" would be read as the accentless "es" for the word "es"
        # (and). Only the endings that are spelled this way are let through; "5-ot" (5-ot should be 5-ot with
        # an umlaut) and any other word after "7-" are still judged.
        if tok.lower() in NUMBER_ENDINGS and m.start() >= 2 and prose[m.start() - 1] == "-" and prose[m.start() - 2].isdigit():
            continue
        if "-" not in tok and tok[0].isupper() and not _at_sentence_start(prose, m.start()):
            continue
        out.append((tok.lower(), m.start()))
    return out


def _hit_context(prose: str, pos: int, length: int) -> str:
    """A talalat elotti/utani 3-3 szo + karakter-pozicio (GATEHYPH816 (B):
    elo beszelgetes kozben ne kelljen greppelni, melyik szorol van szo)."""
    before = prose[:pos].split()[-3:]
    token = prose[pos:pos + length]
    after = prose[pos + length:].split()[:3]
    frag = " ".join(before + [token] + after)
    return f'"...{frag}..." @{pos}'


# Technikai tokenek maszkolasa AZ EKEZET-ELLENORZES ELOTT. Merve 2026-08-13, a
# +48-as bovites negativ kontrolljan: egy HIBATLANUL ekezetezett eles level
# fennakadt a `video_view` esemenynevben levo "video"-n. A szobonto az aláhúzást
# hataroljelnek veszi, tehat minden snake_case azonosito, fajlnev, URL-slug es
# domain beszallit egy "magyar szot", ami ott ekezet nelkul HELYES. Ugyanaz az
# osztaly, mint a 2026-08-11-i `level` fajlnev-talalat. A javitas nem a szotarbol
# vesz ki (az elrontana a valodi talalatokat is), hanem a technikai regiokat
# vagja ki a vizsgalt szovegbol. A gondolatjel- es nev-ellenorzes NEM ezen fut.
#
# Linear in the text length. Two alternatives re-scanned a long run again from EVERY start inside
# it: the email (`[\w.+-]+@`, a run with no '@' after it) and the path (`[\w-]*/`, a hyphenated run
# with no '/' after it). One 550 kB word kept this pattern busy for over 90 s (20 kB: 2.3 s), and
# a mail the audit cannot finish on would hang the gate (the live 8 s alarm turns that into a deny). A start inside a run cannot succeed when the
# first start of that run failed (same run end, same next character), so only the first start of a
# run is tried: the email needs a start that is not preceded by a run character, the path one that
# is not preceded by a run character or is the first word start after up to three leading hyphens.
TECHNICAL = re.compile(
    r"""https?://\S+                                    # URL
      | (?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.]+             # email
      | `[^`]*`                                         # kod-span
      | \b\w+(?:_\w+)+\b                                # snake_case azonosito
      | \b\w+\.[A-Za-z]{2,10}\b                         # fajlnev / domain (video.mp4, marveen.io)
      | (?:(?<![\w-])|(?<=(?<![\w-])-)|(?<=(?<![\w-])--)|(?<=(?<![\w-])---))
        \b[\w-]*/[\w/-]+                                # utvonal / slug
      | \b/[\w/-]+                                      # ... that starts at the '/' after a word
    """,
    re.X,
)
# The pre-fix pattern, kept for the differential test only.
_TECHNICAL_OLD = re.compile(
    r"""https?://\S+ | [\w.+-]+@[\w-]+\.[\w.]+ | `[^`]*` | \b\w+(?:_\w+)+\b | \b\w+\.[A-Za-z]{2,10}\b | \b[\w-]*/[\w/-]+""",
    re.X,
)


def strip_technical(text: str) -> str:
    return TECHNICAL.sub(" ", text)


def is_hungarian(text: str) -> bool:
    low = text.lower()
    return sum(1 for m in HU_MARKERS if m in low) >= 3


# GATETG816 (2026-08-16, Marveen merese): az is_hungarian() funkcionalis szavakra
# szur, ezert a TOMOR, tenykozol, felsorolasos magyar uzenet (pont a fo agens
# Telegram-stilusa) nem eri el a 3 markert, es az ekezet-vizsgalat el sem indul --
# a mai napindito elso bekezdese ekezetlenul atment. A nyelv-detektor ezert nem
# EGYEDULI kapu tobbe: egyetlen olyan szotar-talalat, ami magyarul ekezet nelkul
# NEM letezik ES angol/technikai szokent sem ertelmezheto, onmagaban eleg ok a
# vizsgalatra. Az alabbi kizaras CSAK a triggerre vonatkozik: ha a szoveg mas
# uton magyarnak bizonyult, ezek a talalatok is jelentesre kerulnek -- de egyedul
# nem ranthatnak be egy angol szoveget az auditba ("the all-new level editor").
AMBIGUOUS_TRIGGER = {
    "es", "ar", "arak", "ev", "evi", "ot", "uj", "ujat", "het", "ora", "mas",
    "all", "level", "video", "netto",
}


def accentless_evidence(words):
    return {w for w in words if w in ACCENTLESS and w not in AMBIGUOUS_TRIGGER}


def collect_bash_body(cmd: str):
    """Return (text, unreadable_reason). text is '' when nothing was recovered."""
    parts = []
    for m in re.finditer(r"--(?:body|subject)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(2) or m.group(3) or m.group(4) or ""
        # A shell-expanded --body ($(cat f), `cat f`, $VAR) reaches this hook
        # UNEXPANDED: what we would audit is the literal command text, not the
        # letter. That is worse than useless -- it fires on words that happen to
        # sit in the PATH while the real copy goes uninspected. Measured
        # 2026-08-11 on a live customer letter: `--body "$(cat .../hidli_zaro_
        # level.txt)"` blocked on "level" from the FILENAME, and the letter
        # itself was never read. Same fail-closed rule as the `<` branch below.
        if re.search(r"\$\(|`|\$\{?\w", val):
            return ("\n".join(parts),
                    "a --body shell-behelyettesitest tartalmaz, amit a hook nem old fel "
                    f"({val[:60]}...) -- igy a parancs szoveget vizsgalnam, nem a levelet")
        parts.append(val)
    # heredoc payloads sit inline in the command string
    for m in re.finditer(r"<<-?\s*'?(\w+)'?\n(.*?)\n\1", cmd, re.S):
        parts.append(m.group(2))
    # A single `<` only. Without the lookarounds a heredoc (`<<'EOF'`) matches
    # here and the quoted delimiter is taken for a filename -- caught by the
    # first live probe of this gate, which blocked with "'EOF': No such file".
    redirect = re.search(r"(?<!<)<(?!<)\s*([^\s|;&<>]+)", cmd)
    if redirect:
        raw = redirect.group(1)
        path = os.path.expandvars(os.path.expanduser(raw))
        if "$" in path:
            return ("\n".join(parts), f"a torzs egy fel nem oldhato utvonalrol jon ({raw})")
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                parts.append(fh.read())
        except OSError as exc:
            return ("\n".join(parts), f"a torzs-fajl nem olvashato ({path}: {exc})")
    if not parts and re.search(r"\|\s*(python3?|node|tsx)?[^|]*send", cmd):
        return ("", "a torzs egy pipe-bol jon, a hook nem latja")
    return ("\n".join(parts), None)


def collect_mcp_body(tool_input: dict):
    fields = ("body", "text", "html", "htmlBody", "message", "subject", "content")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return "\n".join(got)


# --- Telegram reply (GATETG816) ---------------------------------------------
# The reply tool sends MarkdownV2, where every special char arrives escaped
# (\. \( \) \-). Those backslashes sit inside the prose the audit reads, and
# they can split technical tokens or glue fragments in ways the email path
# never sees. Un-escape (backslash before a non-word char) BEFORE auditing --
# this is analysis-only, the outgoing payload is untouched.
MDV2_ESCAPE = re.compile(r"\\([^\w\s])")


def collect_telegram_body(tool_input: dict) -> str:
    fields = ("text", "caption", "message")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return MDV2_ESCAPE.sub(r"\1", "\n".join(got))


def telegram_gate(tool_input: dict) -> None:
    """Audit a Telegram reply. FAIL-OPEN on any internal error (exit 0 + loud
    log): email is deferrable, but Telegram is the owner's ONLY supervision
    channel -- a gate crash that silences it costs more than a slipped accent.
    A FOUND problem still blocks (exit 2): that is the gate's whole point."""
    try:
        text = collect_telegram_body(tool_input)
        if not text.strip():
            sys.exit(0)  # files-only reply or empty text: nothing to audit
        problems = audit(text)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open path
        warn = f"outgoing-copy-gate: TELEGRAM-ag belso hiba, FAIL-OPEN atengedes: {exc!r}\n"
        sys.stderr.write(warn)
        try:
            log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__)))), "store", "outgoing-copy-gate.log")
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(warn)
        except OSError:
            pass
        sys.exit(0)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (Telegram): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra (a MarkdownV2 escape-eket a kapu "
              "az ellenorzes elott feloldja, azok nem szamitanak hibanak).\n"
        )
        sys.exit(2)
    # GATEPERSIST816(2): a hianyzo nev-szabaly a telegram-agon fail-open marad,
    # de a figyelmeztetes ODA megy, ahol a session tenyleg latja -- a hook
    # stdout systemMessage mezoje a futo sessionben jelenik meg, nem egy
    # logfajlban, amit senki nem olvas.
    if BAD_NAME is None:
        print(json.dumps({"systemMessage":
            "outgoing-copy-gate: a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}) -- a nev-ellenorzes NEM fut a kimeno uzeneteken. "
            "Potold a store/outgoing-copy-gate-rules.json-t."}))
    sys.exit(0)


def audit(text: str):
    """Return a list of human-readable problems."""
    plain = _strip_tags(text)
    problems = []
    if EM_DASH in plain:
        problems.append(
            f"GONDOLATJEL (em dash, U+2014) {plain.count(EM_DASH)} helyen -- allo szabaly, soha nem mehet ki."
        )
    bad = BAD_NAME.search(plain) if BAD_NAME else None
    if bad:
        problems.append(
            f"HELYTELEN NEV: {bad.group(0)!r} -- a lokal nev-szabaly (store/outgoing-copy-gate-rules.json) szerint helytelen alak; a helyes irast a szabaly-fajl correction mezoje adja." + _name_correction()
        )
    prose = strip_technical(plain)
    # DUPLA KOTOJEL gondolatjel-potlokent (Szabi 2. eszrevetele, 2026-08-16): a
    # " -- " prozaban ugyanugy zavaro, mint a tiltott em dash. A PROZAN merjuk
    # (strip_technical utan), igy a kodreszletek/parancsok --flag alakjai nem
    # erintettek -- azok amugy sem " -- " alakuak (nincs szokoz a kotojelek
    # utan), de a technikai regiok kivagasa a biztos hatar.
    dh = prose.count(" -- ")
    if dh:
        problems.append(
            f"DUPLA KOTOJEL gondolatjel-potlokent {dh} helyen (' -- ') -- Szabi jelzese: "
            "ugyanugy zavaro, mint az em dash. Ird at kotojel nelkul: kettospont, zarojel, vagy uj mondat."
        )
    # 4. ellenorzes (GATEHOMOGLIF816): vegyes irasrendszeru szo. SZANDEKOSAN
    # NEM magyar-kapuzott (elteres Marveen specjetol, ervvel): az FP-vedelem
    # maga a VEGYES-szo szabaly -- egy legitim idegen idezet szavai TISZTA
    # nem-latin betusek, sosem vegyesek. A magyar-kapu itt semmit nem vedene,
    # viszont lyukat utne: egy 2-markeres, hibatlanul ekezetes magyar szoveg
    # homoglifaja atcsuszna (merve: a 'kerlek+koszonom' paros keves a
    # nyelv-detektorhoz). A konkret szot ES karaktert nevezzuk meg, mert a
    # hiba szemre lathatatlan -- enelkul a javitas talalgatas lenne.
    try:
        mixed = mixed_script_words(prose)
    except MixedScriptUnavailable as exc:
        problems.append(
            "A VEGYES-IRASRENDSZER SZABALY NEM TOLTHETO BE "
            f"(scripts/lib/mixed_script.py: {exc}). Ez NEM homoglifa-talalat: a "
            "szabaly meg sem futott, tehat a szovegrol semmit nem tudunk. "
            "Szandekosan fail-closed."
        )
        mixed = []
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        problems.append(
            f"VEGYES IRASRENDSZERU SZO (homoglifa), {len(mixed)} db: {shown}{more}. "
            "Latin szoba keveredett nem-latin betu: olvasva lathatatlan, de a keresest/grepet neman eltori."
        )
    tok_pos = accent_check_tokens(prose)
    words = [w for w, _ in tok_pos]
    if is_hungarian(plain) or accentless_evidence(words):
        hits = sorted({w for w in words if w in ACCENTLESS})
        # Az aranyot is a prozan merjuk: a technikai tokenekben nincs ekezet, tehat
        # egy kodban gazdag, egyebkent helyes level aranyat lefele huznak.
        letters = sum(1 for ch in prose if ch.isalpha())
        acc = sum(1 for ch in prose if ch in ACCENTED)
        ratio = (acc / letters) if letters else 0.0
        if hits:
            first_pos = {}
            for w, p in tok_pos:
                if w in ACCENTLESS and w not in first_pos:
                    first_pos[w] = p
            shown = ", ".join(
                f"{h} -> {ACCENTLESS[h]} ({_hit_context(prose, first_pos[h], len(h))})"
                for h in hits[:12]
            )
            more = f" (+{len(hits) - 12} tovabbi)" if len(hits) > 12 else ""
            problems.append(f"HIANYZO EKEZETEK, {len(hits)} szo: {shown}{more}")
        elif letters > 200 and ratio < 0.01:
            problems.append(
                f"MAGYAR SZOVEG GYAKORLATILAG EKEZET NELKUL (ekezet-arany {ratio:.3%}, {letters} betun). "
                "A szolistam nem talalt konkret talalatot, de az arany onmagaban gepi atirasra utal -- olvasd vissza."
            )
    return problems


# --- Inter-agent messages: HOMOGLYPH-ONLY ------------------------------------
# `curl .../api/messages` is NOT an email send (send-invocation-cases.json pins
# it expected:false, and that stays), so none of the copy rules below ever ran
# on it: no accent audit, no name rule, no em dash -- correctly, because the
# fleet's internal traffic is written WITHOUT accents and the full audit would
# block most of it. One dimension is added here and nothing else: a MIXED-SCRIPT
# word (homoglyph). The fleet coordinates by card ids, agent names and file
# paths passed in messages; a Cyrillic 'a' in one of those does not look wrong,
# it silently points at something that does not exist. Measured 2026-09-16:
# four such characters in one agent's own messages, caught only by a manual
# scan.
#
# FAILURE DIRECTION IS DELIBERATELY SPLIT (upstream design, kept on purpose and
# flagged for review in the fork):
#   - homoglyph FOUND                  -> BLOCK (exit 2), naming word and char;
#   - rule cannot load / gate crashes  -> BLOCK (exit 2), fail-closed like the
#                                         rest of this hook;
#   - message BODY NOT INTERPRETABLE   -> PASS, with a loud named systemMessage
#     (unreadable @file, $-path,          and a gate-log line. THIS IS THE ONE
#     run-time substitution, non-JSON,    FAIL-OPEN OF THIS HOOK. On this channel
#     non-object JSON, @- without a       a false block mutes an agent (the
#     heredoc, unparseable command        fleet's coordination backbone); the
#     that mentions the queue)            threat is our own agent emitting a
#                                         lookalike by accident, not an
#                                         attacker, so fail-open-loud is the
#                                         right side HERE and only here.
# A command that is not a POST to the queue at all is not this gate's business
# and passes silently.
# All three shapes are covered, or the concept is not closed: quoted heredoc
# (`--data-binary @- <<'JSON'`), `@file`, and inline `-d '...'`.
_IA_TARGET = re.compile(r"^(https?://)?[^/\s]*/api/messages/?(\?\S*)?$", re.I)
_IA_DATA_FLAGS = ("-d", "--data", "--data-binary", "--data-raw", "--data-ascii", "--json")
_IA_SUBST = re.compile(r"\$\(|`|\$\{?\w")


def _ia_segment(cmd: str):
    """Tokens of the curl segment that POSTs to /api/messages, or None."""
    segments = _segments_tokens(cmd)  # ValueError is handled by the caller
    for toks in segments:
        while toks and _ENV_ASSIGN.match(toks[0]):
            toks = toks[1:]
        if toks and _CURLISH.match(_basename(toks[0])) and any(_IA_TARGET.match(t) for t in toks[1:]):
            return toks
    return None


# The fleet's everyday form is `S=/abs/scratch; ... --data-binary @$S/m.json`:
# the variable is assigned a LITERAL earlier in the SAME command string. That
# is deterministic, so it is resolved here instead of warned about. Measured
# 2026-09-23 over 1153 real inter-agent POSTs: without this, most of the
# warnings were exactly this shape, and a warning that fires on half the
# traffic is noise. Only a plain literal value counts (no quotes-with-$,
# no substitution); anything else stays unresolved and is warned about.
_IA_ASSIGN = re.compile(r"""(?:^|[;&|\n(]\s*|\s)(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s;&|$`'"()]+))""")


def _ia_resolve_local_vars(cmd: str, ref: str) -> str:
    local = {}
    for m in _IA_ASSIGN.finditer(cmd):
        local[m.group(1)] = next(g for g in m.groups()[1:] if g is not None)

    def sub(m):
        name = m.group(1) or m.group(2)
        return local.get(name, m.group(0))
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", sub, ref)


def _ia_payload(cmd: str, toks):
    """(text, unreadable_reason) of the message body, from the three shapes."""
    raw = None
    for i, t in enumerate(toks):
        val = None
        for f in _IA_DATA_FLAGS:
            if t == f and i + 1 < len(toks):
                val = toks[i + 1]
            elif t.startswith(f + "="):
                val = t[len(f) + 1:]
            elif f == "-d" and t.startswith("-d") and len(t) > 2 and not t.startswith("--"):
                val = t[2:]
            if val is not None:
                is_raw_flag = f == "--data-raw"
                break
        if val is None:
            continue
        if val.startswith("@") and not is_raw_flag:
            ref = val[1:]
            if ref == "-":
                m = re.search(r"<<-?\s*'?(\w+)'?[^\n]*\n(.*?)\n\1(?=\s|$)", cmd, re.S)
                if not m:
                    return None, "a torzs stdin-rol jon (@-), heredoc nelkul"
                if not re.search(r"<<-?\s*'", cmd) and _IA_SUBST.search(m.group(2)):
                    return None, "a heredoc NEM idezett, es shell-behelyettesitest tartalmaz"
                raw = m.group(2)
            else:
                path = os.path.expandvars(os.path.expanduser(_ia_resolve_local_vars(cmd, ref)))
                if "$" in path:
                    return None, f"a torzs fel nem oldhato @utvonalrol jon (@{ref})"
                try:
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        raw = fh.read()
                except OSError as exc:
                    return None, f"a torzs-fajl (@{ref}) nem olvashato ({exc.strerror or exc})"
        else:
            if _IA_SUBST.search(val):
                return None, "az inline torzs shell-behelyettesitest tartalmaz, futasidoben dol el"
            raw = val
        break
    if raw is None:
        # No data flag at all: a GET of the queue (the most frequent call on this
        # path) or a bare POST. Nothing is being SENT, so nothing to scan and
        # nothing to warn about -- a warning here would fire on every queue read.
        return "", None
    try:
        obj = json.loads(raw)
    except ValueError:
        return None, "a torzs nem ervenyes JSON"
    if not isinstance(obj, dict):
        return None, "a torzs JSON, de nem objektum"
    # EVERY string field: a lookalike in `to` misroutes as silently as one in
    # `content` misleads.
    strings = [str(v) for v in obj.values() if isinstance(v, str)]
    return "\n".join(strings), None


def _ia_loud_pass(unreadable: str) -> None:
    """The documented fail-open of this hook: the body could not be interpreted,
    so the message goes out WITHOUT the homoglyph check -- and says so, on the
    surface the session reads (systemMessage) and in the gate log."""
    msg = ("outgoing-copy-gate (inter-agent, homoglifa): a torzs NEM vizsgalhato -- "
           f"{unreadable}. Az uzenet ATMENT, homoglifa-ellenorzes NELKUL. "
           "Vizsgalhato alak: idezett heredoc (--data-binary @- <<'JSON') vagy @/abszolut/ut.json.")
    _gate_log(msg)
    print(json.dumps({"systemMessage": msg}))
    sys.exit(0)


def inter_agent_homoglyph_gate(cmd: str) -> None:
    """Exit 2 on a homoglyph, exit 0 otherwise (loudly when unreadable).
    Only called for a command that is NOT an email send."""
    try:
        toks = _ia_segment(cmd)
    except ValueError:
        # The command cannot be tokenised (e.g. an unterminated quote). If it
        # does not even mention the queue it is not an inter-agent message and
        # passes silently; if it does, its body is uninterpretable: loud pass.
        if re.search(r"/api/messages", cmd):
            _ia_loud_pass("a parancs nem tokenizalhato (pl. lezaratlan idezojel)")
        sys.exit(0)
    if toks is None:
        sys.exit(0)
    text, unreadable = _ia_payload(cmd, toks)
    if unreadable:
        _ia_loud_pass(unreadable)
    try:
        mixed = mixed_script_words(text)
    except MixedScriptUnavailable as exc:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (inter-agent): TILTVA -- a vegyes-irasrendszer szabaly "
            f"NEM TOLTHETO BE (scripts/lib/mixed_script.py: {exc}).\n"
            "Ez nem a szovegrol szol: a szabaly meg sem futott. Szandekosan fail-closed, "
            "mert egy le nem futott ellenorzes nem 'rendben'.\n"
        )
        sys.exit(2)
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (inter-agent): TILTVA -- VEGYES IRASRENDSZERU SZO (homoglifa), "
            f"{len(mixed)} db: {shown}{more}.\n"
            "Egy kartya-azonositoban, agens-nevben vagy utvonalban ez neman felreiranyit. "
            "Javitsd a szoveget es kuldd ujra. (Itt CSAK a homoglifa fut, ekezet- es copy-szabaly nem.)\n"
        )
        sys.exit(2)
    sys.exit(0)


def wrapper_depth_message() -> str:
    """The deny text for a command blocked ONLY by the wrapper-depth bound."""
    return (
        "KIMENO-SZOVEG KAPU: TILTVA, a parancs tul melyen beagyazott wrapperben fut "
        f"(tobb mint {_HEAD_DEPTH} egymasba agyazott burkolo: sudo, nohup, env, timeout...), "
        "a valodi parancs nem lathato, ezert tiltom.\n"
        f"Futtasd kevesebb wrapperrel ({_HEAD_DEPTH} vagy kevesebb), aztan kuldd ujra. "
        "Ez nem a level szovegerol szol.\n"
    )


def _depth_limit_is_sole_reason(cmd: str) -> bool:
    """True when the wrapper-depth bound is the only thing that makes this Bash command
    count as a send. A visible send segment is already excluded by wrapper_depth_hit; a
    send inside a heredoc body is excluded here. Any doubt keeps the generic text."""
    try:
        return wrapper_depth_hit(cmd) and not _heredoc_program_sends(cmd)
    except Exception:  # noqa: BLE001 -- wording only; the verdict is decided before this
        return False


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable payload must not wedge the session

    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}

    if re.search(r"telegram.*__reply$", tool, re.I):
        telegram_gate(tool_input)  # exits; never falls through
    if re.search(r"send_email", tool, re.I):
        text, unreadable = collect_mcp_body(tool_input), None
    elif tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        try:
            sends = is_send_invocation(cmd)
        except InspectionLimit as exc:
            # Fail-closed with an explicit exit 2: a hook still running at its timeout is
            # NON-blocking in the host, so a command the classifier cannot finish on is
            # refused up front instead of being waved through.
            sys.stderr.write(
                "KIMENO-SZOVEG KAPU: TILTVA -- a parancs tul nagy ahhoz, hogy a kapu "
                f"atvizsgalja ({exc}), es egy vizsgalhatatlan parancs nem mehet at.\n"
                "Bontsd kisebb parancsokra (nagy szoveget fajlba irj a Write tool-lal), "
                "aztan futtasd ujra.\n"
            )
            sys.exit(2)
        if not sends:
            inter_agent_homoglyph_gate(cmd)  # exits; a no-op pass for anything else
        text, unreadable = collect_bash_body(cmd)
    else:
        sys.exit(0)

    # A body over the limit is refused BEFORE any pattern runs over it (a length check is O(1)): the MCP
    # send path had no cap, and a check that cannot finish inside the hook timeout lets the mail through.
    if len(text) > MAX_AUDIT_CHARS:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA -- a kuldendo szoveg tul nagy ahhoz, hogy a kapu "
            f"atvizsgalja ({len(text)} karakter, a hatar {MAX_AUDIT_CHARS}), es egy vizsgalhatatlan kuldes nem mehet at.\n"
            "Bontsd kisebb reszekre (nagy szoveget fajlba irj a Write tool-lal), aztan kuldd ujra.\n"
        )
        try:
            from gate_audit_lib import DenyExit  # the audit row then carries the reason code
        except Exception:  # noqa: BLE001
            sys.exit(2)
        raise DenyExit(2, 'input_too_large')

    if unreadable or not text.strip():
        if tool == "Bash" and not unreadable and _depth_limit_is_sole_reason(cmd):
            # Same verdict (exit 2), a truthful reason: the wrapper-depth bound, not an
            # unreadable letter, is what blocks this command.
            sys.stderr.write(wrapper_depth_message())
            sys.exit(2)
        reason = unreadable or "a hook nem talalt vizsgalhato szoveget a hivasban"
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, mert a levelet nem tudtam megvizsgalni.\n"
            f"Ok: {reason}.\n\n"
            "Ez szandekosan fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki.\n"
            "Tedd vizsgalhatova, aztan kuldd ujra -- ABSZOLUT utvonalu stdin-atiranyitas "
            "(< /teljes/ut/body.txt, shell-valtozo NELKUL), vagy --body-ban atadott szoveg.\n"
        )
        sys.exit(2)

    # GATEPERSIST816(2): az EMAIL ut a hianyzo nev-szabalyra FAIL-CLOSED. A
    # level halaszthato, es pont a vevo fele a legdragabb a rossz nev -- egy
    # csendben lealit nev-ellenorzes mellett kuldeni rosszabb, mint megvarni a
    # szabaly-fajl potlasat. (A telegram-ag fail-open marad systemMessage
    # figyelmeztetessel: az a felugyeleti csatorna, ott a nemulas a dragabb.)
    if BAD_NAME is None:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA -- a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}), igy a nev-ellenorzes nem tud lefutni.\n"
            "Email fail-closed: potold a store/outgoing-copy-gate-rules.json-t "
            "(bad_name_patterns + correction), aztan kuldd ujra.\n"
        )
        sys.exit(2)

    problems = audit(text)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, a levél nem mehet ki így.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra. Ekezetes magyar szoveg a vevo fele "
              "nem stiluskerdes: Szabi 2026-08-10-en ket kulon esetben kerte szamon.\n"
        )
        sys.exit(2)

    sys.exit(0)


def _run_with_failclosed_net():
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-closed net
        # An unhandled crash exits 1, and PreToolUse treats 1 as NON-blocking,
        # so the call would run UNCHECKED -- the opposite of this hook's
        # fail-closed contract. The Telegram arm catches its own errors and
        # passes by design (it is the owner's only supervision channel), so
        # this net only ever catches the email and Bash paths, where blocking
        # is the safe failure mode.
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, belso hiba a vizsgalat kozben "
            f"({exc!r}).\n"
            "Fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki. "
            "Tedd vizsgalhatova a hivast, aztan kuldd ujra.\n"
        )
        sys.exit(2)


if __name__ == "__main__":
    # OTel H5b: count this run's outcome after the verdict (best effort, never changes it; see
    # gate_audit_lib.py). A missing or broken audit module leaves the gate exactly as it was.
    try:
        from gate_audit_lib import audited
    except Exception:  # noqa: BLE001
        audited = None
    if audited is None:
        _run_with_failclosed_net()
    else:
        audited('outgoing-copy-gate', _run_with_failclosed_net, deny_row=True)
