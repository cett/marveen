#!/usr/bin/env python3
"""Unit tests for the token source of scripts/voice/_vtools.py.

The dashboard server hands the bot token over in MARVEEN_CHANNEL_BOT_TOKEN and passes "-" in the
state_dir slot, so the server path never reads a channel directory an agent can write. A hand run of
stt.sh / tts.sh (no env) still reads <state_dir>/.env.

Privacy: only made-up token strings and temp directories.
"""
import importlib.util
import os
import shutil
import tempfile
import unittest

_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "voice", "_vtools.py",
)
_spec = importlib.util.spec_from_file_location("_vtools", _PATH)
vt = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(vt)  # type: ignore[union-attr]

ENV_NAME = "MARVEEN_CHANNEL_BOT_TOKEN"
FILE_TOKEN = "111111111:FILE-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SERVER_TOKEN = "222222222:SERVER-token-bbbbbbbbbbbbbbbbbbbbbbbbb"


class TokenSource(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vtools-")
        with open(os.path.join(self.dir, ".env"), "w") as f:
            f.write("TELEGRAM_BOT_TOKEN=%s\n" % FILE_TOKEN)
        self._saved = os.environ.pop(ENV_NAME, None)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        os.environ.pop(ENV_NAME, None)
        if self._saved is not None:
            os.environ[ENV_NAME] = self._saved

    def test_hand_run_reads_the_state_dir_env_file(self):
        self.assertEqual(vt._token(self.dir), FILE_TOKEN)

    def test_server_path_uses_the_environment_and_ignores_the_file(self):
        os.environ[ENV_NAME] = SERVER_TOKEN
        # the file in the named dir carries another token; the environment wins
        self.assertEqual(vt._token(self.dir), SERVER_TOKEN)

    def test_server_path_with_the_placeholder_dir_never_touches_a_directory(self):
        os.environ[ENV_NAME] = SERVER_TOKEN
        self.assertEqual(vt._token("-"), SERVER_TOKEN)

    def test_placeholder_dir_without_the_environment_fails_closed(self):
        # no token handed over: nothing to fall back to, the call errors instead of reading some file
        with self.assertRaises(OSError):
            vt._token("-")

    def test_blank_environment_value_is_not_a_token(self):
        os.environ[ENV_NAME] = "   "
        self.assertEqual(vt._token(self.dir), FILE_TOKEN)

    def test_venv_python_is_named_by_the_server(self):
        self.assertTrue(vt.VENV_PY.endswith(os.path.join("bin", "python")) or os.environ.get("VOICE_VENV_PY"))


if __name__ == "__main__":
    unittest.main()
