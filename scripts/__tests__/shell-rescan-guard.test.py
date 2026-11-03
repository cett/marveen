#!/usr/bin/env python3
"""Tests for scripts/hooks/shell-rescan-guard.py and shell_rescan_lib.py (+ the `events` of shell_subst).

The gate refuses a Bash command whose own text the shell would re-scan: a backtick inside a double-quoted
string (E), a backtick in an unquoted heredoc body (B), ${v@P} (D). It does NOT refuse `eval`, `$( )` in an
inline payload, or anything deliberate (decision recorded in the gate's docstring): those shapes are asserted
ALLOWED below, so a later "while we are here" rule has to change a test on purpose.

Layers:
  * verdict matrix through the real entry point (stdin JSON -> exit code), refused / allowed shapes;
  * the table checked against REAL bash: for every backtick shape, did a canary command actually run?
  * fail-closed: unreadable input, an internal error, every limit, a closed stderr -> exit 2;
  * no backstop, no comment escape: the same refused command is refused every time;
  * limits at their exact edges and with padding (a hostile construct hidden behind the cap or the budgets);
  * timing: hostile 250 kB inputs answer in linear time (forked, cut off by timing_budget.best_of).

Neutral fixtures only. The commands are never run, except the canary table, which runs a function that only
creates a file inside a temporary directory.
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "shell-rescan-guard.py")
sys.path.insert(0, HERE)
sys.path.insert(0, HOOKS)
from timing_budget import LINEAR_CEILING_SEC, best_of, describe  # noqa: E402
import shell_rescan_lib as lib  # noqa: E402
import shell_subst  # noqa: E402

_spec = importlib.util.spec_from_file_location("shell_rescan_guard_under_test", GATE)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

BT = chr(96)  # a backtick, spelled so that this file never contains one in a string a shell could see


def event(command):
    return json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})


def run_gate(command=None, raw=None, env_extra=None, stderr=subprocess.PIPE, preexec=None):
    data = raw if raw is not None else event(command)
    p = subprocess.run([sys.executable, "-I", GATE], input=data.encode("utf-8", "surrogatepass"),
                       stdout=subprocess.PIPE, stderr=stderr, timeout=30,
                       env=dict(os.environ, **(env_extra or {})), preexec_fn=preexec)
    return p


def verdict(command):
    return run_gate(command).returncode


def bt(s):
    return BT + s + BT


# --- the shapes -----------------------------------------------------------------------------------------

REFUSED = [
    ("E: backtick in a double-quoted message", 'echo "run %s now"' % bt("id")),
    ("E: backtick in dq, markdown style", 'git commit -m "fix the %s flag"' % bt("--force")),
    ("E: backtick inside a $( ) that sits in dq", 'echo "$(echo "%s")"' % bt("id")),
    ("E: backtick in dq inside a bash -c payload", 'bash -c "echo %s"' % bt("id")),
    ("E: backtick in the second dq word", 'echo "a" "%s"' % bt("id")),
    ("E: unterminated dq still reads the backtick", 'echo "%s' % bt("id")),
    ("E: dq after an escaped dq", 'echo \\" "%s"' % bt("id")),
    ("E: backtick in dq in an assignment", 'v="%s"' % bt("id")),
    ("E: backtick in dq in a heredoc-opening line", 'cat <<\'X\' "%s"\nbody\nX\n' % bt("id")),
    ("E: an apostrophe in a comment does not blind the reader", "# don't panic\necho \"%s\"" % bt("id")),
    ("E: after a quoted heredoc", "cat <<'X'\nbody\nX\necho \"%s\"" % bt("id")),
    ("B: unquoted heredoc with a backtick body", "cat <<EOF\nfoo %s\nEOF\n" % bt("id")),
    ("B: <<- unquoted heredoc", "cat <<-EOF\n\tfoo %s\n\tEOF\n" % bt("id")),
    ("B: second heredoc of two is the unquoted one", "cat <<'A' <<B\nx\nA\nfoo %s\nB\n" % bt("id")),
    ("B: heredoc whose delimiter is tab-indented only under <<-", "cat <<-EOF\n foo %s\n\tEOF\n" % bt("id")),
    ("B: heredoc inside a $( )", "x=$(cat <<EOF\nfoo %s\nEOF\n)" % bt("id")),
    ("D: ${v@P} bare", "echo ${x@P}"),
    ("D: ${v@P} in dq", 'echo "${x@P}"'),
    ("D: ${!v@P}", 'echo "${!x@P}"'),
    ("D: ${arr[1]@P}", 'echo "${arr[1]@P}"'),
    ("D: ${1@P}", 'echo "${1@P}"'),
    ("D: a long variable name", 'echo "${prompt_template_text@P}"'),
    ("D: the longest name the pattern reads (64)", 'echo "${%s@P}"' % ("n" * 64)),
    ("D: a long subscript", 'echo "${arr[%s]@P}"' % ("i" * 40)),
    ("D: ${@@P}", 'echo "${@@P}"'),
    ("D: ${v@P} in an unquoted heredoc", "cat <<EOF\n${x@P}\nEOF\n"),
    ("D: ${v@P} inside a $( )", 'echo "$(echo ${x@P})"'),
]

ALLOWED = [
    ("single quotes", "echo 'foo %s'" % bt("id")),
    ("single quotes around a dq", """echo 'say "%s"'""" % bt("id")),
    ("ANSI-C quoting", "echo $'foo %s'" % bt("id")),
    ("quoted heredoc", "cat <<'EOF'\nfoo %s\nEOF\n" % bt("id")),
    ("double-quoted delimiter heredoc", 'cat <<"EOF"\nfoo %s\nEOF\n' % bt("id")),
    ("backslash delimiter heredoc", "cat <<\\EOF\nfoo %s\nEOF\n" % bt("id")),
    ("escaped backtick in dq", 'echo "a \\%sb\\%s"' % (BT, BT)),
    ("escaped backtick in an unquoted heredoc", "cat <<EOF\nfoo \\%sid\\%s\nEOF\n" % (BT, BT)),
    ("backtick in a comment", "# run %s\necho hi" % bt("id")),
    ("an apostrophe in a comment", "# don't panic\necho hi"),
    ("unquoted backtick (deliberate old-style substitution)", "echo %s" % bt("date")),
    ("unquoted backtick assignment", "v=%s" % bt("date")),
    ("$( ) in dq", 'echo "$(date)"'),
    ("$( ) in an unquoted heredoc", "cat <<EOF\n$(date)\nEOF\n"),
    ("standalone token file read", 'curl -H "Authorization: Bearer $(cat tokenfile)" https://example.invalid/x'),
    ("commit message through a quoted heredoc", "git commit -m \"$(cat <<'EOF'\nfix: thing\n\nbody\nEOF\n)\""),
    ("commit heredoc body with a quoted phrase holding a backtick",
     "git commit -m \"$(cat <<'EOF'\nfix: the \"x %s z\" case\nEOF\n)\"" % bt("y")),
    ("commit heredoc body with an apostrophe and a backtick", "git commit -m \"$(cat <<'EOF'\ndon't use %s\nEOF\n)\"" % bt("x")),
    ("nested quoted heredoc with dq and backtick in a bash -c", "bash -c \"$(cat <<'EOF'\necho \\\"%s\\\"\nEOF\n)\"" % bt("x")),
    ("a quoted heredoc body in a $( ) that mentions ${v@P} as text", "x=\"$(cat <<'EOF'\nthe ${x@P} form\nEOF\n)\""),
    ("the same with the form inside a quoted phrase", "x=\"$(cat <<'EOF'\nthe \"${x@P}\" form\nEOF\n)\""),
    ("the same without the double quotes","y=$(cat <<'EOF'\nthe ${x@P} form\nEOF\n)"),
    ("agent-api.sh @file","bash agent-api.sh POST /api/messages @body.json"),
    ("${v@P} in single quotes", "echo '${x@P}'"),
    ("escaped ${v@P}", "echo \\${x@P}"),
    ("${v@Q} is not prompt expansion", 'echo "${x@Q}"'),
    ("${v:-default}", 'echo "${x:-default}"'),
    ("the word eval as an argument", "grep eval file.txt"),
    ("here-string", "cat <<< \"hello\""),
    ("arithmetic", 'echo "$((1 + 2))"'),
    ("empty command", ""),
    ("plain", "ls -la"),
]

# Shapes upstream refuses and this port deliberately does NOT (decision: they are intentional uses; refusing
# them only trains people to route around the gate). Pinned so adding them back is a visible change.
DROPPED_RULES = [
    ("A: $( ) in an inline interpreter payload", 'python3 -c "print(\'$(id)\')"'),
    ("A: $( ) in node -e", 'node -e "console.log(\'$(id)\')"'),
    ("A: $( ) in bash -c", 'bash -c "echo $(id)"'),
    ("C: eval of a variable", 'eval "$cmd"'),
    ("C: eval with a command", "eval echo hi"),
    ("B: $( ) in an unquoted heredoc is not B (only the backtick is)", "cat <<EOF\n$(id)\nEOF\n"),
]


class TestVerdictMatrix(unittest.TestCase):
    def test_refused_shapes(self):
        for name, cmd in REFUSED:
            with self.subTest(name):
                p = run_gate(cmd)
                self.assertEqual(p.returncode, 2, cmd)

    def test_allowed_shapes(self):
        for name, cmd in ALLOWED:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 0, cmd)

    def test_dropped_rules_stay_dropped(self):
        for name, cmd in DROPPED_RULES:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 0, cmd)

    def test_a_non_bash_tool_is_not_this_gates_business(self):
        raw = json.dumps({"tool_name": "Read", "tool_input": {"file_path": "x%sid%s" % (BT, BT)}})
        self.assertEqual(run_gate(raw=raw).returncode, 0)

    def test_a_refusal_names_the_rule_and_the_remedy_in_hungarian_ascii(self):
        p = run_gate('echo "run %s now"' % bt("id"))
        err = p.stderr.decode("ascii")  # ASCII: no stdout/stderr encoding can break the message
        self.assertIn("E_BACKTICK_IN_DQ", err)
        self.assertIn("ORVOSLAT", err)
        self.assertIn("idezett heredoc", err)
        self.assertIn("NEM lat", err)  # the honest-scope sentence is in every refusal
        self.assertNotIn(chr(0x2014), err)

    def test_every_rule_has_its_own_message(self):
        for cmd, rule in (('echo "%s"' % bt("x"), "E_BACKTICK_IN_DQ"),
                          ("cat <<EOF\n%s\nEOF\n" % bt("x"), "B_UNQUOTED_HEREDOC"),
                          ("echo ${v@P}", "D_PROMPT_EXPAND")):
            with self.subTest(rule):
                err = run_gate(cmd).stderr.decode("ascii")
                self.assertIn(rule + ":", err)
                self.assertIn(gate.REMEDY[rule], err)
                others = [r for r in gate.REMEDY if r != rule]
                for o in others:
                    self.assertNotIn(o + ":", err)

    def test_several_rules_are_all_named(self):
        cmd = 'echo "%s" ${v@P}\ncat <<EOF\n%s\nEOF\n' % (bt("a"), bt("b"))
        err = run_gate(cmd).stderr.decode("ascii")
        for rule in gate.REMEDY:
            self.assertIn(rule + ":", err)

    def test_the_excerpt_points_at_the_construct(self):
        err = run_gate('echo "before %s after"' % bt("id")).stderr.decode("ascii")
        self.assertIn("before", err)


class TestFindingsApi(unittest.TestCase):
    def rules(self, cmd):
        return [r for r, _ in lib.findings(cmd)]

    def test_rule_order_is_fixed(self):
        cmd = 'echo ${v@P} "%s"\ncat <<EOF\n%s\nEOF\n' % (bt("a"), bt("b"))
        self.assertEqual(self.rules(cmd), ["E_BACKTICK_IN_DQ", "B_UNQUOTED_HEREDOC", "D_PROMPT_EXPAND"])

    def test_one_entry_per_rule(self):
        self.assertEqual(self.rules('echo "%s" "%s" "%s"' % (bt("a"), bt("b"), bt("c"))), ["E_BACKTICK_IN_DQ"])

    def test_empty_is_clean(self):
        self.assertEqual(lib.findings(""), [])

    def test_events_are_off_by_default(self):
        # the extra argument must not change what top_bodies returns
        cmd = 'echo "%s" "$(date)"' % bt("a")
        self.assertEqual(shell_subst.top_bodies(cmd), shell_subst.top_bodies(cmd, False, None, []))

    def test_events_positions_are_inside_the_text(self):
        ev = []
        cmd = 'echo "x %s" ${v@P}' % bt("a")
        shell_subst.top_bodies(cmd, False, None, ev)
        self.assertEqual(sorted(r for r, _ in ev), ["D_PROMPT_EXPAND", "E_BACKTICK_IN_DQ"])
        for _rule, pos in ev:
            self.assertTrue(0 <= pos < len(cmd))
        e = dict(ev)
        self.assertEqual(cmd[e["E_BACKTICK_IN_DQ"]], BT)
        self.assertTrue(cmd.startswith("${", e["D_PROMPT_EXPAND"]))


class TestAgainstRealBash(unittest.TestCase):
    """For each backtick shape: did bash really run the canary, and does the gate's verdict agree with the
    class? A table that disagrees with bash would be a wrong table."""

    # (name, command, bash runs the canary?, gate refuses?)
    SHAPES = [
        ("dq", 'echo "x %s y"' % bt("canary"), True, True),
        ("dq nested in $( )", 'echo "$(echo "%s")"' % bt("canary"), True, True),
        ("unquoted heredoc", "cat <<EOF\nx %s\nEOF\n" % bt("canary"), True, True),
        ("single quotes", "echo 'x %s y'" % bt("canary"), False, False),
        ("quoted heredoc", "cat <<'EOF'\nx %s\nEOF\n" % bt("canary"), False, False),
        ("escaped in dq", 'echo "x \\%scanary\\%s y"' % (BT, BT), False, False),
        ("escaped in unquoted heredoc", "cat <<EOF\nx \\%scanary\\%s\nEOF\n" % (BT, BT), False, False),
        ("comment", "# x %s\ntrue" % bt("canary"), False, False),
        ("ANSI-C quoting", "echo $'x %s'" % bt("canary"), False, False),
        # runs, and the gate lets it through ON PURPOSE (deliberate old-style substitution):
        ("unquoted backtick", "echo %s" % bt("canary"), True, False),
        ("dollar-paren in dq", 'echo "$(canary)"', True, False),
    ]

    def run_bash(self, cmd):
        with tempfile.TemporaryDirectory() as d:
            mark = os.path.join(d, "mark")
            script = 'canary() { : > "$MARK"; }\n' + cmd + "\n"
            subprocess.run(["bash", "--noprofile", "--norc", "-c", script], capture_output=True, timeout=20,
                           env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "MARK": mark}, cwd=d)
            return os.path.exists(mark)

    def test_table(self):
        for name, cmd, runs, refused in self.SHAPES:
            with self.subTest(name):
                self.assertEqual(self.run_bash(cmd), runs, "bash disagrees with the table for: " + cmd)
                self.assertEqual(verdict(cmd) == 2, refused, cmd)


class TestFailClosed(unittest.TestCase):
    def test_not_json(self):
        self.assertEqual(run_gate(raw="{not json").returncode, 2)

    def test_empty_stdin(self):
        self.assertEqual(run_gate(raw="").returncode, 2)

    def test_json_but_not_an_object(self):
        for raw in ("[]", '"x"', "null", "7"):
            with self.subTest(raw):
                self.assertEqual(run_gate(raw=raw).returncode, 2)

    def test_bash_without_tool_input(self):
        self.assertEqual(run_gate(raw=json.dumps({"tool_name": "Bash"})).returncode, 2)
        self.assertEqual(run_gate(raw=json.dumps({"tool_name": "Bash", "tool_input": "x"})).returncode, 2)

    def test_command_that_is_not_a_string(self):
        for cmd in (7, ["echo"], {"a": 1}, True):
            with self.subTest(repr(cmd)):
                raw = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
                self.assertEqual(run_gate(raw=raw).returncode, 2)

    def test_stdin_over_the_cap_is_refused_unread(self):
        p = run_gate(raw=" " * (gate.MAX_STDIN_BYTES + 1))
        self.assertEqual(p.returncode, 2)
        self.assertIn("tul nagy", p.stderr.decode("ascii"))

    def test_stdin_at_the_cap_is_read(self):
        pad = gate.MAX_STDIN_BYTES - len(event("ls"))
        self.assertEqual(len((event("ls") + " " * pad).encode()), gate.MAX_STDIN_BYTES)
        self.assertEqual(run_gate(raw=event("ls") + " " * pad).returncode, 0)
        self.assertEqual(run_gate(raw=event("ls") + " " * (pad + 1)).returncode, 2)

    def test_stdin_is_read_with_a_bound(self):
        sizes = []

        class Buf(object):
            def read(self, n=-1):
                sizes.append(n)
                return event("ls").encode()

        with patch.object(sys, "stdin", types.SimpleNamespace(buffer=Buf())):
            with self.assertRaises(SystemExit) as cm:
                gate.main()
        self.assertEqual(cm.exception.code, 0)
        self.assertEqual(sizes, [gate.MAX_STDIN_BYTES + 1])

    def test_a_stdin_read_error_is_a_deny(self):
        class Buf(object):
            def read(self, n=-1):
                raise OSError("pipe gone")

        with patch.object(sys, "stdin", types.SimpleNamespace(buffer=Buf())), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                gate.main()
        self.assertEqual(cm.exception.code, 2)

    def test_the_gate_is_counted_and_a_deny_leaves_an_audit_row(self):
        import gate_audit_lib
        import runpy
        self.assertIn("shell-rescan-guard", gate_audit_lib.GATES)
        seen = []

        def fake_audited(name, fn, deny_row=False):
            seen.append((name, deny_row))
            fn()

        stdin = types.SimpleNamespace(buffer=io.BytesIO(event("ls").encode()))
        with patch.object(gate_audit_lib, "audited", fake_audited), patch.object(sys, "stdin", stdin):
            with self.assertRaises(SystemExit) as cm:
                runpy.run_path(GATE, run_name="__main__")
        self.assertEqual(cm.exception.code, 0)
        self.assertEqual(seen, [("shell-rescan-guard", True)])

    def test_a_broken_audit_module_leaves_the_verdict_alone(self):
        import runpy
        for cmd, want in (('echo "%s"' % bt("id"), 2), ("ls", 0)):
            stdin = types.SimpleNamespace(buffer=io.BytesIO(event(cmd).encode()))
            with patch.dict(sys.modules, {"gate_audit_lib": None}), patch.object(sys, "stdin", stdin), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as cm:
                    runpy.run_path(GATE, run_name="__main__")
            self.assertEqual(cm.exception.code, want, cmd)

    def test_an_oversized_input_is_audited_with_its_own_reason(self):
        stdin = types.SimpleNamespace(buffer=io.BytesIO(b" " * (gate.MAX_STDIN_BYTES + 1)))
        with patch.object(sys, "stdin", stdin), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                gate.main()
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(getattr(cm.exception, "reason", None), "input_too_large")

    def test_a_non_bash_tool_with_a_command_field_is_not_inspected(self):
        raw = json.dumps({"tool_name": "Write", "tool_input": {"command": 'echo "%s"' % bt("id")}})
        self.assertEqual(run_gate(raw=raw).returncode, 0)

    def test_a_lone_surrogate_written_as_raw_bytes_is_read(self):
        # CESU-style bytes (ED A0 80) in the JSON text: a strict utf-8 decode would fail and deny every such call.
        raw = '{"tool_name": "Bash", "tool_input": {"command": "echo \ud800 hi"}}'
        self.assertEqual(run_gate(raw=raw).returncode, 0)
        raw = '{"tool_name": "Bash", "tool_input": {"command": "echo \ud800 \\"%s\\""}}' % BT
        self.assertEqual(run_gate(raw=raw).returncode, 2)

    def _main_with(self, raw, **patches):
        stdin = types.SimpleNamespace(buffer=io.BytesIO(raw.encode("utf-8", "surrogatepass")))
        err = io.StringIO()
        with patch.object(sys, "stdin", stdin), contextlib.redirect_stderr(err):
            try:
                gate.main()
            except SystemExit as e:
                return e.code, err.getvalue()
        return 0, err.getvalue()

    def test_an_internal_error_in_the_detector_is_a_deny(self):
        for exc in (RuntimeError("boom"), KeyError("k"), RecursionError("deep"), MemoryError()):
            with self.subTest(type(exc).__name__):
                with patch.object(lib, "findings", side_effect=exc):
                    code, err = self._main_with(event("ls"))
                self.assertEqual(code, 2)
                self.assertIn(type(exc).__name__, err)

    def test_the_detector_import_failing_is_a_deny(self):
        with patch.dict(sys.modules, {"shell_rescan_lib": None}):
            code, _err = self._main_with(event("ls"))
        self.assertEqual(code, 2)

    def test_a_closed_stderr_does_not_turn_the_deny_into_an_allow(self):
        def close_stderr():
            os.close(2)

        p = run_gate('echo "%s"' % bt("id"), stderr=None, preexec=close_stderr)
        self.assertEqual(p.returncode, 2)

    def test_a_broken_stderr_pipe_does_not_turn_the_deny_into_an_allow(self):
        class Broken(object):
            def write(self, _s):
                raise BrokenPipeError()

            def flush(self):
                raise BrokenPipeError()

        stdin = types.SimpleNamespace(buffer=io.BytesIO(event('echo "%s"' % bt("id")).encode()))
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stderr", Broken()):
            with self.assertRaises(SystemExit) as cm:
                gate.main()
        self.assertEqual(cm.exception.code, 2)

    def test_a_non_ascii_stdout_encoding_cannot_break_the_message(self):
        p = run_gate('echo "%s"' % bt("é中"), env_extra={"PYTHONIOENCODING": "ascii"})
        self.assertEqual(p.returncode, 2)

    def test_the_excerpt_is_ascii_even_for_a_non_ascii_command(self):
        p = run_gate('echo "é中 %s \ud800"' % bt("id"))
        self.assertEqual(p.returncode, 2)
        err = p.stderr.decode("ascii")  # raises on any non-ASCII byte
        self.assertIn("E_BACKTICK_IN_DQ", err)

    def test_a_lone_surrogate_in_the_command_still_gets_a_verdict(self):
        raw = '{"tool_name": "Bash", "tool_input": {"command": "echo \\ud800 \\"%s\\""}}' % BT
        self.assertEqual(run_gate(raw=raw).returncode, 2)
        raw = '{"tool_name": "Bash", "tool_input": {"command": "echo \\ud800 hi"}}'
        self.assertEqual(run_gate(raw=raw).returncode, 0)


class TestNoBackstopNoEscape(unittest.TestCase):
    """The upstream gate let a command through after three refusals and honoured a `# rescan-ok:` comment. Both are
    a bypass the model can use at will. Here neither exists."""

    def test_the_same_refused_command_is_refused_every_time(self):
        cmd = 'echo "run %s now"' % bt("id")
        for i in range(8):
            self.assertEqual(verdict(cmd), 2, "attempt %d" % i)

    def test_a_rescan_ok_comment_changes_nothing(self):
        for cmd in ('echo "%s"  # rescan-ok: on purpose' % bt("id"),
                    '# rescan-ok: on purpose\necho "%s"' % bt("id"),
                    'echo "%s" # rescan-ok:' % bt("id")):
            with self.subTest(cmd):
                self.assertEqual(verdict(cmd), 2)

    def test_the_gate_keeps_no_state_and_no_log(self):
        with tempfile.TemporaryDirectory() as d:
            env = {"SHELL_RESCAN_GUARD_STATE_DIR": d, "SHELL_RESCAN_GUARD_LOG": os.path.join(d, "log")}
            for _ in range(4):
                run_gate('echo "%s"' % bt("id"), env_extra=env)
            self.assertEqual(os.listdir(d), [])
        with open(GATE, encoding="utf-8") as fh:
            src = fh.read()
        for word in ("MAX_BLOCKS", "backstop-allow", "flock", "os.replace"):
            self.assertNotIn(word, src)


class TestLimits(unittest.TestCase):
    HOSTILE = 'echo "%s"' % bt("id")

    def findings_or_unreadable(self, cmd):
        try:
            return lib.findings(cmd)
        except lib.Unreadable:
            return "unreadable"

    def test_size_cap_edges(self):
        cap = lib.MAX_CMD_CHARS
        self.assertEqual(self.findings_or_unreadable("echo " + "a" * (cap - 5)), [])
        self.assertEqual(self.findings_or_unreadable("echo " + "a" * (cap - 4)), "unreadable")
        self.assertEqual(verdict("echo " + "a" * (cap - 5)), 0)
        self.assertEqual(verdict("echo " + "a" * (cap - 4)), 2)

    def test_padding_cannot_hide_a_hostile_construct_below_the_cap(self):
        cap = lib.MAX_CMD_CHARS
        for where in ("front", "back"):
            with self.subTest(where):
                pad = "echo pad\n" * ((cap - len(self.HOSTILE) - 1) // 9)
                cmd = (pad + self.HOSTILE) if where == "front" else (self.HOSTILE + "\n" + pad)
                self.assertLessEqual(len(cmd), cap)
                self.assertEqual(verdict(cmd), 2)
                self.assertEqual([r for r, _ in lib.findings(cmd)], ["E_BACKTICK_IN_DQ"])

    def test_padding_past_the_cap_is_a_deny_not_a_pass(self):
        cmd = "echo pad\n" * (lib.MAX_CMD_CHARS // 9 + 2) + "ls"
        self.assertGreater(len(cmd), lib.MAX_CMD_CHARS)
        p = run_gate(cmd)
        self.assertEqual(p.returncode, 2)
        self.assertIn("tul nagy", p.stderr.decode("ascii"))

    def test_body_count_edges(self):
        n = lib.MAX_BODIES
        self.assertEqual(self.findings_or_unreadable('echo "$(a)" ' * n), [])
        self.assertEqual(self.findings_or_unreadable('echo "$(a)" ' * (n + 1)), "unreadable")

    def test_blank_bodies_count_and_cannot_hide_a_real_one(self):
        n = lib.MAX_BODIES
        self.assertEqual(self.findings_or_unreadable('echo "$()" ' * n), [])
        self.assertEqual(self.findings_or_unreadable('echo "$()" ' * (n + 1)), "unreadable")
        self.assertEqual(verdict('echo "$()" ' * (n + 5) + self.HOSTILE), 2)

    def test_nesting_edges(self):
        d = lib.MAX_NEST
        ok = 'echo "$(' * d + "x" + ')"' * d
        self.assertEqual(self.findings_or_unreadable(ok), [])
        too_deep = 'echo "$(' * (d + 2) + "x" + ')"' * (d + 2)
        self.assertEqual(self.findings_or_unreadable(too_deep), "unreadable")
        self.assertEqual(verdict(too_deep), 2)

    def test_a_hostile_construct_at_the_deepest_allowed_level_is_found(self):
        # HOSTILE's own backtick body is one more level, so d - 1 wrappers reach exactly MAX_NEST levels.
        d = lib.MAX_NEST - 1
        cmd = 'echo "$(' * d + self.HOSTILE + ')"' * d
        self.assertEqual([r for r, _ in lib.findings(cmd)], ["E_BACKTICK_IN_DQ"])
        self.assertEqual(verdict(cmd), 2)

    def test_body_text_budget(self):
        body = "a" * 30000
        times = lib.MAX_BODY_CHARS // 30000
        self.assertEqual(self.findings_or_unreadable(('echo "$(%s)" ' % body) * times), [])
        self.assertEqual(self.findings_or_unreadable(('echo "$(%s)" ' % body) * (times + 2)), "unreadable")

    def test_body_text_budget_exact_edge(self):
        n = lib.MAX_BODY_CHARS
        self.assertEqual(self.findings_or_unreadable('echo "$(' + "a" * n + ')"'), [])
        self.assertEqual(self.findings_or_unreadable('echo "$(' + "a" * (n + 1) + ')"'), "unreadable")

    def test_nesting_one_level_past_the_limit_is_unreadable(self):
        d = lib.MAX_NEST + 1
        self.assertEqual(self.findings_or_unreadable('echo "$(' * d + "x" + ')"' * d), "unreadable")

    def test_the_budget_is_per_call(self):
        for _ in range(3):
            self.assertEqual(self.findings_or_unreadable('echo "$(a)" ' * lib.MAX_BODIES), [])

    def _after(self, cmd, elapsed):
        reads = []

        def fake_monotonic():
            reads.append(1)
            return 5000.0 if len(reads) == 1 else 5000.0 + elapsed

        with patch.object(lib.time, "monotonic", fake_monotonic):
            return self.findings_or_unreadable(cmd)

    def test_inspection_deadline_boundary(self):
        cmd = 'echo "$(a)"'
        limit = lib.INSPECT_SECONDS
        self.assertEqual(self._after(cmd, 0.0), [])
        self.assertEqual(self._after(cmd, limit - 0.5), [])
        self.assertEqual(self._after(cmd, limit), [], "exactly at the deadline is not past it")
        self.assertEqual(self._after(cmd, limit + 0.001), "unreadable")

    def test_inspection_deadline_leaves_margin_in_the_hook_timeout(self):
        self.assertLessEqual(lib.INSPECT_SECONDS, 5.0)
        self.assertGreaterEqual(lib.INSPECT_SECONDS, 3.5)
        self.assertEqual(self._after('echo "$(a)"', 5.0), "unreadable")

    def test_limit_values_match_the_destructive_gate(self):
        spec = importlib.util.spec_from_file_location("dg", os.path.join(HOOKS, "destructive-gate.py"))
        dg = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dg)
        self.assertEqual((lib.MAX_CMD_CHARS, lib.MAX_BODIES, lib.MAX_BODY_CHARS, lib.INSPECT_SECONDS),
                         (dg.MAX_CMD_CHARS, dg.MAX_SUBST_BODIES, dg.MAX_SUBST_CHARS, dg.INSPECT_SECONDS))
        self.assertEqual(lib.MAX_NEST, dg._MAX_NEST)


class TestLinearTime(unittest.TestCase):
    """Hostile inputs at the size cap. A quadratic pattern needs seconds already at 40 kB, so the 2 s ceiling
    separates linear from quadratic (see timing_budget.py)."""

    def check(self, text):
        text = text[:lib.MAX_CMD_CHARS]

        def run():
            try:
                lib.findings(text)
            except lib.Unreadable:
                pass

        t = best_of(run)
        self.assertLess(t, LINEAR_CEILING_SEC, describe(t))

    def test_prompt_expand_prefixes_without_a_close(self):
        self.check("${a[" * 70000)
        self.check(("${" + "a" * 64 + "[" + "b" * 63 + "@P ") * 2000)

    def test_many_backticks_in_dq(self):
        self.check('"' + (BT + "x") * 120000)
        self.check(('"' + BT + 'x" ') * 50000)

    def test_unterminated_quotes_and_backticks(self):
        self.check('"' * 250000)
        self.check(BT * 250000)
        self.check("'" * 250000)
        self.check("$(" * 250000)

    def test_many_heredocs(self):
        self.check("cat <<A <<B <<C\n" * 15000)
        self.check("cat <<EOF\n" + (BT + "x") * 100000)

    def test_dq_inside_substitutions(self):
        self.check('echo "$(echo "$(echo "' * 30000)
        self.check('"$(' * 80000)

    def test_backslash_runs(self):
        self.check("\\" * 250000)
        self.check('"' + "\\" * 250000)


if __name__ == "__main__":
    unittest.main()
