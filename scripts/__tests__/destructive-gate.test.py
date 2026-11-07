#!/usr/bin/env python3
"""Unit tests for scripts/hooks/destructive-gate.py.

Covers the pure-logic helpers (scannable, segments, command_index) directly
against the false-positive shapes upstream measured (heredoc body written to
a file vs. handed to an interpreter, quoted prose containing whitespace,
shell comments), plus main()'s exit-code contract via subprocess
(0=allow, 2=block) for the Bash and file-tool branches, wrapper-transparency,
the fail-closed behavior on malformed input or an internal error, and the
coordinator-only git-push exemption (tmux session name, not cwd -- a shared
worktree cwd is not enough to tell the coordinator and a sub-agent apart).

Privacy: only neutral fixture data; no real agent names, tokens, or chat IDs.
"""
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "destructive-gate.py",
)

_spec = importlib.util.spec_from_file_location("destructive_gate", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]


class TestScannable(unittest.TestCase):
    """The context-sensitive scanner: which part of a command actually runs."""

    def test_data_heredoc_body_is_blanked(self):
        cmd = 'cat > /tmp/x <<EOF\nrm -rf /\nEOF'
        self.assertNotIn('rm -rf', hook.scannable(cmd))

    def test_interpreter_heredoc_body_stays_in_scope(self):
        # A python3 heredoc body EXECUTES -- must remain scannable, or a real
        # credential-file read hides behind it (upstream's own measured case).
        cmd = "python3 - <<PY\nopen('/root/.ssh/id_rsa').read()\nPY"
        self.assertIn('.ssh', hook.scannable(cmd))

    def test_shell_comment_line_is_blanked(self):
        cmd = '# this comment mentions rm -rf as an example\necho hi'
        self.assertNotIn('rm -rf', hook.scannable(cmd))

    def test_quoted_prose_with_whitespace_is_blanked(self):
        # A message body / test description containing "rm -rf" is not a
        # command -- it is data being passed as an argument.
        cmd = 'echo "incident note: someone ran rm -rf by mistake"'
        self.assertNotIn('rm -rf', hook.scannable(cmd))

    def test_quoted_path_without_whitespace_stays_in_scope(self):
        cmd = 'rm "/tmp/no-space-path"'
        self.assertIn('rm', hook.scannable(cmd))

    def test_command_substitution_inside_quotes_stays_in_scope(self):
        # $(...) inside a shell string still executes -- must not be treated
        # as prose, or a real assignment like this would be missed.
        cmd = 'PORT="$(cat /etc/port)"; rm -rf "$PORT"'
        self.assertIn('rm', hook.scannable(cmd))


class TestSegmentsAndCommandIndex(unittest.TestCase):
    def test_pipe_inside_quoted_pattern_does_not_split(self):
        segs = hook.segments('grep "foo|bar" file.txt')
        self.assertEqual(len(segs), 1)

    def test_semicolon_splits_segments(self):
        segs = hook.segments('echo a; echo b')
        self.assertEqual(len(segs), 2)

    def test_command_index_sees_through_env_assignment(self):
        toks = hook._bare_tokens('FOO=bar rm -rf /tmp/x')
        idx = hook.command_index(toks)
        self.assertEqual(toks[idx][0], 'rm')

    def test_command_index_sees_through_xargs_wrapper(self):
        toks = hook._bare_tokens('xargs -I {} rm {}')
        idx = hook.command_index(toks)
        self.assertEqual(toks[idx][0], 'rm')

    def test_command_index_sees_through_timeout_with_numeric_arg(self):
        toks = hook._bare_tokens('timeout 5 rm /tmp/x')
        idx = hook.command_index(toks)
        self.assertEqual(toks[idx][0], 'rm')

    def test_quoted_word_with_whitespace_is_not_a_command_name(self):
        # "test case: rm -rf" is a string argument, not two tokens naming a
        # command -- command_index still finds echo as the real command.
        toks = hook._bare_tokens('echo "test case: rm -rf"')
        idx = hook.command_index(toks)
        self.assertEqual(toks[idx][0], 'echo')


