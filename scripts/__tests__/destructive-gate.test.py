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
import json
import os
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

    def _run_hook_with_fake_tmux(self, stdin_data: str, session_name, main_agent_id: str = "coord"):
        """Runs the real hook via subprocess with a fake `tmux` on PATH so the
        coordinator-push-exemption can be exercised end-to-end without
        depending on (or colliding with) a real tmux server -- including when
        these tests themselves run inside the real coordinator's own tmux
        session, where the ambient environment would otherwise make the gate
        genuinely (and correctly) exempt the push. session_name=None makes the
        fake tmux fail (returncode 1), simulating "no tmux server"."""
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


class TestCoordinatorTmuxSessionUnit(unittest.TestCase):
    """Direct unit coverage of _is_coordinator_tmux_session(), independent of
    a real tmux binary."""

    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_matches_own_channels_session(self, _main_id, mock_subprocess):
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "coord-channels\n"
        self.assertTrue(hook._is_coordinator_tmux_session())

    @patch.object(hook, "subprocess")
    @patch.object(hook.ledger_lib, "main_agent_id", return_value="coord")
    def test_rejects_subagent_session(self, _main_id, mock_subprocess):
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = "agent-zack\n"
        self.assertFalse(hook._is_coordinator_tmux_session())

    @patch.object(hook, "subprocess")
    def test_fails_closed_on_nonzero_returncode(self, mock_subprocess):
        mock_subprocess.run.return_value.returncode = 1
        mock_subprocess.run.return_value.stdout = ""
        self.assertFalse(hook._is_coordinator_tmux_session())

    @patch.object(hook, "subprocess")
    def test_fails_closed_on_exception(self, mock_subprocess):
        mock_subprocess.run.side_effect = FileNotFoundError("no tmux binary")
        self.assertFalse(hook._is_coordinator_tmux_session())


if __name__ == "__main__":
    unittest.main()
