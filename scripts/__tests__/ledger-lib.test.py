#!/usr/bin/env python3
"""Unit tests for scripts/hooks/ledger_lib.py's main_agent_id().

#927: main_agent_id() resolves MAIN_AGENT_ID env -> <install>/.env ->
hardcoded "marveen", but the third arm used to be silent. On a renamed
install running from an environment where the env var is unset AND .env is
unreadable (e.g. a worktree without the install's .env alongside it), the
function would quietly resolve to the wrong id -- a caller like the
destructive-gate coordinator-allowlist then compares against the wrong name
with nothing in the logs to explain a resulting misjudgement. These tests
pin: the env and .env arms still return their value with no warning, and the
fallback arm still returns "marveen" (behavior unchanged) but now also
writes a stderr warning naming the resolved fallback.
"""
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "ledger_lib.py",
)

_spec = importlib.util.spec_from_file_location("ledger_lib", _HOOK_PATH)
ledger_lib = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(ledger_lib)  # type: ignore[union-attr]


class TestMainAgentId(unittest.TestCase):
    def test_env_var_wins_no_warning(self):
        with patch.dict(os.environ, {"MAIN_AGENT_ID": "renamed-agent"}, clear=False):
            buf = io.StringIO()
            with redirect_stderr(buf):
                self.assertEqual(ledger_lib.main_agent_id(), "renamed-agent")
            self.assertEqual(buf.getvalue(), "")

    def test_env_file_wins_when_env_var_absent_no_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, ".env"), "w") as f:
                f.write("SOME_OTHER_KEY=x\nMAIN_AGENT_ID=from-dotenv\n")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MAIN_AGENT_ID", None)
                with patch.object(ledger_lib, "_install_dir", return_value=tmp):
                    buf = io.StringIO()
                    with redirect_stderr(buf):
                        self.assertEqual(ledger_lib.main_agent_id(), "from-dotenv")
                    self.assertEqual(buf.getvalue(), "")

    def test_silent_fallback_now_warns_on_stderr_but_keeps_returning_marveen(self):
        with tempfile.TemporaryDirectory() as tmp:
            # No .env file at all in this install dir, and no env var.
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MAIN_AGENT_ID", None)
                with patch.object(ledger_lib, "_install_dir", return_value=tmp):
                    buf = io.StringIO()
                    with redirect_stderr(buf):
                        result = ledger_lib.main_agent_id()
                    self.assertEqual(result, "marveen")
                    self.assertIn("MAIN_AGENT_ID", buf.getvalue())
                    self.assertIn("marveen", buf.getvalue())

    def test_unreadable_env_file_also_warns_and_falls_back(self):
        # A .env that exists but has no MAIN_AGENT_ID line -- same silent-
        # before, now-warned fallback arm as a missing .env entirely.
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, ".env"), "w") as f:
                f.write("SOME_OTHER_KEY=x\n")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MAIN_AGENT_ID", None)
                with patch.object(ledger_lib, "_install_dir", return_value=tmp):
                    buf = io.StringIO()
                    with redirect_stderr(buf):
                        result = ledger_lib.main_agent_id()
                    self.assertEqual(result, "marveen")
                    self.assertIn("MAIN_AGENT_ID", buf.getvalue())

    def test_fallback_never_raises(self):
        # Hooks depend on this fallback firing cleanly -- an exception here
        # would break every caller that relies on the "marveen" default.
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MAIN_AGENT_ID", None)
                with patch.object(ledger_lib, "_install_dir", return_value=tmp):
                    with redirect_stderr(io.StringIO()):
                        try:
                            ledger_lib.main_agent_id()
                        except Exception as e:  # pragma: no cover - failure path
                            self.fail(f"main_agent_id() raised unexpectedly: {e}")


if __name__ == "__main__":
    unittest.main()
