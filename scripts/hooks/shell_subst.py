"""shell_subst.py -- the command-substitution bodies of a shell command line.

WHY: a Bash gate that matches on the text BEFORE the shell expands it does not see
what a command substitution runs. `echo "$(rm -rf x)"` reads as one `echo` with a
quoted string to a segment splitter that (rightly) keeps quoted text together, but
the shell runs `rm -rf x` there. This module reads the command line the way the
shell does and hands back the text of every substitution, so a gate can judge the
body as a command of its own, exactly like the outer one.

What counts as a substitution body (the text between the markers):
  $( ... )      also $(( ... )), whose inner text is then judged like a command
  ` ... `       backquote form (\\` \\$ \\\\ are unescaped first, as the shell does)
  <( ... ) >( ... )   process substitution (command position only)
  an UNQUOTED heredoc body (`<<EOF`): the shell expands it, so a $( ) in it runs.
Where the shell expands: unquoted text and double quotes. Where it does not:
single quotes, $'...' (ANSI-C), a heredoc with a quoted or backslashed delimiter
(`<<'EOF'`), a comment, a backslash-escaped marker (`\\$(`).

Contract (same as the gates that use it):
  * LINEAR: one pass over the text, an explicit stack, no regex backtracking. Each
    character belongs to at most one top-level body, so recursing on the bodies
    costs at most (nesting depth) x (text length). The caller bounds the depth.
  * top_bodies() returns only the OUTERMOST bodies of `text`, not bodies nested in
    them; the caller recurses on each body (which finds the next level), so it can
    count depth and fail closed past a limit.
  * Unbalanced input never raises: an unterminated substitution takes the rest of
    the text as its body (judge more, never less).

KNOWN, ACCEPTED LIMIT: the closing `)` of a `case` pattern inside a `$( )` ends that
body early (`$(case x in a) rm y;; esac)`): the part after it is read in the outer
context. A determined construction, not an accident; same class as the gates'
other stated limits.
"""
import re

# Delimiter word after `<<` / `<<-`: plain characters, a backslash-escaped one, or a
# quoted run. The alternatives start with disjoint characters, so there is no
# backtracking.
_HEREDOC_WORD = re.compile(r'(-?)[ \t]*((?:[^\s;&|<>()\'"\\]|\\[\s\S]|\'[^\']*\'|"[^"]*")+)')
_BT_UNESCAPE = re.compile(r'\\([\\$`])')
_COMMENT_AFTER = ' \t\n;&|('


def _delim(word):
    """(delimiter text, quoted?) of a heredoc delimiter word."""
    quoted = ("'" in word) or ('"' in word) or ('\\' in word)
    plain = re.sub(r'\\([\s\S])|[\'"]', lambda m: m.group(1) or '', word)
    return plain, quoted


def _heredoc_bodies(text, start, pending):
    """Read the bodies of the heredocs waiting for the newline just before `start`.

    Returns (expanding bodies, index after the last closing line). An unterminated
    heredoc runs to the end of the text, as it does in the shell.
    """
    n = len(text)
    out = []
    pos = start
    for delim, quoted, strip in pending:
        body_start = pos
        while True:
            if pos >= n:
                body_end, pos = n, n
                break
            e = text.find('\n', pos)
            line_end = n if e < 0 else e
            line = text[pos:line_end]
            if (line.lstrip('\t') if strip else line) == delim:
                body_end = pos
                pos = line_end + 1
                break
            pos = line_end + 1
        if not quoted:
            out.append(text[body_start:body_end])
    return out, pos


def top_bodies(text, heredoc_body=False):
    """The outermost substitution bodies of `text`, in order of appearance.

    `heredoc_body=True` reads `text` as an unquoted heredoc body: only `$( )`,
    backticks and backslashes mean anything there; quotes are literal.
    """
    n = len(text)
    out = []
    stack = []       # frames: [kind, body_start, parens, record]
    cmd_frames = 0   # frames that are command context (everything but a double quote)
    pending = []     # heredocs opened on the current line, bodies start after its newline
    base = 'hd' if heredoc_body else 'cmd'
    i = 0

    def push(kind, body_start):
        nonlocal cmd_frames
        stack.append([kind, body_start, 1, cmd_frames == 0])
        if kind != 'dq':
            cmd_frames += 1

    def close(end):
        nonlocal cmd_frames
        kind, body_start, _parens, record = stack.pop()
        if kind != 'dq':
            cmd_frames -= 1
        if record and kind != 'dq':
            body = text[body_start:end]
            out.append(_BT_UNESCAPE.sub(r'\1', body) if kind == 'bt' else body)

    while i < n:
        c = text[i]
        kind = stack[-1][0] if stack else base

        if kind == 'bt':
            # Closes at the first unescaped backtick, whatever quotes are inside;
            # the recursion on the body reads those.
            if c == '\\':
                i += 2
            elif c == '`':
                close(i)
                i += 1
            else:
                i += 1
            continue

        if kind == 'dq' or kind == 'hd':
            if c == '\\':
                i += 2
            elif c == '"' and kind == 'dq':
                stack.pop()
                i += 1
            elif c == '$' and text.startswith('(', i + 1):
                push('sub', i + 2)
                i += 2
            elif c == '`':
                push('bt', i + 1)
                i += 1
            else:
                i += 1
            continue

        # command context: top level, $( ), <( ), >( )
        if c == '\\':
            i += 2
        elif c == "'":
            j = text.find("'", i + 1)
            i = n if j < 0 else j + 1
        elif c == '"':
            push('dq', i + 1)
            i += 1
        elif c == '$':
            nxt = text[i + 1:i + 2]
            if nxt == '(':
                push('sub', i + 2)
                i += 2
            elif nxt == "'":
                j = i + 2
                while j < n and text[j] != "'":
                    j += 2 if text[j] == '\\' else 1
                i = j + 1
            else:
                i += 1
        elif c == '`':
            push('bt', i + 1)
            i += 1
        elif c in '<>' and text.startswith('(', i + 1):
            push('proc', i + 2)
            i += 2
        elif c == '#' and (i == 0 or text[i - 1] in _COMMENT_AFTER):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif c == '(' and stack:
            stack[-1][2] += 1
            i += 1
        elif c == ')' and stack:
            stack[-1][2] -= 1
            if stack[-1][2] == 0:
                close(i)
            i += 1
        elif c == '<' and text.startswith('<<<', i):
            i += 3  # a here-string, not a heredoc: its word is read as ordinary text
        elif c == '<' and not stack and base == 'cmd' and text.startswith('<<', i):
            m = _HEREDOC_WORD.match(text, i + 2)
            if m:
                delim, quoted = _delim(m.group(2))
                pending.append((delim, quoted, bool(m.group(1))))
                i = m.end()
            else:
                i += 2
        elif c == '\n' and pending and not stack:
            bodies, i = _heredoc_bodies(text, i + 1, pending)
            pending = []
            # The expanding heredoc body is text, not a command: only the
            # substitutions inside it run.
            for b in bodies:
                out.extend(top_bodies(b, True))
        else:
            i += 1

    # An unterminated substitution takes the rest of the text.
    while stack:
        close(n)
    return out
