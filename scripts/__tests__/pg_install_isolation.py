"""Test-side isolation of the PostgreSQL install marker (P-E).

The hooks read <install>/store/.pg-installed, where <install> is the checkout that holds the hook files. On a checkout that
has booted PostgreSQL (the main checkout after the first dashboard boot) that marker is real, and a cell that expects a
SQLite install goes red for a reason that is not a regression. These helpers give such a cell its own install root: a copy
of scripts/hooks under a throwaway directory, with an empty store/, so no marker can be found there.

Nothing in the hooks changes and no environment variable overrides the install root: the isolation is the copy, and the
cell imports or runs the hooks from it. Neutral fixtures only.
"""
import atexit
import os
import shutil
import tempfile

REAL_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'hooks')

_root = None


def isolated_install_root():
    """A throwaway install root, created once per process: <root>/scripts/hooks is a copy of the real hooks and <root>/store
    is empty, so the store marker is absent there whatever the real checkout holds. Removed at exit."""
    global _root
    if _root is None:
        _root = tempfile.mkdtemp(prefix='pg-isolated-install-')
        atexit.register(shutil.rmtree, _root, True)
        shutil.copytree(REAL_HOOKS, os.path.join(_root, 'scripts', 'hooks'),
                        ignore=shutil.ignore_patterns('__pycache__'))
        os.makedirs(os.path.join(_root, 'store'))
    return _root


def isolated_hooks_dir():
    """The hooks directory of the isolated install root: import the hooks from here, and run them from here."""
    return os.path.join(isolated_install_root(), 'scripts', 'hooks')
