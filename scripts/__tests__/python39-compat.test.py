#!/usr/bin/env python3
"""Python 3.9 compatibility of the shipped scripts (scripts/**/*.py, tests excluded).

`python3` on a Mac without Homebrew Python is the Xcode command line tools' 3.9, and CI only runs a newer Python, so a
construct from 3.10 or later never shows up there. The one that did slip in: an annotation such as `str | None` on a
function argument or return value is evaluated when the function is defined, which is a TypeError on 3.9 at import time
(before any code runs; for a hook that is a non-zero exit, and under the fail-closed hook policy a DENY).
`python3 -m py_compile` does not see it: the annotation is only evaluated at run time.

Two checks, both static, so they hold on whatever Python runs the test:
  1. No module-level or class-level annotation, and no function argument / return annotation, uses `A | B` unless the
     file starts with `from __future__ import annotations` (annotations are then never evaluated).
  2. Every script parses with the 3.9 grammar (`ast.parse(..., feature_version=(3, 9))`): no `match` statement and
     no other syntax newer than 3.9. (The parser is best effort for this; it catches the common cases.)

The scan itself is tested against a fixture of each shape. Run: python3 <thisfile>
"""
import ast
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)


def has_future_annotations(tree):
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == '__future__':
            if any(alias.name == 'annotations' for alias in node.names):
                return True
    return False


def has_bitor(node):
    return any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr) for n in ast.walk(node))


def evaluated_annotations(tree):
    """Yield (line, annotation node) for every annotation that Python evaluates at definition time."""
    def visit(body, in_function):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                args = node.args
                every = args.posonlyargs + args.args + args.kwonlyargs
                if args.vararg:
                    every.append(args.vararg)
                if args.kwarg:
                    every.append(args.kwarg)
                for arg in every:
                    if arg.annotation is not None:
                        yield arg.annotation.lineno, arg.annotation
                if node.returns is not None:
                    yield node.returns.lineno, node.returns
                yield from visit(node.body, True)
            elif isinstance(node, ast.ClassDef):
                yield from visit(node.body, in_function)
            elif isinstance(node, ast.AnnAssign):
                # a local variable's annotation is not evaluated; a module or class level one is
                if not in_function:
                    yield node.annotation.lineno, node.annotation
            else:
                for attr in ('body', 'orelse', 'finalbody'):
                    inner = getattr(node, attr, None)
                    if isinstance(inner, list):
                        yield from visit(inner, in_function)
                for handler in getattr(node, 'handlers', []) or []:
                    yield from visit(handler.body, in_function)
    return visit(tree.body, False)


def pep604_lines(source):
    """Lines of annotations that use `A | B` and would be evaluated on Python 3.9; none if the future import is there."""
    tree = ast.parse(source)
    if has_future_annotations(tree):
        return []
    return sorted({line for line, ann in evaluated_annotations(tree) if has_bitor(ann)})


def shipped_scripts():
    found = []
    for root, dirs, files in os.walk(SCRIPTS):
        dirs[:] = [d for d in dirs if d not in ('__tests__', '__pycache__', 'node_modules')]
        for name in files:
            if name.endswith('.py'):
                found.append(os.path.join(root, name))
    return sorted(found)


class Scan(unittest.TestCase):
    """The scan finds what it must find and leaves alone what is fine."""

    def test_function_annotations_are_flagged(self):
        self.assertEqual(pep604_lines('def f(x: str | None):\n    pass\n'), [1])
        self.assertEqual(pep604_lines('def f(x) -> int | None:\n    pass\n'), [1])
        self.assertEqual(pep604_lines('def f(*a: int | str, k: int | None = None, **kw: bytes | None):\n    pass\n'), [1])

    def test_nested_and_method_annotations_are_flagged(self):
        self.assertEqual(pep604_lines('class C:\n    def m(self, x: list[int | str]):\n        pass\n'), [2])
        self.assertEqual(pep604_lines('def outer():\n    def inner(x: int | None):\n        pass\n'), [2])
        self.assertEqual(pep604_lines('try:\n    pass\nexcept ValueError:\n    def f(x: int | None): pass\n'), [4])

    def test_module_and_class_level_annotated_assignments_are_flagged(self):
        self.assertEqual(pep604_lines('X: int | None = None\n'), [1])
        self.assertEqual(pep604_lines('class C:\n    y: str | None = None\n'), [2])

    def test_a_local_variable_annotation_is_not_evaluated(self):
        self.assertEqual(pep604_lines('def f():\n    x: int | None = None\n'), [])

    def test_the_future_import_clears_everything(self):
        self.assertEqual(pep604_lines('from __future__ import annotations\ndef f(x: str | None): pass\nY: int | None = 1\n'), [])

    def test_ordinary_code_is_left_alone(self):
        self.assertEqual(pep604_lines('def f(x: "str | None", y: int = 3 | 4):\n    return x | y\n'), [])
        self.assertEqual(pep604_lines('from typing import Optional\ndef f(x: Optional[str]) -> Optional[int]: pass\n'), [])


class ShippedScripts(unittest.TestCase):
    def test_the_scan_found_the_scripts(self):
        self.assertGreater(len(shipped_scripts()), 20)

    def test_no_pep604_annotation_without_the_future_import(self):
        bad = {}
        for path in shipped_scripts():
            with open(path, encoding='utf-8') as handle:
                lines = pep604_lines(handle.read())
            if lines:
                bad[os.path.relpath(path, SCRIPTS)] = lines
        self.assertEqual(bad, {}, 'add `from __future__ import annotations` as the first import, or use Optional[...]')

    def test_every_script_parses_with_the_python_39_grammar(self):
        bad = []
        for path in shipped_scripts():
            with open(path, encoding='utf-8') as handle:
                source = handle.read()
            try:
                ast.parse(source, feature_version=(3, 9))
            except SyntaxError as err:
                bad.append('%s:%s %s' % (os.path.relpath(path, SCRIPTS), err.lineno, err.msg))
        self.assertEqual(bad, [])


if __name__ == '__main__':
    unittest.main(verbosity=1)
