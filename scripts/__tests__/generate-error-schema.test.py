"""
Tests for scripts/generate-error-schema.mjs.

Runs the generator against a minimal synthetic src/api-error-catalog.ts +
docs/openapi.yaml pair in an isolated temp directory (mirrors the
generate-sdk.test.py hermetic pattern) -- the real repo files are never
touched.
"""

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

REPO_ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
GENERATOR = os.path.join(REPO_ROOT, 'scripts', 'generate-error-schema.mjs')

CATALOG_TS = textwrap.dedent("""\
    export const ERROR_TOKENS = [
      'not_found',
      'invalid_value',
      'internal_error',
    ] as const
""")

SPEC_YAML = textwrap.dedent("""\
    openapi: 3.1.0
    info:
      title: Test API
      version: 0.1.0
    paths: {}
    components:
      schemas:
        Error:
          type: object
          required: [error]
          properties:
            error:
              type: string
              description: >-
                Machine-readable snake_case error token.
              enum:
                - not_found
            hint:
              type: string
              description: Optional debugging note.
""")


def run_generator_in(tmp_dir: str) -> str:
    """Run the generator with cwd=tmp_dir (its I/O paths are relative to cwd)."""
    result = subprocess.run(
        ['node', GENERATOR],
        cwd=tmp_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f'Generator failed:\nstdout: {result.stdout}\nstderr: {result.stderr}')
    with open(os.path.join(tmp_dir, 'docs', 'openapi.yaml')) as f:
        return f.read()


class TestGenerateErrorSchema(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, 'src'))
        os.makedirs(os.path.join(self.tmp, 'docs'))
        with open(os.path.join(self.tmp, 'src', 'api-error-catalog.ts'), 'w') as f:
            f.write(CATALOG_TS)
        with open(os.path.join(self.tmp, 'docs', 'openapi.yaml'), 'w') as f:
            f.write(SPEC_YAML)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_enum_updated_from_catalog(self):
        out = run_generator_in(self.tmp)
        self.assertIn('- not_found', out)
        self.assertIn('- invalid_value', out)
        self.assertIn('- internal_error', out)

    def test_no_blank_line_inserted_before_next_property(self):
        """The enum block must be followed directly by `hint:`, no blank line."""
        out = run_generator_in(self.tmp)
        self.assertIn('- internal_error\n        hint:', out)

    def test_idempotent_on_clean_input(self):
        """Running the generator twice in a row must produce byte-identical output."""
        first = run_generator_in(self.tmp)
        second = run_generator_in(self.tmp)
        self.assertEqual(first, second)

    def test_idempotent_does_not_grow_when_already_dirty(self):
        """A pre-existing blank-line gap (as if from an old buggy run) must not
        keep growing on further runs -- it converges to a stable output."""
        dirty = SPEC_YAML.replace(
            '                - not_found\n            hint:',
            '                - not_found\n\n\n\n            hint:',
        )
        with open(os.path.join(self.tmp, 'docs', 'openapi.yaml'), 'w') as f:
            f.write(dirty)
        first = run_generator_in(self.tmp)
        second = run_generator_in(self.tmp)
        self.assertEqual(first, second, 'a second run must not add another blank line')


if __name__ == '__main__':
    unittest.main(verbosity=2)
