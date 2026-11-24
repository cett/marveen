#!/usr/bin/env bash
# INJECTED (throwaway branch, never merged): a shell test that always fails, so the gate tests must run and go red.
echo "injected failure: the gate tests must run on this change"
exit 1
