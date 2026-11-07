#!/usr/bin/env python3
"""eval / source / here-string reading of scripts/hooks/destructive-gate.py (C2 of the d61c7786 brief).

`eval 'rm -rf x'`, `source <(echo 'rm -rf x')`, `. <(printf ...)` and `bash <<< 'rm -rf x'` hand a LITERAL script
to a shell that runs it; the gate saw only `eval` / `source` / `bash` as the command name. The literal script is
now judged like a `bash -c` script (same depth bound).

KNOWN LIMIT, pinned below on purpose (the CHANGELOG [Security] says it too): a script built from a variable
(`eval "$A$B"`, `source "$f"`, `bash <<< "$s"`) is not followed. The gate governs cooperating agents; it does
not claim to be a sandbox. If this limit is ever closed, these pins fail and the CHANGELOG line must go with it.

The banned command is never run: only check_bash's verdict is read (block() patched). Neutral fixtures only.
"""
import importlib.util
import os
import unittest
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "destructive-gate.py",
)
_spec = importlib.util.spec_from_file_location("destructive_gate_eval", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

X = "rm -rf /nonexistent-path-a"


class _Denied(Exception):
    pass


def _deny(msg, agent_id=None, tool_name=''):
    raise _Denied(msg)


def verdict(cmd):
    with patch.object(hook, 'block', _deny):
        try:
            hook.check_bash(cmd, 'agent-a')
        except _Denied:
            return 'deny'
    return 'allow'


class TestLiteralScriptsAreRead(unittest.TestCase):
    def test_deny(self):
        shapes = [
            ('eval double quoted', 'eval "%s"' % X),
            ('eval single quoted', "eval '%s'" % X),
            ('eval unquoted words', 'eval %s' % X),
            ('eval with a keyword shape inside', 'eval "if true; then %s; fi"' % X),
            ('source process substitution, echo', "source <(echo '%s')" % X),
            ('dot process substitution, echo', ". <(echo '%s')" % X),
            ('source process substitution, printf', "source <(printf '%s')" % X),
            ('source process substitution, echo -e', "source <(echo -e '%s')" % X),
            ('here-string, spaced', "bash <<< '%s'" % X),
            ('here-string, no space', "bash <<<'%s'" % X),
            ('here-string into sh', "sh <<< '%s'" % X),
            ('eval inside bash -c', 'bash -c "eval \'%s\'"' % X),
            ('eval after a pipe', 'echo a | eval "%s"' % X),
            ('mv through eval', 'eval "mv /nonexistent-path-a /nonexistent-path-b"'),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_allow_text_and_harmless_scripts(self):
        shapes = [
            ('echo of the text', "echo '%s'" % X),
            ('eval of a harmless script', 'eval "echo hello"'),
            ('eval of a harmless unquoted script', 'eval ls -la'),
            ('source of a harmless literal', "source <(echo 'export A=1')"),
            ('source of a file', 'source ./env.sh'),
            ('dot of a file', '. ./env.sh'),
            ('here-string with a harmless script', "bash <<< 'echo hello'"),
            ('here-string into a non-shell', "grep a <<< '%s'" % X),
            ('cat of a here-string', "cat <<< '%s'" % X),
            ('heredoc into cat (data)', "cat <<'EOF'\n%s\nEOF" % X),
            ('eval with no argument', 'eval'),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestKnownLimitIsPinned(unittest.TestCase):
    """What the gate does NOT follow. A change here is a decision, not a side effect."""

    def test_variable_built_scripts_are_not_followed(self):
        for cmd in ('A=rm; B=" -rf /nonexistent-path-a"; eval "$A$B"',
                    'f=./script.sh; source "$f"',
                    's="%s"; bash <<< "$s"' % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestDepthBoundHolds(unittest.TestCase):
    def test_deeply_nested_eval_is_denied_not_followed_forever(self):
        cmd = X
        for _ in range(hook._MAX_NEST + 3):
            cmd = "eval '%s'" % cmd.replace("'", "'\\''")
        # Either the banned command is found inside the bound, or the depth limit blocks: never an allow.
        self.assertEqual(verdict(cmd), 'deny')

    def test_depth_bound_refuses_a_harmless_script_too_deep(self):
        # The bound itself, not the banned command at the bottom: a harmless script nested past the bound is
        # refused (fail closed), for eval and for a here-string chain; within the bound it is allowed.
        def nest_eval(n, inner):
            for _ in range(n):
                inner = "eval '%s'" % inner.replace("'", "'\\''")
            return inner

        def nest_here(n, inner):
            for _ in range(n):
                inner = "bash <<< '%s'" % inner.replace("'", "'\\''")
            return inner

        self.assertEqual(verdict(nest_eval(3, 'echo a')), 'allow')
        self.assertEqual(verdict(nest_here(3, 'echo a')), 'allow')
        self.assertEqual(verdict(nest_eval(hook._MAX_NEST + 4, 'echo a')), 'deny')
        self.assertEqual(verdict(nest_here(hook._MAX_NEST + 4, 'echo a')), 'deny')

    def test_literal_echo_script_helper(self):
        self.assertEqual(hook._literal_echo_script("echo 'a b'"), 'a b')
        self.assertEqual(hook._literal_echo_script("printf 'a b'"), 'a b')
        self.assertIsNone(hook._literal_echo_script('ls -la'))
        self.assertIsNone(hook._literal_echo_script('echo'))
        # Dash words after the first non-option word are PRINTED, not options.
        self.assertEqual(hook._literal_echo_script('echo rm -rf x'), 'rm -rf x')
        self.assertEqual(hook._literal_echo_script("echo -n 'a b'"), 'a b')
        # printf without a conversion prints the format alone.
        self.assertEqual(hook._literal_echo_script("printf 'a' 'b'"), 'a')


class TestEchoPrintfFailClosed(unittest.TestCase):
    """Review round 2, finding 1: what echo / printf PRINT can differ from the text the gate reads
    (`printf %b`, `\\x72m`, `echo -e`, zsh's echo). Unreadable output is denied, never guessed."""

    def test_deny_when_the_printed_text_is_not_the_written_text(self):
        shapes = [
            ('printf %b with an escape', "source <(printf '%b' 'r\\x6d -rf /nonexistent-path-a')"),
            ('printf hex escape in the format', "source <(printf 'r\\x6d -rf /nonexistent-path-a')"),
            ('printf %s format', "source <(printf '%s' 'rm -rf /nonexistent-path-a')"),
            ('printf octal escape', "source <(printf '\\162m -rf /nonexistent-path-a')"),
            ('echo -e escape', "source <(echo -e 'r\\x6d -rf /nonexistent-path-a')"),
            ('echo -e plain text', "source <(echo -e 'echo hello')"),
            ('echo -ne', "source <(echo -ne 'echo hello')"),
            ('echo with a backslash (zsh prints escapes)', "source <(echo 'r\\x6d -rf /nonexistent-path-a')"),
            ('dot with echo -e', ". <(echo -e 'echo hello')"),
            ('printf with an option', "source <(printf -v v 'echo hello')"),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_dash_words_of_the_printed_text_are_not_dropped(self):
        # The old reader dropped every word starting with '-': `echo rm -rf x` was read as "rm x".
        for cmd in ("source <(echo rm -rf /nonexistent-path-a)", ". <(echo rm -rf /nonexistent-path-a)",
                    "source <(echo -n rm -rf /nonexistent-path-a)"):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_allow_plain_readable_output(self):
        for cmd in ("source <(echo 'export A=1')", "source <(echo -n 'export A=1')",
                    "source <(printf 'export A=1')", ". <(echo hello)"):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestHereStringAnywhere(unittest.TestCase):
    """Review round 2, finding 2: `bash<<<'X'` (no space) and a `<<<` after other words of the shell's segment."""

    def test_deny(self):
        shapes = [
            ('no space before, quoted', "bash<<<'%s'" % X),
            ('no space either side', 'bash<<<"%s"' % X),
            ('sh no space', "sh<<<'%s'" % X),
            ('after an option', "bash -x <<< '%s'" % X),
            ('after a long option', "bash --norc <<<'%s'" % X),
            ('after a redirect', "bash 2>&1 <<< '%s'" % X),
            ('source stdin', "source /dev/stdin <<< '%s'" % X),
            ('dot stdin', ". /dev/stdin<<<'%s'" % X),
            ('behind a wrapper', "env A=1 bash<<<'%s'" % X),
            ('behind a pipe', "true | bash<<<'%s'" % X),
            ('after && ', "true && bash<<<'%s'" % X),
            ('inside a command substitution', "echo $(bash<<<'%s')" % X),
            ('second here-string in the segment', "bash -s <<< 'echo a' <<<'%s'" % X),
            ('unquoted word', "bash<<<%s" % X.replace(' ', '\\ ')),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_allow_data_here_strings(self):
        for cmd in ("cat<<<'%s'" % X, "grep a<<<'%s'" % X, "read -r v <<< '%s'" % X,
                    "bash -c 'cat' <<< '%s'" % X.replace('rm', 'ls'), "bash<<<'echo hello'",
                    "true | cat<<<'%s'" % X, "echo '<<<' && cat <<< '%s'" % X,
                    "echo \"bash<<<'%s'\"" % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestEvalManyArguments(unittest.TestCase):
    """Review round 2, finding 3: eval joins ALL its arguments with spaces."""

    def test_deny(self):
        shapes = [
            ('separator argument then script', "eval true ';' '%s'" % X),
            ('escaped separator joined to a word', "eval true\\; '%s'" % X),
            ('double dash then script', "eval -- '%s'" % X),
            ('double dash, unquoted', "eval -- %s" % X),
            ('two quoted arguments', "eval 'true;' '%s'" % X),
            ('unquoted word then quoted script', "eval x ';' \"%s\"" % X),
            ('three arguments', "eval 'true' ';' 'true' ';' '%s'" % X),
            ('second eval in the same segment', "eval 'echo a' ';' eval '%s'" % X),
            ('mv as the later argument', "eval true ';' 'mv /nonexistent-path-a /nonexistent-path-b'"),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_allow(self):
        for cmd in ("eval 'echo a' 'echo b'", "eval -- 'echo hello'", "eval a 'b c'",
                    "eval 'echo hello'; echo '%s'" % X, "eval 'echo hello' && echo \"%s\"" % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_allow_eval_as_text_or_with_harmless_substitution(self):
        for cmd in ("echo eval '%s'" % X, "man eval; echo '%s'" % X, "eval 'echo a' $(date) 'echo b'",
                    "eval 'echo a' \"$(date)\" 'echo b'", "grep eval notes.txt 'rm'"):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestReviewRoundThree(unittest.TestCase):
    """Findings of the automated review of 2840c7f0 (C2b): three more parser differentials."""

    def test_escaped_delimiter_still_cuts_a_segment(self):
        # An escaped `;` used to be a literal, so `watch ...\; rm x` (watch joins its arguments and
        # re-parses them in a shell) ran a banned command the gate never saw. Over-splitting is the fail-closed
        # direction: the text after the cut is a command of its own.
        for cmd in ("watch echo a\\; %s" % X, "parallel echo a\\; %s" % X, "echo a \\| %s" % X,
                    "watch -n1 'echo a'\\; %s" % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'deny', cmd)
        # eval, whose script has the real `;`:
        self.assertEqual(verdict("eval true\\; '%s'" % X), 'deny')

    def test_eval_arguments_after_a_substitution_are_read(self):
        # The scan for eval's arguments stopped at the `)` of a substitution: `eval true ';' $(b) 'X'` runs
        # X when $(b) prints nothing.
        shapes = [
            ('command substitution', "eval true ';' $(b) '%s'" % X),
            ('substitution with a separator inside', "eval true ';' $(b; c) '%s'" % X),
            ('quoted substitution', "eval true ';' \"$(b)\" '%s'" % X),
            ('backticks', "eval true ';' `b` '%s'" % X),
            ('backticks with a separator inside', "eval true ';' `b; c` '%s'" % X),
            ('nested substitution', "eval true ';' $(b $(c)) '%s'" % X),
            ('subshell parentheses', "eval true ';' (b) '%s'" % X),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_here_string_in_a_segment_with_a_shell_word_anywhere(self):
        shapes = [
            ('behind a wrapper command', "nohup bash<<<'%s'" % X),
            ('behind a wrapper the gate does not know', "doas bash <<< '%s'" % X),
            ('redirect first', "<<<'%s' bash" % X),
            ('redirect first, spaced', "<<< '%s' sh" % X),
            ('inside a brace group', "{ bash <<< '%s'; }" % X),
            ('inside a subshell', "(bash <<< '%s')" % X),
            ('behind env -i', "env -i bash<<<'%s'" % X),
            ('shell as a later argument', "ssh host bash <<< '%s'" % X),
            ('source with a redirect first', "<<<'%s' source /dev/stdin" % X),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_here_string_without_a_shell_word_stays_data(self):
        for cmd in ("cat <<<'%s'" % X, "nohup cat <<< '%s'" % X, "tee out.txt <<< '%s'" % X,
                    "wc -c <<< '%s'" % X, "{ cat <<< '%s'; }" % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_obfuscated_eval_name_is_still_eval(self):
        # Review of the next commit: eval was found by its LITERAL letters in the raw text.
        shapes = [
            ('empty quotes inside the name', "ev''al '%s'" % X),
            ('double-quoted half', "\"ev\"al '%s'" % X),
            ('backslash in the name', "\\eval '%s'" % X),
            ('backslash mid-name', "ev\\al '%s'" % X),
            ('quoted whole name', "'eval' '%s'" % X),
            ('obfuscated and escaped separator', "ev''al true\\; '%s'" % X),
            ('behind a wrapper command', "nohup ev''al '%s'" % X),
            ('after a pipe', "echo a | ev''al '%s'" % X),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_here_string_next_to_its_shell_across_an_escaped_delimiter(self):
        # The shell word and the here-string sat in two over-split pieces of ONE bash command.
        shapes = [
            ('escaped semicolon between', "bash -s a\\; <<< '%s'" % X),
            ('escaped pipe between', "sh -s -- x\\| <<< '%s'" % X),
            ('escaped ampersand between', "bash a\\& <<<'%s'" % X),
            ('after an escaped separator, redirect first', "<<<'%s' bash a\\;" % X),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)
        # An ESCAPED backslash is a literal backslash and the semicolon really ends the command.
        self.assertEqual(verdict("echo a\\\\; cat <<< '%s'" % X), 'allow')

    def test_precommand_modifiers_are_transparent(self):
        # `builtin eval 'X'` / zsh `noglob eval 'X'`: the next word is still the command.
        for cmd in ("builtin eval '%s'" % X, "noglob eval '%s'" % X, "nocorrect eval '%s'" % X,
                    "builtin noglob eval '%s'" % X, "builtin bash<<<'%s'" % X, "noglob %s" % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'deny', cmd)
        for cmd in ("builtin echo hello", "noglob ls *.txt"):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_depth_bound_with_word_chains(self):
        # Chains of WORDS do not grow when quoted (the quoted nesting above is 4x per level and meets the call
        # size cap first), so they test the bound itself: eval eval ... and bash -c 'bash -c ...'.
        n = hook._MAX_NEST + 4
        self.assertEqual(verdict('eval ' * 3 + 'echo a'), 'allow')
        self.assertEqual(verdict('eval ' * n + 'echo a'), 'deny')
        # The -c loop has its own bound check: reached through the evals (nested -c quoting is not unwound).
        self.assertEqual(verdict('eval ' * 3 + "bash -c 'echo a'"), 'allow')
        self.assertEqual(verdict('eval ' * hook._MAX_NEST + "bash -c 'echo a'"), 'deny')

    def test_escaped_substitution_among_eval_arguments_runs_after_unescaping(self):
        # eval receives `$(rm ..)` (the outer shell removed the backslashes) and runs the substitution.
        for cmd in ("eval \\$\\(rm -rf /nonexistent-path-a\\)", "eval \\`rm -rf /nonexistent-path-a\\`",
                    "eval \"\\$(rm -rf /nonexistent-path-a)\""):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_time_budget_stops_the_eval_and_here_string_reading(self):
        import itertools
        with patch.object(hook.time, 'monotonic', side_effect=itertools.count(0, 10.0)):
            self.assertEqual(verdict("eval 'echo a'"), 'deny')
            self.assertEqual(verdict("bash <<< 'echo a'"), 'deny')

    def test_semicolon_after_a_comment_hash_is_read_as_code_pinned(self):
        # Review note: in the shell `echo x #; then rm -rf X` is a comment, the gate reads the `rm` and denies.
        # A conservative direction (a deny the shell would not run), pinned so that a change is a decision.
        self.assertEqual(verdict("echo x #; then %s" % X), 'deny')
        self.assertEqual(verdict("echo x # then %s" % X), 'allow')

    def test_known_limit_case_pattern_paren_in_a_substitution_is_pinned(self):
        # The `)` of a `case` pattern inside a substitution ends the scan for eval's arguments early: the
        # same accepted limit as shell_subst ("a determined construction, not an accident"). Pinned so that
        # closing it is a decision; the CHANGELOG [Security] line says it too.
        cmd = "eval true ';' $(case x in a) b ;; esac) '%s'" % X
        self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_scan_stays_linear(self):
        # Many evals / here-strings in one segment must not cost a quadratic scan. Compared by CPU time
        # against a 4x longer input: quadratic growth would be 16x, linear about 4x (limit 9x).
        import time

        def cost(n):
            t0 = time.process_time()
            hook.scannable(("eval " * n) + "'echo a'")
            hook.scannable("echo " + "eval " * n + "'echo a'")  # eval as TEXT: never a command
            hook.scannable("bash<<<'a' " * n)
            hook.scannable("cat <<<'a' " * n)
            hook._eval_scripts("eval 'a' $(b) " * n)
            return time.process_time() - t0

        cost(200)  # warm up
        small, large = cost(4000), cost(16000)
        self.assertLess(large, max(small, 0.01) * 9, (small, large))


if __name__ == '__main__':
    unittest.main(verbosity=2)
