#!/usr/bin/env python3
"""
Legacy entry point of the skill file -> DB sync hook, still referenced by
per-agent settings written by scripts/install-skill-sql-sync-hook.sh.

The logic lives in skill-sql-sync.py (generated-header stripping, tenant skill
id mapping); this shim only forwards to it so both entry points behave the same.
"""
import os
import runpy

runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "skill-sql-sync.py"), run_name="__main__")