class TestMainExitCodes(unittest.TestCase):
    """main()'s exit-code contract via subprocess: 0=allow, 2=block."""

    def _run_hook(self, stdin_data: str):
        r = subprocess.run(
            [sys.executable, _HOOK_PATH],
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return r.returncode, r.stderr

    def _payload(self, **overrides):
        base = {
            "tool_name": "Bash",
            "tool_input": {"command": "echo hello"},
            "cwd": "/tmp/agents/agent-a",
        }
        base.update(overrides)
        return json.dumps(base)

    def _run_hook_with_fake_tmux(self, stdin_data: str, session_name, main_agent_id: str = "coord",
                                  push_env: str = None):
        """Runs the real hook via subprocess with a fake `tmux` on PATH so the
        coordinator-push-exemption can be exercised end-to-end without
        depending on (or colliding with) a real tmux server -- including when
        these tests themselves run inside the real coordinator's own tmux
        session, where the ambient environment would otherwise make the gate
        genuinely (and correctly) exempt the push. session_name=None makes the
        fake tmux fail (returncode 1), simulating "no tmux server".

        push_env mirrors the same ambient-environment concern for the second
        (env-var) exemption path: once channels.sh exports
        MARVEEN_COORDINATOR_PUSH_ALLOWED=1, these tests may themselves be
        running inside a process that inherited it, which would silently
        make every "should block" case pass for the wrong reason. Default
        (None) explicitly clears it so each test exercises exactly the path
        it names; pass "1" to test the env-var grant itself."""
        with tempfile.TemporaryDirectory() as d:
            fake_tmux = os.path.join(d, "tmux")
            if session_name is None:
                body = "#!/bin/sh\nexit 1\n"
            else:
                body = "#!/bin/sh\necho %s\n" % session_name
            with open(fake_tmux, "w") as f:
                f.write(body)
            os.chmod(fake_tmux, 0o755)
            env = dict(os.environ)
            env["PATH"] = d + os.pathsep + env.get("PATH", "")
            env["MAIN_AGENT_ID"] = main_agent_id
            if push_env is None:
                env.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
            else:
                env["MARVEEN_COORDINATOR_PUSH_ALLOWED"] = push_env
            r = subprocess.run(
                [sys.executable, _HOOK_PATH],
                input=stdin_data,
                capture_output=True,
                text=True,
                timeout=10,
                env=env,
            )
            return r.returncode, r.stderr

    def test_harmless_command_allows(self):
        code, _ = self._run_hook(self._payload())
        self.assertEqual(code, 0)

    def test_bare_rm_blocks(self):
        code, stderr = self._run_hook(self._payload(tool_input={"command": "rm -rf /tmp/x"}))
        self.assertEqual(code, 2)
        self.assertIn("BLOKKOLVA", stderr)

    def test_mv_blocks(self):
        code, _ = self._run_hook(self._payload(tool_input={"command": "mv /tmp/a /tmp/b"}))
        self.assertEqual(code, 2)

    def test_sudo_blocks(self):
        code, _ = self._run_hook(self._payload(tool_input={"command": "sudo apt install x"}))
        self.assertEqual(code, 2)

    def test_git_push_blocks(self):
        # Deterministic regardless of the REAL environment these tests run in
        # (including inside the coordinator's own tmux session) -- forces a
        # sub-agent-shaped session name via a fake tmux on PATH.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="agent-someone",
        )
        self.assertEqual(code, 2)

    def test_git_commit_allows(self):
        # Committing is allowed -- only pushing to the shared repo is not.
        code, _ = self._run_hook(self._payload(tool_input={"command": "git commit -m 'x'"}))
        self.assertEqual(code, 0)

    def test_git_push_allows_from_coordinator_channels_session(self):
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="coord-channels",
        )
        self.assertEqual(code, 0)

    def test_git_push_blocks_from_subagent_tmux_session(self):
        code, stderr = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="agent-zack",
        )
        self.assertEqual(code, 2)
        self.assertIn("BLOKKOLVA", stderr)

    def test_git_push_blocks_when_tmux_unavailable(self):
        # Fail-closed: no positive proof of the coordinator session -> still denied.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name=None,
        )
        self.assertEqual(code, 2)

    def test_rm_still_blocks_inside_coordinator_channels_session(self):
        # The exemption is scoped to git push only -- irreversible commands
        # stay banned for the coordinator too.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "rm -rf /tmp/x"}),
            session_name="coord-channels",
        )
        self.assertEqual(code, 2)

    def test_git_push_allows_from_coordinator_worker_session(self):
        # The coordinator's own background task worker (agent-worker.ts
        # ctxSlow, "<main_id>-worker") is the same process as the channels
        # session, not a sub-agent -- it must be exempt too.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="coord-worker",
        )
        self.assertEqual(code, 0)

    def test_git_push_allows_from_coordinator_worker_fast_session(self):
        # Same as above for the fast worker (ctxFast, "<main_id>-worker-fast").
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="coord-worker-fast",
        )
        self.assertEqual(code, 0)

    def test_git_push_allows_from_agent_prefixed_session_matching_main_id(self):
        # "agent-<name>" is the generic sub-agent session template
        # (agentSessionName() in agent-process-session.ts), but at least one
        # install runs its actual coordinator under "agent-<main_id>"
        # (independently confirmed live via tmux, 2026-09-15-). Allowing this
        # ONE exact string is safe: only the main agent's own id can produce
        # it, so "agent-<any-other-name>" (every real sub-agent) is untouched.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="agent-coord",
        )
        self.assertEqual(code, 0)

    def test_git_push_allows_via_env_var_from_a_subagent_shaped_session(self):
        # Documented accepted limit: MARVEEN_COORDINATOR_PUSH_ALLOWED=1 grants
        # regardless of session name. In practice only channels.sh exports
        # it, so a sub-agent would have to forge the env var into its own
        # process to reach this -- same threat model as spoofing the tmux
        # session name (governs cooperating agents, not a determined bypass).
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="agent-zack",
            push_env="1",
        )
        self.assertEqual(code, 0)

    def test_git_push_blocks_when_env_var_is_not_exactly_the_string_one(self):
        # Strict equality, not truthiness -- "true"/"yes"/"" must not grant.
        code, _ = self._run_hook_with_fake_tmux(
            self._payload(tool_input={"command": "git push origin main"}),
            session_name="agent-zack",
            push_env="true",
        )
        self.assertEqual(code, 2)

    def test_rm_inside_heredoc_body_written_to_file_allows(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": "cat > /tmp/script.sh <<EOF\nrm -rf /\nEOF"},
        ))
        self.assertEqual(code, 0)

    def test_rm_mentioned_in_comment_allows(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": "# note: rm -rf is dangerous\necho ok"},
        ))
        self.assertEqual(code, 0)

    def test_rm_in_quoted_prose_allows(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": 'echo "post-mortem: rm -rf ran here by accident"'},
        ))
        self.assertEqual(code, 0)

    def test_ssh_dir_read_blocks(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": "cat ~/.ssh/id_rsa"},
        ))
        self.assertEqual(code, 2)

    def test_dotenv_read_blocks(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": "cat .env"},
        ))
        self.assertEqual(code, 2)

    def test_xargs_rm_wrapper_blocks(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": "find /tmp -name '*.tmp' | xargs rm"},
        ))
        self.assertEqual(code, 2)

    def test_bash_dash_c_wrapped_rm_blocks(self):
        code, _ = self._run_hook(self._payload(
            tool_input={"command": 'bash -c "rm -rf /tmp/x"'},
        ))
        self.assertEqual(code, 2)

    def test_read_tool_ssh_path_blocks(self):
        code, _ = self._run_hook(self._payload(
            tool_name="Read",
            tool_input={"file_path": os.path.expanduser("~/.ssh/config")},
        ))
        self.assertEqual(code, 2)

    def test_read_tool_ordinary_path_allows(self):
        code, _ = self._run_hook(self._payload(
            tool_name="Read",
            tool_input={"file_path": "/tmp/notes.md"},
        ))
        self.assertEqual(code, 0)

    def test_invalid_json_stdin_blocks_fail_closed(self):
        code, _ = self._run_hook("not-json")
        self.assertEqual(code, 2)

    def test_empty_stdin_blocks_fail_closed(self):
        code, _ = self._run_hook("")
        self.assertEqual(code, 2)

    def test_missing_tool_input_allows(self):
        code, _ = self._run_hook(self._payload(tool_input=None))
        self.assertEqual(code, 0)


