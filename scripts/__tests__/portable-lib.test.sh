#!/bin/bash
# Tests for scripts/lib/portable.sh (mtime, sha256, timeout that work on macOS and Linux) and for the scripts that
# use it: pre-modify-backup.sh (hash column of MANIFEST.txt) and auth.sh (the auth status check).
# Run: bash scripts/__tests__/portable-lib.test.sh
#
# macOS lacks sha256sum, md5sum and (without coreutils) timeout; `stat -c` is an illegal option there. A Linux CI
# host cannot lose those tools, so each helper runs in `env -i` with PATH set to a directory of stubs only (the
# helpers need nothing but shell builtins and the tool under test): the BSD userland is simulated, the logic is real.
# One group of cases uses the tools of the host.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${PORTABLE_LIB_PATH:-$SRC_DIR/lib/portable.sh}"
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "FATAL: python3 is needed for the stubs"; exit 1; }
PERL="$(command -v perl || true)"
ABC_SHA="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"   # sha256("abc")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf abc > "$TMP/abc.txt"

# stub <dir> <name> <body>: an executable stub in <dir>
stub() { mkdir -p "$1"; printf '#!/bin/sh\n%s\n' "$3" > "$1/$2"; chmod +x "$1/$2"; }

# sha256 of a file or stdin, in python (the stubs' engine)
HASHPY="import hashlib,sys
d=open(sys.argv[1],'rb').read() if len(sys.argv)>1 else sys.stdin.buffer.read()
print(hashlib.sha256(d).hexdigest())"

# in_isolation <bin-dir> <shell snippet>: run the snippet with the library sourced and PATH = <bin-dir> only
in_isolation() {
  env -i PATH="$1" /bin/bash -c ". '$LIB'; $2" 2>/dev/null
}

echo "portable_wake_epoch"
# env -i drops the variable, so it is handed to the shell inside the snippet: wake_isolated <sysctl stub> <bin-dir> <snippet>
wake_isolated() { env -i PATH="$2" /bin/bash -c "PORTABLE_SYSCTL_BIN='$1'; export PORTABLE_SYSCTL_BIN; . '$LIB'; $3" 2>/dev/null; }
B="$TMP/wake-ok"
stub "$B" sysctl 'echo "{ sec = 1792390725, usec = 413529 } Mon Oct 19 08:18:45 2026"'
assert_eq "the sec of kern.waketime" "1792390725" "$(wake_isolated "$B/sysctl" "$B" "portable_wake_epoch")"
B2="$TMP/wake-args"
stub "$B2" sysctl 'echo "$*" > "'"$TMP"'/wake-args.txt"; echo "{ sec = 5, usec = 1 }"'
wake_isolated "$B2/sysctl" "$B2" "portable_wake_epoch" >/dev/null
assert_eq "asks sysctl for -n kern.waketime" "-n kern.waketime" "$(cat "$TMP/wake-args.txt" 2>/dev/null)"
B="$TMP/wake-bad"
stub "$B" sysctl 'echo "not a waketime"'
assert_eq "an answer without 'sec =': no output, status 1" "rc=1" "$(wake_isolated "$B/sysctl" "$B" "portable_wake_epoch; echo rc=\$?")"
stub "$B" sysctl 'echo "{ sec = abc, usec = 1 }"'
assert_eq "a non-numeric sec: no output, status 1" "rc=1" "$(wake_isolated "$B/sysctl" "$B" "portable_wake_epoch; echo rc=\$?")"
stub "$B" sysctl 'exit 1'
assert_eq "sysctl failing: no output, status 1" "rc=1" "$(wake_isolated "$B/sysctl" "$B" "portable_wake_epoch; echo rc=\$?")"
assert_eq "sysctl binary missing: no output, status 1" "rc=1" "$(wake_isolated "$TMP/does-not-exist" "$B" "portable_wake_epoch; echo rc=\$?")"
if [ "$(uname -s)" = "Darwin" ]; then
  host_wake="$(env -u PORTABLE_SYSCTL_BIN /bin/bash -c ". '$LIB'; portable_wake_epoch" 2>/dev/null)"
  case "$host_wake" in ''|*[!0-9]*) fail "this Mac: the real kern.waketime is read as epoch seconds ('$host_wake')" ;; *) pass "this Mac: the real kern.waketime is read as epoch seconds" ;; esac
fi

