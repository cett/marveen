#!/usr/bin/env python3
"""Tests for scripts/log-message-literal-ratchet.py: which warn/error/fatal calls count as building a value into
the message (the application log export sends the message, so the data belongs in the bound fields).

Neutral fixture data only.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'log-message-literal-ratchet.py')
_spec = importlib.util.spec_from_file_location('log_ratchet', SCRIPT)
r = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r)


def hits(src):
    return [line for line, _ in r.scan_text(src)]


class TestDetector(unittest.TestCase):
    def test_a_template_literal_with_a_substitution_counts(self):
        self.assertEqual(hits("logger.warn({ id }, `saved with ${warning}`)"), [1])
        self.assertEqual(hits("logger.error(`failed for ${name}`)"), [1])
        self.assertEqual(hits("logger.fatal({ a: 1 }, `x ${a} y ${b}`)"), [1])

    def test_a_concatenation_with_anything_that_is_not_a_plain_literal_counts(self):
        self.assertEqual(hits("logger.warn({ id }, 'saved with ' + warning)"), [1])
        self.assertEqual(hits("logger.warn('a ' + b + ' c')"), [1])
        self.assertEqual(hits("logger.warn({}, 'fixed text ' + `and ${x}`)"), [1])

    def test_fixed_messages_do_not_count(self):
        for src in (
            "logger.warn({ id }, 'saved with a homoglyph warning')",
            'logger.error("plain double quoted")',
            "logger.warn(`a template without a substitution`)",
            "logger.warn({ id, warning }, 'fixed ' + 'text ' + `more`)",
            "logger.warn({ id }, next ? 'on' : 'off')",
            "logger.info({ id }, `info lines are not exported ${x}`)",
            "logger.debug(`debug ${x}`)",
        ):
            self.assertEqual(hits(src), [], src)

    def test_a_value_in_the_bindings_is_not_the_message(self):
        self.assertEqual(hits("logger.warn({ note: `built ${x}`, other: 'a' + b }, 'fixed message')"), [])

    def test_a_multi_line_call_is_found_with_the_line_of_the_call(self):
        src = "\n\nlogger.warn(\n  { cronTz },\n  `zone ${tz} is not usable`,\n)\n"
        self.assertEqual(hits(src), [3])
        fixed = "logger.warn(\n  { cronTz },\n  'zone is not usable -- ' +\n    'second part',\n)"
        self.assertEqual(hits(fixed), [])

    def test_comments_are_not_calls_and_do_not_shift_the_lines(self):
        src = "// logger.warn(`commented ${x}`)\n/* block\n logger.error(`also ${x}`)\n*/\nlogger.warn(`real ${x}`)\n"
        self.assertEqual(hits(src), [5])

    def test_other_logger_variable_names_are_covered(self):
        self.assertEqual(hits("log.warn(`a ${b}`)"), [1])
        self.assertEqual(hits("channelLogger.error(`a ${b}`)"), [1])
        self.assertEqual(hits("console.warn(`a ${b}`)"), [])

    def test_a_string_that_contains_parentheses_and_quotes_does_not_confuse_the_parser(self):
        self.assertEqual(hits("logger.warn({ a: ')' }, 'it\\'s (fixed) \"text\"')"), [])
        self.assertEqual(hits("logger.warn({ a: ')' }, `it's (built) ${x} \"text\"`)"), [1])


class TestCli(unittest.TestCase):
    def test_the_committed_baseline_matches_the_sources(self):
        p = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_a_new_offender_fails_and_a_fixed_one_does_not(self):
        d = tempfile.mkdtemp(prefix='logratchet-')
        try:
            src = os.path.join(d, 'src')
            os.makedirs(src)
            with open(os.path.join(src, 'a.ts'), 'w') as fh:
                fh.write("logger.warn({ id }, 'fixed')\n")
            counts = r.scan(src)
            self.assertEqual(counts, {})
            with open(os.path.join(src, 'a.ts'), 'w') as fh:
                fh.write("logger.warn({ id }, `built ${id}`)\n")
            counts = r.scan(src)
            self.assertEqual({k: len(v) for k, v in counts.items()}, {'a.ts': 1})
            self.assertFalse(r.is_production_ts(os.path.join('__tests__', 'x.ts')))
            self.assertFalse(r.is_production_ts('x.test.ts'))
            self.assertTrue(r.is_production_ts(os.path.join('web', 'x.ts')))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_the_baseline_is_empty_so_no_call_site_is_grandfathered(self):
        with open(os.path.join(os.path.dirname(HERE), 'log-message-literal-baseline.json')) as fh:
            self.assertEqual(json.load(fh), {'counts': {}})


if __name__ == '__main__':
    unittest.main()