class TestCoordinatorPushAllowedUnit(unittest.TestCase):
    """Direct unit coverage of _is_coordinator_push_allowed(), independent of
    a real tmux binary. os.environ is cleared of the grant var by default in
    every test that doesn't explicitly set it, for the same ambient-
    environment reason _run_hook_with_fake_tmux above clears it: the process
    running these tests may itself be a coordinator session that inherited
    MARVEEN_COORDINATOR_PUSH_ALLOWED=1 once channels.sh exports it."""

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_matches_own_channels_session(self, _main_id, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "coord-channels\n"
        self.assertTrue(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_matches_worker_session(self, _main_id, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "coord-worker\n"
        self.assertTrue(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_matches_worker_fast_session(self, _main_id, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "coord-worker-fast\n"
        self.assertTrue(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_rejects_subagent_session(self, _main_id, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "agent-zack\n"
        self.assertFalse(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_matches_agent_prefixed_session_when_name_equals_main_id(self, _main_id, mock_subprocess):
        # "agent-coord" is the generic sub-agent template, but at least one
        # install runs its real coordinator under exactly this session
        # (independently confirmed live). Allowed because "coord" here is
        # literally the main agent's own id -- the set is an exact-match
        # allowlist, not a prefix/suffix check, so "agent-<anything-else>"
        # is a completely different string and stays blocked (see below).
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "agent-coord\n"
        self.assertTrue(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    def test_fails_closed_on_nonzero_returncode(self, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.return_value.returncode = 1
        mock_subprocess.run.return_value.stdout = ""
        self.assertFalse(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {}, clear=False)
    @patch.object(hook, "subprocess")
    def test_fails_closed_on_exception(self, mock_subprocess):
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        mock_subprocess.run.side_effect = FileNotFoundError("no tmux binary")
        self.assertFalse(hook._is_coordinator_push_allowed())

    @patch.dict(os.environ, {"MARVEEN_COORDINATOR_PUSH_ALLOWED": "1"}, clear=False)
    @patch.object(hook, "subprocess")
    def test_env_var_grants_without_even_checking_tmux(self, mock_subprocess):
        self.assertTrue(hook._is_coordinator_push_allowed())
        mock_subprocess.run.assert_not_called()

    @patch.dict(os.environ, {"MARVEEN_COORDINATOR_PUSH_ALLOWED": "yes"}, clear=False)
    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_env_var_wrong_value_falls_through_to_session_check(self, _main_id, mock_subprocess):
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "agent-zack\n"
        self.assertFalse(hook._is_coordinator_push_allowed())


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timing_budget import CUTOFF_SEC, LINEAR_CEILING_SEC, best_of, describe  # noqa: E402


class TestCommandSubstitution(unittest.TestCase):
    """A command substitution RUNS, also inside double quotes. The segment splitter keeps quoted
    text together (right for a grep pattern), so before the bodies were read, `echo "$(rm x)"` was
    one `echo` and passed."""

    X = "rm -rf /private/tmp/claude-501/probe-nonexistent-dir"

    def setUp(self):
        # check_bash() runs in this process, so its coordinator-push exemption reads THIS process's environment and
        # tmux session. Run from the coordinator's own session (env grant exported, or tmux session name matching) the
        # `git push` shape below would be exempt and the case would fail for a reason that has nothing to do with the
        # substitution scanner. Start every test with no grant and no tmux; the grant tests set what they need.
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("MARVEEN_COORDINATOR_PUSH_ALLOWED", None)
        tmux = patch.object(hook, "subprocess")
        self.mock_subprocess = tmux.start()
        self.addCleanup(tmux.stop)
        self.mock_subprocess.run.return_value.returncode = 1
        self.mock_subprocess.run.return_value.stdout = ""

    def _verdict(self, cmd):
        with patch.object(hook, "_notify_block"):
            try:
                hook.check_bash(cmd)
            except SystemExit as e:
                return e.code
        return 0

    def test_a_git_push_in_a_substitution_is_blocked_without_the_grant(self):
        self.assertNotIn("MARVEEN_COORDINATOR_PUSH_ALLOWED", os.environ)
        self.assertEqual(self._verdict('echo "$(git push origin main)"'), 2)
        self.assertEqual(self._verdict("git push origin main"), 2)

    def test_the_tests_own_grant_lets_the_same_push_through(self):
        # The other direction: the isolation above is what makes the block meaningful, and the grant is the only
        # thing that changes the verdict (the exemption is the coordinator's, so it applies inside a substitution too).
        os.environ["MARVEEN_COORDINATOR_PUSH_ALLOWED"] = "1"
        self.assertEqual(self._verdict("git push origin main"), 0)
        self.assertEqual(self._verdict('echo "$(git push origin main)"'), 0)
        # A grant does not exempt anything else in the same command.
        self.assertEqual(self._verdict('echo "$(git push origin main; %s)"' % self.X), 2)

    def test_runs_shapes_block(self):
        x = self.X
        for name, cmd in (
            ("dq $()", 'echo "$(%s)"' % x),
            ("dq backtick", 'echo "`%s`"' % x),
            ("dq $() with text", 'echo "r: $(%s) done"' % x),
            ("assignment", 'v="$(%s)"; echo ok' % x),
            ("nested dq", 'echo "$(echo "$(%s)")"' % x),
            ("unquoted heredoc", "cat <<EOF\n$(%s)\nEOF\n" % x),
            ("process substitution", "diff <(%s) /dev/null" % x),
            ("mv", 'echo "$(mv a b)"'),
            ("sudo", 'echo "$(sudo ls)"'),
            ("git push", 'echo "$(git push origin main)"'),
            ("inside bash -c", "bash -c 'echo \"$(%s)\"'" % x),
            ("credential path", 'echo "$(cat /home/probe-nonexistent/.ssh/id_probe)"'),
            ("env file", 'echo "$(cat app/.env)"'),
        ):
            with self.subTest(name):
                self.assertEqual(self._verdict(cmd), 2, cmd)

    def test_text_shapes_pass(self):
        x = self.X
        for name, cmd in (
            ("single quotes", "echo '$(%s)'" % x),
            ("quoted heredoc", "cat <<'EOF'\n$(%s)\nEOF\n" % x),
            ("escaped marker", 'echo "\\$(%s)"' % x),
            ("commit message heredoc", "git commit -m \"$(cat <<'EOF'\nfix: rm -rf was discussed\nEOF\n)\""),
            ("plain substitutions", 'echo "$(date)" `pwd` "$(git rev-parse HEAD)"'),
            ("pipe inside a grep pattern in a body", 'echo "$(grep -E "a|b" file)"'),
        ):
            with self.subTest(name):
                self.assertEqual(self._verdict(cmd), 0, cmd)

    def test_limits_fail_closed(self):
        n = hook.MAX_SUBST_BODIES
        self.assertEqual(self._verdict('echo "$(a)" ' * n), 0)
        self.assertEqual(self._verdict('echo "$(a)" ' * (n + 1)), 2)
        d = hook._MAX_NEST
        self.assertEqual(self._verdict('echo "$(' * d + "x" + ')"' * d), 0)
        self.assertEqual(self._verdict('echo "$(' * (d + 2) + "x" + ')"' * (d + 2)), 2)
        cap = hook.MAX_CMD_CHARS
        self.assertEqual(self._verdict("echo " + "a" * (cap - 5)), 0)
        self.assertEqual(self._verdict("echo " + "a" * (cap - 4)), 2)
        body = "a" * 30000
        self.assertEqual(self._verdict(('echo "$(%s)" ' % body) * (hook.MAX_SUBST_CHARS // 30000 + 1)), 2)

    def test_blank_substitutions_cannot_hide_a_real_one_past_the_limit(self):
        n = hook.MAX_SUBST_BODIES
        self.assertEqual(self._verdict('echo "$()" ' * n + 'echo "$(rm -rf /private/tmp/claude-501/probe-nonexistent-dir)"'), 2)
        self.assertEqual(self._verdict('echo "$()" ' * (n + 5) + "x"), 2)

    def test_budget_is_per_call(self):
        for _ in range(3):
            self.assertEqual(self._verdict('echo "$(a)" ' * hook.MAX_SUBST_BODIES), 0)

    def _verdict_and_stderr(self, cmd):
        err = io.StringIO()
        with patch.object(sys, "stderr", err):
            code = self._verdict(cmd)
        return code, err.getvalue()

    def test_a_blown_deadline_denies_instead_of_passing(self):
        # The wall-clock deadline is the last guard behind the character and body caps: if the reading
        # of the bodies has taken longer than INSPECT_SECONDS, the gate refuses rather than guess.
        # A deadline in the past makes the first non-blank body trip it, so the check is exercised
        # without a 4 s sleep. The control proves the denial comes from the deadline, not from the input.
        cmd = 'echo "$(a)"'
        self.assertEqual(self._verdict(cmd), 0)
        with patch.object(hook, "INSPECT_SECONDS", -1.0):
            code, err = self._verdict_and_stderr(cmd)
        self.assertEqual(code, 2)
        self.assertIn("tul sokaig tart", err)

    def test_the_deadline_is_reset_per_call(self):
        with patch.object(hook, "INSPECT_SECONDS", -1.0):
            self.assertEqual(self._verdict('echo "$(a)"'), 2)
        self.assertEqual(self._verdict('echo "$(a)"'), 0)

    def test_the_deadline_leaves_the_hook_timeout_a_margin(self):
        # The harness kills a gate at 10 s; past that a hook without onFailure would let the call through.
        self.assertGreater(hook.INSPECT_SECONDS, 0)
        self.assertLessEqual(hook.INSPECT_SECONDS, 5.0)

    def _verdict_after(self, cmd, elapsed):
        """Verdict and stderr when the clock reads `elapsed` seconds more at the first body check than
        it did when the call's deadline was set (the first monotonic() call of the call)."""
        import contextlib
        import io
        reads = []

        def fake_monotonic():
            reads.append(1)
            return 5000.0 if len(reads) == 1 else 5000.0 + elapsed

        err = io.StringIO()
        with patch.object(hook, "_notify_block"), patch.object(hook.time, "monotonic", fake_monotonic), \
                contextlib.redirect_stderr(err):
            try:
                hook.check_bash(cmd)
                code = 0
            except SystemExit as e:
                code = e.code
        return code, err.getvalue()

    def test_inspection_deadline_boundary(self):
        # The deadline branch (G4): past INSPECT_SECONDS the gate denies, at it and before it does not.
        # A fake clock pins all three sides, so the strict `>`, the constant and the denial itself are
        # each held by a failing assertion (a swapped `>=`, a doubled constant and a removed branch all die).
        cmd = 'echo "$(a)"'
        limit = hook.INSPECT_SECONDS
        self.assertEqual(self._verdict_after(cmd, 0.0)[0], 0)
        self.assertEqual(self._verdict_after(cmd, limit - 0.5)[0], 0)
        self.assertEqual(self._verdict_after(cmd, limit)[0], 0, "exactly at the deadline is not past it")
        code, err = self._verdict_after(cmd, limit + 0.001)
        self.assertEqual(code, 2)
        self.assertIn("tul sokaig", err)

    def test_inspection_deadline_leaves_margin_in_the_hook_timeout(self):
        # The harness gives a gate 10 s; the deadline must fire well before that or it is no protection.
        self.assertLessEqual(hook.INSPECT_SECONDS, 5.0)
        self.assertEqual(self._verdict_after('echo "$(a)"', 5.0)[0], 2)
        # ... and not so short that a slow but honest call is refused: the documented value is 4 s.
        self.assertGreaterEqual(hook.INSPECT_SECONDS, 3.5)

    def test_over_the_cap_is_denied_through_the_hook_entrypoint(self):
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo " + "a" * (hook.MAX_CMD_CHARS + 10)},
                              "cwd": "/tmp/agents/agent-a"})
        r = subprocess.run([sys.executable, _HOOK_PATH], input=payload, capture_output=True, text=True, timeout=20,
                           env=dict(os.environ, WEB_PORT="9"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("tul nagy", r.stderr)


class TestEnvScanEquivalence(unittest.TestCase):
    """_env_file_mentioned() replaced a regex that was quadratic; on any text it must say what the regex said."""

    REFERENCE = re.compile(r'(?:^|[\s=:])(?:[^\s"\']*/)?\.env(?=$|[\s"\'`,;)\]}])')

    def test_same_verdict_as_the_regex_on_random_text(self):
        import random
        rnd = random.Random(7)
        atoms = [".env", "/", "=", ":", " ", '"', "'", "a", "x/", ".", "e", "n", "v", ";", ")", "]", "}", "`", ",",
                 "\n", "\t", "$", "env"]
        for _ in range(60000):
            s = "".join(rnd.choice(atoms) for _ in range(rnd.randint(0, 14)))
            self.assertEqual(bool(self.REFERENCE.search(s)), hook._env_file_mentioned(s), repr(s))

    def test_known_shapes(self):
        for s, want in (
            (".env", True), ("cat .env", True), ("cat /a/b/.env", True), ("FOO=/a/.env", True),
            ('cat "/a/.env"', False), ("cat .environment", False), ("cat a.env", False),
            ("cat x/.env;", True), ("echo .envrc", False), ("PATH=a:.env", True),
        ):
            with self.subTest(s):
                self.assertEqual(hook._env_file_mentioned(s), want)


class TestLinearTime(unittest.TestCase):
    """The scans of the gate on a hostile command at the size cap. A hook still running at its timeout
    does not block, so a slow scan is a fail-OPEN; the regex that looped on `a=a=a=...` took over a
    minute at this size, and the per-span range lookup took twelve seconds on repeated `bash -c`."""

    SIZE = 250000

    def _timed(self, cmd, cpu=False):
        """cpu=True measures CPU time (timing_budget.best_of): these inputs run into the gate's own budgets (the body
        and character caps, the INSPECT_SECONDS deadline), so on a busy machine the wall time of one call reaches the
        wall cut-off although the work is the same. The wall cut-off is then 3 times wider, as a catastrophe guard."""
        def run():
            with patch.object(hook, "_notify_block"):
                try:
                    hook.check_bash(cmd)
                except SystemExit:
                    pass
        cutoff = CUTOFF_SEC * 3 if cpu else CUTOFF_SEC
        t = best_of(run, cutoff=cutoff, cpu=cpu)
        self.assertLess(t, LINEAR_CEILING_SEC * 2, describe(t, cutoff))

    def test_env_scan(self):
        self._timed("a=" * (self.SIZE // 2))
        self._timed("a=/" * (self.SIZE // 3))
        self._timed(" .en" * (self.SIZE // 4))

    def test_many_quoted_spans_and_script_args(self):
        self._timed('bash -c "a" ' * (self.SIZE // 12))
        self._timed('python3 -c "x" ' * (self.SIZE // 15))
        self._timed('"a" ' * (self.SIZE // 4))

    def test_many_heredocs(self):
        self._timed("cat <<A\n" * (self.SIZE // 8))

    def test_unterminated_substitutions_are_cut_off_by_the_budgets(self):
        for cmd in ("$(" * (self.SIZE // 2), '"$(' * (self.SIZE // 3), "`a" * (self.SIZE // 2)):
            self._timed(cmd, cpu=True)
            # The property is that a budget CUT the scan (the gate refuses what it cannot follow), not how fast
            # that happened: a gate that returned without blocking would be a fail-open.
            with self.subTest(cmd=cmd[:8]):
                with patch.object(hook, "_notify_block"):
                    with self.assertRaises(SystemExit):
                        hook.check_bash(cmd)

    def test_many_bodies(self):
        self._timed('echo "$(a)" ' * (self.SIZE // 12))


if __name__ == "__main__":
    unittest.main()