echo "portable_sha256"
B="$TMP/only-shasum"
stub "$B" shasum "[ \"\$1\" = -a ] && [ \"\$2\" = 256 ] || exit 1; shift 2
printf '%s  %s\n' \"\$($PY -c \"$HASHPY\" \"\$@\")\" \"\${1:--}\""
assert_eq "shasum only (macOS): file" "$ABC_SHA" "$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'")"
assert_eq "shasum only (macOS): standard input" "$ABC_SHA" "$(printf abc | in_isolation "$B" "portable_sha256")"

B="$TMP/only-sha256sum"
stub "$B" sha256sum "printf '%s  %s\n' \"\$($PY -c \"$HASHPY\" \"\$@\")\" \"\${1:--}\""
assert_eq "sha256sum only (Linux): file" "$ABC_SHA" "$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'")"

B="$TMP/only-openssl"
stub "$B" openssl "[ \"\$1\" = dgst ] && [ \"\$2\" = -sha256 ] || exit 1; shift 2
printf 'SHA2-256(%s)= %s\n' \"\${1:-stdin}\" \"\$($PY -c \"$HASHPY\" \"\$@\")\""
assert_eq "openssl only: file" "$ABC_SHA" "$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'")"

B="$TMP/nothing"; mkdir -p "$B"
out="$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'; echo rc=\$?")"
assert_eq "no hash tool: no output, status 1" "rc=1" "$out"

B="$TMP/garbage"
stub "$B" sha256sum "echo 'sha256sum: illegal option' ; exit 0"
out="$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'; echo rc=\$?")"
assert_eq "a tool that prints garbage is not believed" "rc=1" "$out"

B="$TMP/short-hex"
stub "$B" sha256sum "echo 'abc123  file'"
out="$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'; echo rc=\$?")"
assert_eq "a hex answer of the wrong length is not believed" "rc=1" "$out"

B="$TMP/fallthrough"
stub "$B" sha256sum "exit 1"
stub "$B" shasum "printf '%s  %s\n' \"\$($PY -c \"$HASHPY\" \"\$3\")\" \"\$3\""
assert_eq "a failing sha256sum falls through to shasum" "$ABC_SHA" "$(in_isolation "$B" "portable_sha256 '$TMP/abc.txt'")"

out="$(PATH="$PATH" /bin/bash -c ". '$LIB'; portable_sha256 '$TMP/abc.txt'")"
assert_eq "the hash tools of this host" "$ABC_SHA" "$out"

echo "portable_mtime"
touch -t 202001010000 "$TMP/old.txt"
WANT="$("$PY" -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "$TMP/old.txt")"
B="$TMP/stat-bsd"
stub "$B" stat "[ \"\$1\" = -f ] && [ \"\$2\" = %m ] && exec $PY -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' \"\$3\"; exit 1"
assert_eq "BSD stat (macOS)" "$WANT" "$(in_isolation "$B" "portable_mtime '$TMP/old.txt'")"
B="$TMP/stat-gnu"
stub "$B" stat "[ \"\$1\" = -c ] && [ \"\$2\" = %Y ] && exec $PY -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' \"\$3\"; printf 'File: x\nID: 0\n'; exit 0"
assert_eq "GNU stat (-f would print a report with exit 0)" "$WANT" "$(in_isolation "$B" "portable_mtime '$TMP/old.txt'")"
B="$TMP/stat-none"; mkdir -p "$B"
assert_eq "no stat: status 1, no output" "rc=1" "$(in_isolation "$B" "portable_mtime '$TMP/old.txt'; echo rc=\$?")"
assert_eq "the stat of this host" "$WANT" "$(/bin/bash -c ". '$LIB'; portable_mtime '$TMP/old.txt'")"

echo "portable_timeout"
B="$TMP/to-gnu"
stub "$B" timeout "echo \"timeout \$*\" >> '$TMP/to.log'; shift; exec \"\$@\""
ln -sf /bin/echo "$B/echo"
: > "$TMP/to.log"
in_isolation "$B" "portable_timeout 25 echo hi" >/dev/null
assert_eq "timeout is used when present" "timeout 25 echo hi" "$(cat "$TMP/to.log")"

B="$TMP/to-g"
stub "$B" gtimeout "echo \"gtimeout \$*\" >> '$TMP/to.log'; shift; exec \"\$@\""
ln -sf /bin/echo "$B/echo"
: > "$TMP/to.log"
in_isolation "$B" "portable_timeout 25 echo hi" >/dev/null
assert_eq "gtimeout is used when timeout is missing (Homebrew coreutils)" "gtimeout 25 echo hi" "$(cat "$TMP/to.log")"

B="$TMP/to-none"; mkdir -p "$B"
ln -sf /bin/sh "$B/sh"
assert_eq "no timeout tool: the command runs, its status comes back" "rc=3" "$(in_isolation "$B" "portable_timeout 5 sh -c 'exit 3'; echo rc=\$?")"

if [ -n "$PERL" ]; then
  B="$TMP/to-perl"; mkdir -p "$B"
  ln -sf "$PERL" "$B/perl"; ln -sf "$(PATH=/bin:/usr/bin command -v sleep)" "$B/sleep"; ln -sf /bin/sh "$B/sh"
  start=$SECONDS
  out="$(in_isolation "$B" "portable_timeout 1 sleep 8; echo rc=\$?")"
  took=$((SECONDS - start))
  case "$out" in rc=0|'') fail "perl alarm stops a slow command (got '$out')" ;; *) pass "perl alarm stops a slow command ($out)" ;; esac
  if [ "$took" -lt 6 ]; then pass "perl alarm: stopped after about a second (${took}s)"; else fail "perl alarm: took ${took}s"; fi
  assert_eq "perl alarm: a fast command keeps its status" "rc=3" "$(in_isolation "$B" "portable_timeout 5 sh -c 'exit 3'; echo rc=\$?")"
else
  echo "  SKIP: perl not installed"
fi

echo "pre-modify-backup.sh: the hash column of MANIFEST.txt"
make_backup_tree() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store"
  cp "$SRC_DIR/pre-modify-backup.sh" "$root/scripts/"
  [ -f "$SRC_DIR/lib/portable.sh" ] && cp "$LIB" "$root/scripts/lib/portable.sh"
  printf 'echo mine\n' > "$root/scripts/mine.sh"
  printf 'scripts/mine.sh\n' > "$root/store/personal-scripts.txt"
}
manifest_of() { cat "$1"/store/backups/*/personal-scripts/MANIFEST.txt 2>/dev/null; }
MINE_SHA="$("$PY" -c "import hashlib;print(hashlib.sha256(b'echo mine\n').hexdigest())")"

ROOT="$TMP/bk-host"; make_backup_tree "$ROOT"
(cd "$ROOT" && env PATH="$PATH" bash scripts/pre-modify-backup.sh t >/dev/null 2>&1)
assert_eq "host tools: the real hash is written" "$MINE_SHA  scripts/mine.sh" "$(manifest_of "$ROOT")"

ROOT="$TMP/bk-macos"; make_backup_tree "$ROOT"
SHIM="$TMP/shim-fallthrough"
stub "$SHIM" sha256sum "exit 127"
stub "$SHIM" shasum "printf '%s  %s\n' \"\$($PY -c \"$HASHPY\" \"\$3\")\" \"\$3\""
(cd "$ROOT" && env PATH="$SHIM:$PATH" bash scripts/pre-modify-backup.sh t >/dev/null 2>&1)
assert_eq "no working sha256sum: shasum supplies the hash" "$MINE_SHA  scripts/mine.sh" "$(manifest_of "$ROOT")"

ROOT="$TMP/bk-nohash"; make_backup_tree "$ROOT"
SHIM="$TMP/shim-nohash"
stub "$SHIM" sha256sum "exit 1"; stub "$SHIM" shasum "exit 1"; stub "$SHIM" openssl "exit 1"
(cd "$ROOT" && env PATH="$SHIM:$PATH" bash scripts/pre-modify-backup.sh t >/dev/null 2>&1)
assert_eq "no hash tool works: NOHASH, never an empty hash" "NOHASH  scripts/mine.sh" "$(manifest_of "$ROOT")"

ROOT="$TMP/bk-nolib"; make_backup_tree "$ROOT"; rm -f "$ROOT/scripts/lib/portable.sh"
(cd "$ROOT" && env PATH="$PATH" bash scripts/pre-modify-backup.sh t >/dev/null 2>&1)
assert_eq "helper file missing: the backup still runs, NOHASH" "NOHASH  scripts/mine.sh" "$(manifest_of "$ROOT")"

echo "auth.sh: the auth status check"
make_auth_tree() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/bin"
  cp "$SRC_DIR/auth.sh" "$root/scripts/"
  cp "$LIB" "$root/scripts/lib/portable.sh"
}
# Only the verification step is of interest: the script is cut at the "Ellenorzes" marker and run on its own.
verify_output() {
  local root="$1" path="$2"
  ( cd "$root" && env -i HOME="$root" PATH="$path" /bin/bash -c "
      INSTALL_DIR='$root'; ok() { echo OK; }; warn() { echo WARN; }
      . '$root/scripts/lib/portable.sh' 2>/dev/null || true
      $(sed -n '/^if command -v claude/,/^fi$/p' "$root/scripts/auth.sh")" 2>&1 )
}
ROOT="$TMP/auth"; make_auth_tree "$ROOT"
stub "$ROOT/bin" claude "[ \"\$1\" = auth ] && [ \"\$2\" = status ] && exit 0; exit 1"
if [ -n "$PERL" ]; then
  ln -sf "$PERL" "$ROOT/bin/perl"
  assert_eq "no timeout on PATH (macOS): a logged-in claude is confirmed" "OK" "$(verify_output "$ROOT" "$ROOT/bin")"
fi
stub "$ROOT/bin" claude "exit 1"
assert_eq "a failing claude auth status still warns" "WARN" "$(verify_output "$ROOT" "$ROOT/bin")"
grep -q 'portable_timeout 25 claude auth status' "$SRC_DIR/auth.sh" \
  && pass "auth.sh calls portable_timeout" || fail "auth.sh calls portable_timeout"

# The whole script, run end to end in a throw-away install (service scripts are stubs, so no launchctl/systemctl):
# with the helper file physically missing the auth check cannot run `portable_timeout` (command not found), and
# the script must degrade to its warning, still write the token and finish with exit 0.
echo "auth.sh: whole run, helper file missing"
AUTH_FIXTURE_TOKEN="fixture-token-value"
run_auth() {
  local root="$1"
  mkdir -p "$root/bin"
  cp "$SRC_DIR/auth.sh" "$root/scripts/"
  printf '#!/bin/sh\nexit 0\n' > "$root/scripts/stop.sh"; cp "$root/scripts/stop.sh" "$root/scripts/start.sh"
  chmod +x "$root/scripts/stop.sh" "$root/scripts/start.sh"
  stub "$root/bin" claude "exit 0"
  printf 'MAIN_AGENT_ID=testbot\n' > "$root/.env"
  AUTH_OUT="$( cd "$root" && printf '1\n%s\n' "$AUTH_FIXTURE_TOKEN" \
    | env -i HOME="$root" PATH="$root/bin:/usr/bin:/bin" /bin/bash "$root/scripts/auth.sh" 2>&1 )"
  AUTH_RC=$?
}

ROOT="$TMP/auth-nolib"; mkdir -p "$ROOT/scripts/lib"     # lib dir exists, portable.sh does not
run_auth "$ROOT"
assert_eq "no helper: the script finishes with exit 0" "0" "$AUTH_RC"
case "$AUTH_OUT" in *"claude auth status nem erositi"*) pass "no helper: the auth check falls back to the warning" ;; *) fail "no helper: the auth check falls back to the warning ($AUTH_OUT)" ;; esac
case "$AUTH_OUT" in *"bejelentkezve"*) fail "no helper: must not claim a confirmed login" ;; *) pass "no helper: does not claim a confirmed login" ;; esac
assert_eq "no helper: the token is still written to .env" "CLAUDE_CODE_OAUTH_TOKEN=$AUTH_FIXTURE_TOKEN" "$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ROOT/.env")"
assert_eq "no helper: other .env lines are preserved" "MAIN_AGENT_ID=testbot" "$(grep '^MAIN_AGENT_ID=' "$ROOT/.env")"

# control: the same run WITH the helper confirms the login, so the warning above is caused by the missing file
ROOT="$TMP/auth-withlib"; mkdir -p "$ROOT/scripts/lib"; cp "$LIB" "$ROOT/scripts/lib/portable.sh"
run_auth "$ROOT"
assert_eq "control: with the helper the script finishes with exit 0" "0" "$AUTH_RC"
case "$AUTH_OUT" in *"bejelentkezve"*) pass "control: with the helper the login is confirmed" ;; *) fail "control: with the helper the login is confirmed ($AUTH_OUT)" ;; esac

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
