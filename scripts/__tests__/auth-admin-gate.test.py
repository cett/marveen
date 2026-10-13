#!/usr/bin/env python3
"""Tests for scripts/hooks/auth-admin-gate.py (the PreToolUse gate that keeps an agent's Bash call from
minting / destroying a login, a session or a token, and from approving its own request).

Layers:
  1. a table of BLOCKED shapes (the CLI in every wrapper, direct auth-table writes, decoded input)
     and ALLOWED shapes (reads, `list`, prose that merely names the CLI, copies of the DB, unrelated
     commands), run through inspect();
  2. the exit-code contract through a real subprocess (0 allow / 2 block, bad input, hang);
  3. bounded work: hostile inputs finish fast and over a limit DENY;
  4. MUTATION: each mutant of the gate source must make at least one table row fail.

Run:  python3 scripts/__tests__/auth-admin-gate.test.py
Privacy: neutral fixture data only (usernames bob / x, no real agent names, tokens or chat IDs).
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import warnings

warnings.simplefilter('ignore', ResourceWarning)   # fixture files are written with open().write()

HERE = os.path.dirname(os.path.abspath(__file__))
# in the repo: scripts/__tests__ -> scripts/hooks/auth-admin-gate.py ; in the hand-off folder: next to this file
_CANDIDATES = [
    os.environ.get('AUTH_ADMIN_GATE_PATH') or '',
    os.path.join(os.path.dirname(HERE), 'hooks', 'auth-admin-gate.py'),
    os.path.join(HERE, 'auth-admin-gate.py.new'),
    os.path.join(HERE, 'auth-admin-gate.py'),
]
GATE_PATH = next(p for p in _CANDIDATES if p and os.path.exists(p))
GATE_SRC = open(GATE_PATH, encoding='utf-8').read()

os.environ['AUTH_ADMIN_GATE_NO_AUDIT'] = '1'


def load_gate(src=GATE_SRC, name='auth_admin_gate'):
    spec = importlib.util.spec_from_loader(name, loader=None)
    mod = importlib.util.module_from_spec(spec)
    mod.__file__ = GATE_PATH
    exec(compile(src, GATE_PATH, 'exec'), mod.__dict__)
    return mod


# ---------------------------------------------------------------------------------------------
# fixture: a fake install with a live store, a copy of the DB elsewhere, scripts
# ---------------------------------------------------------------------------------------------
class Fixture(object):
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix='aag-')
        self.root = os.path.realpath(os.path.join(self.tmp, 'install'))
        self.store = os.path.join(self.root, 'store')
        self.other = os.path.realpath(os.path.join(self.tmp, 'copy'))
        self.links = os.path.realpath(os.path.join(self.tmp, 'links'))   # symlinks to the live store
        self.hard = os.path.realpath(os.path.join(self.tmp, 'hard'))     # hard links of the live files
        self.twin = os.path.realpath(os.path.join(self.tmp, 'twin'))     # two names of one NON-live file
        for d in (self.store, os.path.join(self.root, 'scripts'), self.other, self.links, self.hard, self.twin):
            os.makedirs(d)
        self.live = os.path.join(self.store, 'claudeclaw.db')
        self.live_wal = self.live + '-wal'
        self.live_shm = self.live + '-shm'
        self.copy_db = os.path.join(self.other, 'claudeclaw.db')
        for p in (self.live, self.live_wal, self.live_shm, self.copy_db):
            open(p, 'w').close()
        os.symlink(self.live, os.path.join(self.links, 'link.db'))
        os.symlink(self.store, os.path.join(self.links, 'storelink'))   # a directory link to the live store
        os.symlink(os.path.join(self.store, 'fresh.db'), os.path.join(self.links, 'fresh.db'))   # dangling: the file does not exist yet
        os.link(self.live, os.path.join(self.hard, 'hard.db'))
        os.link(self.live_wal, os.path.join(self.hard, 'hard.db-wal'))
        os.link(self.live_shm, os.path.join(self.hard, 'hard.db-shm'))
        open(os.path.join(self.twin, 'twin1.db'), 'w').close()
        os.link(os.path.join(self.twin, 'twin1.db'), os.path.join(self.twin, 'twin2.db'))
        os.link(self.live, os.path.join(self.hard, 'blob.bin'))      # a live file under a name that does not look like a DB
        self.other_db = os.path.join(self.store, 'other.db')         # a second database in the live store
        open(self.other_db, 'w').close()
        os.link(self.other_db, os.path.join(self.hard, 'other.bin'))
        open(os.path.join(self.root, 'cdscript.sh'), 'w').write('cd store\n')
        os.makedirs(os.path.join(self.tmp, 'hardstore'))
        os.link(self.live, os.path.join(self.tmp, 'hardstore', 'claudeclaw.db'))   # a "throw-away" store that IS the live DB
        self.hardstore = os.path.realpath(os.path.join(self.tmp, 'hardstore'))
        for name in ('dashboard-user.ts', 'dashboard-use1.ts', 'security-reset.sh'):
            open(os.path.join(self.root, 'scripts', name), 'w').write('// fixture\n')
        open(os.path.join(self.root, 'bad.sh'), 'w').write('#!/bin/bash\nnpm run dashboard-user -- add bob\n')
        open(os.path.join(self.root, 'ok.sh'), 'w').write('#!/bin/bash\necho hello\nnpm run build\n')
        open(os.path.join(self.root, 'bad.sql'), 'w').write("UPDATE dashboard_users SET role='admin';\n")
        open(os.path.join(self.root, 'ok.sql'), 'w').write('SELECT count(*) FROM dashboard_users;\n')
        open(os.path.join(self.root, 'readbad.sql'), 'w').write('.read bad.sql\n')
        self.env = {'CLAUDE_PROJECT_DIR': self.root, 'MARVEEN_STORE_DIR': self.store}

    def sub(self, cmd):
        return (cmd.replace('{S}', self.store).replace('{R}', self.root)
                .replace('{O}', self.other).replace('{L}', self.live)
                .replace('{K}', self.links).replace('{H}', self.hard).replace('{T}', self.twin)
                .replace('{HS}', self.hardstore))


FX = Fixture()
os.environ.update(FX.env)


# ---------------------------------------------------------------------------------------------
# the table
# ---------------------------------------------------------------------------------------------
BLOCKED = [
    # ---- the CLI itself, every verb ----
    ('npm run, -- add', 'npm run dashboard-user -- add bob'),
    ('npm run, no --', 'npm run dashboard-user add bob'),
    ('npm run reset-password + --password-stdin', 'echo pw | npm run dashboard-user -- reset-password bob --password-stdin'),
    ('npm run remove', 'npm run dashboard-user -- remove bob'),
    ('npm run sessions:clear', 'npm run dashboard-user -- sessions:clear'),
    ('npm run security:reset', 'npm run dashboard-user -- security:reset'),
    ('npm run, no args', 'npm run dashboard-user'),
    ('npm run --silent', 'npm run --silent dashboard-user -- add bob'),
    ('npm --prefix', 'npm --prefix {R} run dashboard-user -- add bob'),
    ('npm run -w', 'npm run -w ws dashboard-user -- add bob'),
    ('npm run-script', 'npm run-script dashboard-user -- add bob'),
    ('npm exec tsx', 'npm exec -- tsx scripts/dashboard-user.ts add bob'),
    ('pnpm run', 'pnpm run dashboard-user add bob'),
    ('pnpm bare', 'pnpm dashboard-user add bob'),
    ('pnpm exec tsx', 'pnpm exec tsx scripts/dashboard-user.ts add bob'),
    ('pnpm dlx', 'pnpm dlx dashboard-user add bob'),
    ('yarn bare', 'yarn dashboard-user add bob'),
    ('yarn run', 'yarn run dashboard-user add bob'),
    ('npx tsx', 'npx tsx scripts/dashboard-user.ts add bob'),
    ('npx -y tsx', 'npx -y tsx scripts/dashboard-user.ts add bob'),
    ('bunx tsx', 'bunx tsx scripts/dashboard-user.ts add bob'),
    ('tsx direct', 'tsx scripts/dashboard-user.ts add bob'),
    ('tsx abs path', 'tsx {R}/scripts/dashboard-user.ts add bob'),
    ('tsx watch', 'tsx watch scripts/dashboard-user.ts add bob'),
    ('node compiled', 'node dist/scripts/dashboard-user.js add bob'),
    ('node --import tsx', 'node --import tsx scripts/dashboard-user.ts add bob'),
    ('node -r', 'node -r ts-node/register scripts/dashboard-user.ts add bob'),
    ('ts-node', 'ts-node scripts/dashboard-user.ts reset-password bob'),
    ('bun run file', 'bun run scripts/dashboard-user.ts add bob'),
    ('bun file', 'bun scripts/dashboard-user.ts add bob'),
    ('deno run', 'deno run -A scripts/dashboard-user.ts add bob'),
    ('vite-node', 'vite-node scripts/dashboard-user.ts add bob'),
    ('direct exec path', './scripts/dashboard-user.ts add bob'),
    ('direct exec abs', '{R}/scripts/dashboard-user.ts add bob'),
    ('security-reset script', 'bash scripts/security-reset.sh'),
    ('security-reset direct', './scripts/security-reset.sh'),
    ('security-reset npm', 'npm run security-reset'),
    ('security-reset tsx', 'tsx scripts/security-reset.ts'),
    # ---- wrappers ----
    ('bash -c', 'bash -c "npm run dashboard-user -- add bob"'),
    ('sh -c single quotes', "sh -c 'npm run dashboard-user add bob'"),
    ('bash -lc cluster', 'bash -lc "npm run dashboard-user add bob"'),
    ('zsh -c', 'zsh -c "npm run dashboard-user add bob"'),
    ('bash -c nested twice', 'bash -c "sh -c \\"npm run dashboard-user add bob\\""'),
    ('env', 'env npm run dashboard-user add bob'),
    ('env with var', 'env FOO=1 tsx scripts/dashboard-user.ts add bob'),
    ('env -i', 'env -i npm run dashboard-user add bob'),
    ('env -S', "env -S 'npm run dashboard-user add bob'"),
    ('prefix assignment', 'FOO=1 npm run dashboard-user add bob'),
    ('command builtin', 'command npm run dashboard-user add bob'),
    ('exec builtin', 'exec npm run dashboard-user add bob'),
    ('nohup', 'nohup npm run dashboard-user add bob'),
    ('timeout', 'timeout 5 npm run dashboard-user add bob'),
    ('nice -n', 'nice -n 5 npm run dashboard-user add bob'),
    ('time', 'time npm run dashboard-user add bob'),
    ('sudo', 'sudo -u root npm run dashboard-user add bob'),
    ('xargs with echo', 'echo dashboard-user | xargs npm run'),
    ('xargs -I', 'echo dashboard-user | xargs -I{} npm run {}'),
    ('find -exec', 'find . -maxdepth 0 -exec npm run dashboard-user add bob \\;'),
    ('eval', 'eval "npm run dashboard-user add bob"'),
    ('eval concat', 'eval npm run dashboard-user add bob'),
    ('su -c', 'su -c "npm run dashboard-user add bob" root'),
    ('watch', 'watch -n 5 npm run dashboard-user add bob'),
    ('ssh', 'ssh localhost "npm run dashboard-user add bob"'),
    ('ssh heredoc', 'ssh localhost <<EOF\nnpm run dashboard-user add bob\nEOF'),
    ('tmux send-keys', 'tmux send-keys -t main "npm run dashboard-user add bob" Enter'),
    ('tmux send-keys words', 'tmux send-keys -t main npm run dashboard-user add bob Enter'),
    ('tmux run-shell', 'tmux run-shell "npm run dashboard-user add bob"'),
    ('screen stuff', 'screen -X stuff "npm run dashboard-user add bob\\n"'),
    ('osascript do script', 'osascript -e \'tell application "Terminal" to do script "npm run dashboard-user add bob"\''),
    ('osascript do shell script', 'osascript -e \'do shell script "npm run dashboard-user add bob"\''),
    # ---- sequence / grouping ----
    ('after &&', 'cd {R} && npm run dashboard-user -- add bob'),
    ('after ;', 'echo hi; npm run dashboard-user add bob'),
    ('after ||', 'false || npm run dashboard-user add bob'),
    ('after pipe', 'echo x | npm run dashboard-user add bob'),
    ('after newline', 'echo hi\nnpm run dashboard-user add bob'),
    ('in for loop', 'for i in 1; do npm run dashboard-user add bob; done'),
    ('in if', 'if true; then npm run dashboard-user add bob; fi'),
    ('in braces', '{ npm run dashboard-user add bob; }'),
    ('in subshell', '(npm run dashboard-user add bob)'),
    ('background', 'npm run dashboard-user add bob &'),
    ('line continuation', 'npm run \\\n dashboard-user add bob'),
    ('crlf', 'npm run dashboard-user add bob\r\n'),
    ('redirect after', 'npm run dashboard-user add bob > /tmp/out 2>&1'),
    ('redirect before', '2>/dev/null npm run dashboard-user add bob'),
    ('list plus another verb', 'npm run dashboard-user -- list add bob'),
    ('another verb then list', 'npm run dashboard-user -- add list'),
    # ---- obfuscation of the name ----
    ('quoted halves', 'npm run dashboard-"user" add bob'),
    ('single-quoted whole', "npm run 'dashboard-user' add bob"),
    ('backslash', 'npm run dashboard-\\user add bob'),
    ('ansi-c hex', "npm run $'\\x64ashboard-user' add bob"),
    ('ansi-c octal', "npm run $'\\144ashboard-user' add bob"),
    ('brace expansion', 'npm run dashboard-{user,x} add bob'),
    ('var holds name', 'X=dashboard-user; npm run $X add bob'),
    ('var braces', 'X=dashboard-user; npm run ${X} add bob'),
    ('export var', 'export X=dashboard-user; npm run "$X" add bob'),
    ('var holds quoted name', 'X="dashboard-user"; npm run $X add bob'),
    ('var holds whole command', 'C="npm run dashboard-user add bob"; $C'),
    ('dynamic script name', 'npm run "$SOMETHING_UNSET" add bob'),
    ('glob in script path', 'tsx scripts/dashboard-us*.ts add bob'),
    ('glob ? in script path', 'tsx scripts/dashboard-use?.ts add bob'),
    ('security-reset glob', 'bash scripts/security-re*.sh'),
    # ---- substitution / heredoc / pipe-to-shell ----
    ('command substitution', 'echo $(npm run dashboard-user add bob)'),
    ('backticks', 'echo `npm run dashboard-user add bob`'),
    ('substitution in dquote', 'echo "$(npm run dashboard-user add bob)"'),
    ('process substitution', 'cat <(npm run dashboard-user add bob)'),
    ('assignment substitution', 'X=$(npm run dashboard-user add bob)'),
    ('heredoc to bash', 'bash <<EOF\nnpm run dashboard-user add bob\nEOF'),
    ('heredoc to sh -s', 'sh -s <<EOF\nnpm run dashboard-user add bob\nEOF'),
    ('heredoc <<- tabs', 'bash <<-EOF\n\tnpm run dashboard-user add bob\n\tEOF'),
    ('heredoc quoted delim to bash', "bash <<'EOF'\nnpm run dashboard-user add bob\nEOF"),
    ('cat heredoc piped to bash', 'cat <<EOF | bash\nnpm run dashboard-user add bob\nEOF'),
    ('unclosed heredoc to bash', 'bash <<EOF\nnpm run dashboard-user add bob'),
    ('here-string to bash', 'bash <<< "npm run dashboard-user add bob"'),
    ('echo piped to bash', 'echo "npm run dashboard-user add bob" | bash'),
    ('printf piped to sh', "printf '%s\\n' 'npm run dashboard-user add bob' | sh"),
    ('unquoted heredoc into data file runs substitution', 'cat > /tmp/f <<EOF\n$(npm run dashboard-user add bob)\nEOF'),
    ('heredoc with substitution after data', 'cat > /tmp/f <<EOF\nhello\n`npm run dashboard-user add bob`\nEOF\necho done'),
    ('bash on a script file', 'bash {R}/bad.sh'),
    ('sh on a script file', 'sh bad.sh'),
    ('source script file', 'source bad.sh'),
    ('dot script file', '. ./bad.sh'),
    ('direct script file', '{R}/bad.sh'),
    ('script on stdin from file', 'bash < bad.sh'),
    ('cat script file into bash', 'cat bad.sh | bash'),
    ('base64 decoded to bash', 'echo bnBtIHJ1bg== | base64 -d | bash'),
    ('base64 decode to sh', 'base64 --decode payload.b64 | sh'),
    ('xxd decode to bash', 'xxd -r -p payload.hex | bash'),
    ('openssl decode to python', 'openssl enc -d -base64 -in p.b64 | python3'),
    ('gunzip to bash', 'gunzip -c payload.gz | bash'),
    ('decoder two stages up the pipeline', 'base64 -d payload.b64 | tr a-z A-Z | bash'),
    ('decoder three stages up the pipeline', 'cat payload.b64 | base64 -d | rev | bash'),
    ('eval of decoded', 'eval "$(echo bnBtIHJ1bg== | base64 -d)"'),
    ('bash -c of decoded', 'bash -c "$(echo bnBtIHJ1bg== | base64 -d)"'),
    # ---- --password-stdin anywhere ----
    ('--password-stdin bare', 'some-tool add bob --password-stdin'),
    ('--password-stdin in a wrapper', 'env X=1 some-tool --password-stdin'),
    ('--password-stdin after pipe', 'echo pw | ./add-user.sh --password-stdin'),
    # ---- auth tables: SQL clients on the live store ----
    ('sqlite3 live update users', 'sqlite3 {L} "UPDATE dashboard_users SET role=\'admin\'"'),
    ('sqlite3 live insert user', 'sqlite3 {L} "INSERT INTO dashboard_users(username) VALUES (\'x\')"'),
    ('sqlite3 live insert or replace', 'sqlite3 {L} "INSERT OR REPLACE INTO api_tokens(id) VALUES (1)"'),
    ('sqlite3 live replace into', 'sqlite3 {L} "REPLACE INTO device_keys(id) VALUES (1)"'),
    ('sqlite3 live delete sessions', 'sqlite3 {L} "DELETE FROM auth_sessions"'),
    ('sqlite3 live drop', 'sqlite3 {L} "DROP TABLE api_tokens"'),
    ('sqlite3 live drop if exists', 'sqlite3 {L} "DROP TABLE IF EXISTS device_keys"'),
    ('sqlite3 live alter', 'sqlite3 {L} "ALTER TABLE dashboard_users ADD COLUMN x"'),
    ('sqlite3 live rename to', 'sqlite3 {L} "ALTER TABLE t RENAME TO dashboard_users"'),
    ('sqlite3 live approvals self-approve', 'sqlite3 {L} "UPDATE approvals SET status=\'approved\' WHERE id=1"'),
    ('sqlite3 live approval_events', 'sqlite3 {L} "INSERT INTO approval_events(approval_id) VALUES (1)"'),
    ('sqlite3 live _old shadow', 'sqlite3 {L} "DELETE FROM api_tokens_old"'),
    ('sqlite3 live schema-qualified', 'sqlite3 {L} "UPDATE main.api_tokens SET revoked_at=1"'),
    ('sqlite3 live quoted name', 'sqlite3 {L} \'UPDATE "api_tokens" SET revoked_at=1\''),
    ('sqlite3 live bracket name', 'sqlite3 {L} "UPDATE [api_tokens] SET revoked_at=1"'),
    ('sqlite3 live backtick name', "sqlite3 {L} 'UPDATE `api_tokens` SET revoked_at=1'"),
    ('sqlite3 live comment between', 'sqlite3 {L} "UPDATE /* x */ dashboard_users SET role=1"'),
    ('sqlite3 live long comment between', 'sqlite3 {L} "UPDATE /* ' + 'x' * 900 + ' */ dashboard_users SET role=1"'),
    ('sqlite3 live two comments between', 'sqlite3 {L} "UPDATE/**//**/dashboard_users SET role=1"'),
    ('sqlite3 live line comment between', 'sqlite3 {L} "UPDATE -- x\ndashboard_users SET role=1"'),
    ('sqlite3 live trigger on a protected table', 'sqlite3 {L} "CREATE TRIGGER t AFTER INSERT ON dashboard_users BEGIN SELECT 1; END"'),
    ('string literal hides a write from the comment cutter (sqlite3)', 'sqlite3 {L} "select \'x/*\'; delete from api_tokens; select \'*/\'"'),
    ('string literal hides a write from the comment cutter (python)', 'python3 -c "s = \'x/*\'; t = \'delete from api_tokens\'; u = \'*/\'"'),
    ('string literal hides a write from the comment cutter (unknown command)', 'frobnicate "select \'x/*\'; delete from api_tokens; select \'*/\'"'),
    ('trigger header with the ON far from the verb', 'sqlite3 {L} "create trigger t xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx after insert on dashboard_users begin select 1; end"'),
    ('trigger with a ; in its quoted name', 'sqlite3 {L} "create trigger \\"a;b\\" before delete on api_tokens begin select 1; end"'),
    ('trigger header too long to read', 'sqlite3 {L} "create trigger t xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"'),
    ('sed e command runs the CLI', "sed -n '1e npm run dashboard-user add bob' {O}/x"),
    ('sed s///e runs the CLI', "sed 's/^/npm run dashboard-user add bob/e' {O}/x"),
    ('rg --pre runs the CLI', "rg --pre 'npm run dashboard-user add bob' foo {O}"),
    ('man -P runs the CLI', "man -P 'npm run dashboard-user add bob' ls"),
    ('sort --compress-program runs the CLI', "sort --compress-program='npm run dashboard-user add bob' {O}/x"),
    ('less +! runs the CLI', "less '+!npm run dashboard-user add bob' {O}/x"),
    ('gh alias runs the CLI', "gh alias set x '!npm run dashboard-user add bob'"),
    ('open runs the CLI', "open -a Terminal --args 'npm run dashboard-user add bob'"),
    ('wget --use-askpass runs the CLI', "wget --use-askpass='npm run dashboard-user add bob' http://x"),
    ('git log --output into the live DB', 'git log --output={S}/claudeclaw.db'),
    ('git diff --output (separate word) into the live DB', 'git diff --output {S}/claudeclaw.db HEAD'),
    ('git show abbreviated --out into the live DB', 'git show --out={L}'),
    ('git grep -O opens the hits with a command', "git grep -O'npm run dashboard-user add bob' foo"),
    ('git log --ext-diff', 'git log --ext-diff -p'),
    ('git log --open-files-in-pager', 'git log --open-files-in-pager=sh'),
    ('truncate the live DB', 'truncate -s 0 {S}/claudeclaw.db'),
    ('chmod the live DB', 'chmod 000 {S}/claudeclaw.db'),
    ('chown the live WAL', 'chown nobody {S}/claudeclaw.db-wal'),
    ('rm the live DB', 'rm {S}/claudeclaw.db'),
    ('rm -rf the store dir', 'rm -rf {S}'),
    ('chmod -R the store dir', 'chmod -R 700 {S}'),
    ('touch the live WAL', 'touch {S}/claudeclaw.db-wal'),
    ('truncate a hard link of the live DB', 'truncate -s 0 {H}/hard.db'),
    ('sed -i on the live DB', "sed -i 's/a/b/' {S}/claudeclaw.db"),
    ('sed -i.bak on the live DB', "sed -i.bak 's/a/b/' {L}"),
    ('sed w command into the live DB', "sed -n 'w {L}' {O}/x"),
    ('sed s///w into the live DB', "sed 's/a/b/w {S}/claudeclaw.db' {O}/x"),
    ('sort -o the live DB', 'sort -o {S}/claudeclaw.db {O}/x'),
    ('sort -oFILE attached', 'sort -o{L} {O}/x'),
    ('sort --output= the live DB', 'sort --output={L} {O}/x'),
    ('curl -o the live DB', 'curl -o {S}/claudeclaw.db http://x'),
    ('wget -O the live DB', 'wget -O {L} http://x'),
    ('python decrement hides nothing', 'python3 -c "i--; c.execute(\'DELETE FROM api_tokens\')"'),
    ('sqlite3 live newline between', 'sqlite3 {L} "UPDATE\ndashboard_users SET role=1"'),
    ('sqlite3 live upper/lower mix', 'sqlite3 {L} "uPdAtE Dashboard_Users SET role=1"'),
    ('sqlite3 live update or ignore', 'sqlite3 {L} "UPDATE OR IGNORE api_tokens SET x=1"'),
    ('sqlite3 live second statement', 'sqlite3 {L} "SELECT 1; DELETE FROM device_keys;"'),
    ('sqlite3 live -cmd', 'sqlite3 -cmd "DELETE FROM auth_sessions" {L} "SELECT 1"'),
    ('sqlite3 live flags first', 'sqlite3 -bail -batch {L} "DELETE FROM api_tokens"'),
    ('sqlite3 live relative path', 'cd {R} && sqlite3 store/claudeclaw.db "DELETE FROM api_tokens"'),
    ('sqlite3 live dot-dot path', 'sqlite3 {R}/scripts/../store/claudeclaw.db "DELETE FROM api_tokens"'),
    ('sqlite3 symlink to live', 'sqlite3 {K}/link.db "DELETE FROM api_tokens"'),
    ('sqlite3 a db that does not exist yet in the live store dir', 'sqlite3 {S}/fresh.db "DELETE FROM api_tokens"'),
    ('sqlite3 dangling symlink into the live store dir', 'sqlite3 {K}/fresh.db "DELETE FROM api_tokens"'),
    ('sqlite3 live var path', 'DB={L}; sqlite3 $DB "DELETE FROM api_tokens"'),
    ('sqlite3 unresolved var path', 'sqlite3 "$UNSET_DB" "DELETE FROM api_tokens"'),
    ('sqlite3 substitution path', 'sqlite3 "$(echo x)" "DELETE FROM api_tokens"'),
    ('sqlite3 table in var', 'T=api_tokens; sqlite3 {L} "DELETE FROM $T"'),  # expands to a known value
    ('sqlite3 stdin heredoc', 'sqlite3 {L} <<EOF\nDELETE FROM api_tokens;\nEOF'),
    ('sqlite3 stdin heredoc quoted', "sqlite3 {L} <<'EOF'\nUPDATE dashboard_users SET role='admin';\nEOF"),
    ('sqlite3 here-string', "sqlite3 {L} <<< \"DELETE FROM api_tokens\""),
    ('sqlite3 piped echo', 'echo "DELETE FROM api_tokens;" | sqlite3 {L}'),
    ('sqlite3 file redirect', 'sqlite3 {L} < {R}/bad.sql'),
    ('sqlite3 .read', 'sqlite3 {L} ".read {R}/bad.sql"'),
    ('sqlite3 .read nested', 'sqlite3 {L} ".read {R}/readbad.sql"'),
    ('sqlite3 .import', 'sqlite3 {L} ".import rows.csv dashboard_users"'),
    ('sqlite3 .restore', 'sqlite3 {L} ".restore backup.db"'),
    ('sqlite3 .shell', 'sqlite3 {L} ".shell npm run dashboard-user add bob"'),
    ('sqlite3 .system on a copy', 'sqlite3 {O}/claudeclaw.db ".system id"'),
    ('sqlite3 attach live from a copy', 'sqlite3 {O}/claudeclaw.db "ATTACH \'{L}\' AS x; DELETE FROM x.api_tokens"'),
    ('sqlite3 attach database form', 'sqlite3 {O}/claudeclaw.db "ATTACH DATABASE \'{L}\' AS x; UPDATE x.dashboard_users SET role=1"'),
    ('sqlite3 .open live from a copy', 'sqlite3 {O}/claudeclaw.db ".open {L}" "DELETE FROM api_tokens"'),
    ('sqlite3 decoded input on live', 'zcat dump.sql.gz | sqlite3 {L}'),
    ('sqlite3 base64 input on live', 'base64 -d dump.b64 | sqlite3 {L}'),
    ('sqlite-utils execute', 'sqlite-utils execute {L} "DELETE FROM api_tokens"'),
    ('psql update', 'psql -c "UPDATE dashboard_users SET role=1"'),
    ('psql file', 'psql -f {R}/bad.sql'),
    ('duckdb', 'duckdb -c "DELETE FROM api_tokens"'),
    ('litecli', 'litecli {L} -e "DELETE FROM api_tokens"'),
    ('sqlite3 in wrapper', 'env sqlite3 {L} "DELETE FROM api_tokens"'),
    ('sqlite3 in bash -c', 'bash -c "sqlite3 {L} \\"DELETE FROM api_tokens\\""'),
    ('sqlite3 in xargs', 'echo x | xargs sqlite3 {L} "DELETE FROM api_tokens"'),
    # ---- auth tables: interpreter code (no visible path) ----
    ('python -c update', 'python3 -c "import sqlite3; sqlite3.connect(\'x.db\').execute(\'UPDATE dashboard_users SET role=1\')"'),
    ('python -c delete', 'python3 -c "c.execute(\'DELETE FROM api_tokens\')"'),
    ('python3.11 -c', 'python3.11 -c "c.execute(\'DELETE FROM api_tokens\')"'),
    ('python -Bc cluster', 'python3 -Bc "c.execute(\'DELETE FROM api_tokens\')"'),
    ('python heredoc', 'python3 - <<PY\nimport sqlite3\nc = sqlite3.connect(DB)\nc.execute("INSERT INTO api_tokens VALUES (1)")\nPY'),
    ('python heredoc quoted delim', "python3 <<'PY'\nc.execute('UPDATE auth_sessions SET x=1')\nPY"),
    ('python here-string', "python3 <<< \"c.execute('DELETE FROM device_keys')\""),
    ('python piped', "echo \"c.execute('DELETE FROM device_keys')\" | python3"),
    ('python execs the CLI', 'python3 -c "import os; os.system(\'npm run dashboard-user add bob\')"'),
    ('python subprocess the CLI', 'python3 - <<PY\nimport subprocess\nsubprocess.run(["npm", "run", "dashboard-user", "add", "bob"])\nPY'),
    ('node -e update', 'node -e "db.prepare(\'UPDATE dashboard_users SET role=1\').run()"'),
    ('node -e insert', 'node -e "db.exec(\'INSERT INTO device_keys VALUES (1)\')"'),
    ('node --eval', 'node --eval "db.exec(\'DELETE FROM api_tokens\')"'),
    ('node -p', 'node -p "db.exec(\'DELETE FROM api_tokens\')"'),
    ('node heredoc', 'node <<EOF\ndb.exec("DELETE FROM auth_sessions")\nEOF'),
    ('tsx -e', 'tsx -e "db.exec(\'DELETE FROM auth_sessions\')"'),
    ('bun -e', 'bun -e "db.exec(\'DELETE FROM auth_sessions\')"'),
    ('node app mutator', 'node -e "require(\'./dist/src/db.js\').createDashboardUser(\'x\', \'h\')"'),
    ('node securityReset', "node -e \"import('./dist/src/web/security-reset.js').then(m => m.securityReset())\""),
    ('node insertApiToken', 'node -e "insertApiToken({})"'),
    ('node revokeAllSessions', 'node -e "revokeAllSessions()"'),
    ('node issueEnrollCode', 'node -e "issueEnrollCode()"'),
    ('node password-hash import', "node -e \"import('./dist/src/web/password-hash.js').then(m => m.hashPassword('x'))\""),
    ('node execs the CLI', 'node -e "require(\'child_process\').execSync(\'npm run dashboard-user add bob\')"'),
    ('perl -e', "perl -e 'system(\"npm run dashboard-user add bob\")'"),
    ('perl sql', "perl -e '$dbh->do(\"DELETE FROM api_tokens\")'"),
    ('ruby -e', "ruby -e 'system(\"npm run dashboard-user add bob\")'"),
    ('php -r', "php -r 'system(\"npm run dashboard-user add bob\");'"),
    ('python base64 decoded into python', 'echo cHJpbnQ= | base64 -d | python3'),
    # ---- the isolated-store exemption must not open the live store ----
    ('store dir = the live store', 'MARVEEN_STORE_DIR={S} npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir = a parent of the live store', 'MARVEEN_STORE_DIR={R} npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir with ..', 'MARVEEN_STORE_DIR={O}/../install/store npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir via a directory symlink', 'MARVEEN_STORE_DIR={K}/storelink npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir unresolved', 'MARVEEN_STORE_DIR=$UNSET_DIR npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir from a substitution', 'MARVEEN_STORE_DIR=$(echo {O}) npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir empty', 'MARVEEN_STORE_DIR= npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir set for another command only', 'MARVEEN_STORE_DIR={O} true; npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir set in an earlier segment', 'MARVEEN_STORE_DIR={O} echo x && npx tsx scripts/dashboard-user.ts add bob'),
    ('store dir on the producer only', 'MARVEEN_STORE_DIR={O} echo pw | npx tsx scripts/dashboard-user.ts add bob --password-stdin'),
    ('store dir in a different variable', 'STORE_DIR={O} npx tsx scripts/dashboard-user.ts add bob'),
    ('isolated store with the live DB path as target', 'MARVEEN_STORE_DIR={O} sqlite3 {L} "DELETE FROM api_tokens"'),
    # ---- a directory change anywhere makes every relative path unknown (fail closed) ----
    ('cd then relative live db', 'cd store && sqlite3 claudeclaw.db "insert into api_tokens(id) values (1)"'),
    ('cd to the store then ./db', 'cd {S} && sqlite3 ./claudeclaw.db "insert into api_tokens(id) values (1)"'),
    ('pushd then relative db', 'pushd store; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('popd then relative db', 'popd; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('subshell cd then relative db', '(cd store; sqlite3 claudeclaw.db "delete from api_tokens")'),
    ('env -C then relative db', 'env -C store sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('env --chdir then relative db', 'env --chdir=store sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('sudo -D then relative db', 'sudo -D store sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd to an absolute dir, ../ back into the store', 'cd {O} && sqlite3 ../install/store/claudeclaw.db "delete from api_tokens"'),
    ('cd to a copy, then a relative cd into the store', 'cd {O} && cd ../install/store && sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd to the live store from the other branch of an ||', 'cd {O} || cd {S}; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd home (no operand)', 'cd; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd -', 'cd {O}; cd -; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('db path built from a substitution in a variable', 'D=$(pwd); sqlite3 $D/store/claudeclaw.db "delete from api_tokens"'),
    ('db path with a substitution inline', 'sqlite3 "$(pwd)/store/claudeclaw.db" "delete from api_tokens"'),
    ('db path with backticks in a variable', 'D=`pwd`; sqlite3 $D/claudeclaw.db "delete from api_tokens"'),
    ('symlink to the live store made in the same command', 'ln -s {S} {O}/newlink && sqlite3 {O}/newlink/claudeclaw.db "delete from api_tokens"'),
    ('symlink over a copy made in the same command', 'ln -sf {L} {O}/claudeclaw.db && sqlite3 {O}/claudeclaw.db "delete from api_tokens"'),
    ('symlink made, then the CLI on a store dir behind it', 'ln -s {S} {O}/newstore && MARVEEN_STORE_DIR={O}/newstore npx tsx scripts/dashboard-user.ts add x'),
    ('password on a throw-away store that receives a link to the live DB', 'ln -s {L} {O}/side.db; echo pw | MARVEEN_STORE_DIR={O} npx tsx scripts/dashboard-user.ts add x --password-stdin'),
    ('password on a store dir that is a link made in the same command', 'ln -s {S} {O}/ns2 && echo pw | MARVEEN_STORE_DIR={O}/ns2 npx tsx scripts/dashboard-user.ts add x --password-stdin'),
    ('cp through a store-dir symlink made in the same command', 'ln -s {S} {O}/newlink2 && cp {O}/claudeclaw.db {O}/newlink2/claudeclaw.db'),
    ('cp through a store-dir symlink named by a variable', 'L={O}/newlink3; ln -s {S} $L; cp {O}/claudeclaw.db $L/claudeclaw.db'),
    ('unknown cd then cp of a db to a db name', 'cd store && cp {O}/claudeclaw.db claudeclaw.db'),
    ('unknown cd then cp of a db to dot', 'cd store && cp {O}/claudeclaw.db .'),
    ('unknown cd then cp -al of the store', 'pushd {R}; cp -al store {O}/clone'),
    ('unknown cd then ln of a store file', 'pushd {R}; ln store/claudeclaw.db {O}/x.db'),
    ('unknown cd then mv of the store dir', 'pushd {R}; mv store gone'),
    ('unknown cd then redirect to a db name', 'pushd store; cat {O}/claudeclaw.db > claudeclaw.db'),
    ('unknown cd then .backup to a db name', 'pushd store; sqlite3 {O}/claudeclaw.db ".backup claudeclaw.db"'),
    ('unknown cd then tee a db name', 'pushd store; echo x | tee claudeclaw.db-wal'),
    ('unknown cd then dd of= a db name', 'pushd store; dd if={O}/claudeclaw.db of=claudeclaw.db'),
    ('unknown cd then rsync --link-dest', 'pushd {R}; rsync -a --link-dest=store store/ {O}/x/'),
    ('cd in bash -c then a relative db', 'bash -c "cd store && sqlite3 claudeclaw.db \\"delete from api_tokens\\""'),
    ('cd in a substitution before the client', 'sqlite3 claudeclaw.db "delete from api_tokens" $(cd store; pwd)'),
    ('cd with a dynamic target', 'cd "$UNSET_DIR" && sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('dynamic command word then a relative db', '"$UNSET_CD" store; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd in a sourced script then a relative db', '. ./cdscript.sh; sqlite3 claudeclaw.db "delete from api_tokens"'),
    ('cd then relative .open', 'cd store && sqlite3 :memory: ".open claudeclaw.db" "delete from api_tokens"'),
    ('cd then relative ATTACH', 'cd store && sqlite3 :memory: "ATTACH \'claudeclaw.db\' AS l; delete from l.api_tokens"'),
    ('cd then file: uri', 'cd store && sqlite3 file:claudeclaw.db?mode=rw "delete from api_tokens"'),
    ('find -execdir then relative db', 'find {S} -maxdepth 0 -execdir sqlite3 claudeclaw.db "delete from api_tokens" \\;'),
    ('ssh then relative db', 'ssh localhost "sqlite3 claudeclaw.db \\"delete from api_tokens\\""'),
    ('ssh heredoc then relative db', 'ssh localhost <<EOF\nsqlite3 claudeclaw.db "delete from api_tokens"\nEOF'),
    ('tmux then relative db', 'tmux send-keys -t main "sqlite3 claudeclaw.db \\"delete from api_tokens\\"" Enter'),
    ('cd then relative store dir for the CLI', 'cd / && MARVEEN_STORE_DIR=rel/dir npx tsx scripts/dashboard-user.ts add x'),
    ('cd then store dir pointing at the live store', 'cd {R} && MARVEEN_STORE_DIR=store npx tsx scripts/dashboard-user.ts add x'),
    ('cd then exported relative store dir', 'cd {R} && export MARVEEN_STORE_DIR=../copy; npx tsx scripts/dashboard-user.ts add x'),
    ('env -C then relative store dir', 'env -C {R} MARVEEN_STORE_DIR=../copy npx tsx scripts/dashboard-user.ts add x'),
    ('git -C then relative store dir', 'git -C {R} status; MARVEEN_STORE_DIR=../copy npx tsx scripts/dashboard-user.ts add x'),
    # ---- hard links and the WAL / SHM sidecars: same file, other name ----
    ('hard link of the live DB', 'sqlite3 {H}/hard.db "delete from api_tokens"'),
    ('hard link of the live WAL', 'sqlite3 {H}/hard.db-wal "delete from api_tokens"'),
    ('hard link of the live SHM', 'sqlite3 {H}/hard.db-shm "delete from api_tokens"'),
    ('the live WAL path itself', 'sqlite3 {L}-wal "delete from api_tokens"'),
    ('a DB with two names anywhere', 'sqlite3 {T}/twin1.db "delete from api_tokens"'),
    ('attach a hard link of the live DB', 'sqlite3 {O}/claudeclaw.db "ATTACH \'{H}/hard.db\' AS x; DELETE FROM x.api_tokens"'),
    ('.open a hard link of the live DB', 'sqlite3 {O}/claudeclaw.db ".open {H}/hard.db" "DELETE FROM api_tokens"'),
    ('store dir that holds a hard link of the live DB', 'MARVEEN_STORE_DIR={HS} npx tsx scripts/dashboard-user.ts add x'),
    ('store dir that holds a symlink to the live DB', 'MARVEEN_STORE_DIR={K} npx tsx scripts/dashboard-user.ts add x'),
    ('tee into a hard link with an innocent name', 'echo x | tee {H}/blob.bin'),
    ('tee into a hard link of a second live DB', 'echo x | tee {H}/other.bin'),
    # ---- writing the live database file as a file ----
    ('cp over the live DB', 'cp {O}/claudeclaw.db {L}'),
    ('cp over the live DB, relative', 'cp ../copy/claudeclaw.db store/claudeclaw.db'),
    ('cp into the store dir', 'cp {O}/claudeclaw.db {S}/'),
    ('cp into the store dir with -t', 'cp -t {S} {O}/claudeclaw.db'),
    ('cp --target-directory=', 'cp --target-directory={S} {O}/claudeclaw.db'),
    ('cp over the live WAL', 'cp {O}/claudeclaw.db {L}-wal'),
    ('cp over the live SHM', 'cp {O}/claudeclaw.db {S}/claudeclaw.db-shm'),
    ('cp over a hard link of the live DB', 'cp {O}/claudeclaw.db {H}/hard.db'),
    ('cp over a symlink to the live DB', 'cp {O}/claudeclaw.db {K}/link.db'),
    ('cp into a symlinked store dir', 'cp {O}/claudeclaw.db {K}/storelink/claudeclaw.db'),
    ('cp after cd, relative target', 'cd {S} && cp {O}/claudeclaw.db claudeclaw.db'),
    ('cp after cd, target dot', 'cd {S} && cp {O}/claudeclaw.db .'),
    ('cp after cd, db-looking target', 'cd {R} && cp {O}/claudeclaw.db store/claudeclaw.db'),
    ('cp -l hard-link copy of the store', 'cp -al {S} {O}/clone'),
    ('cp -l hard-link copy of the live DB', 'cp -l {L} {O}/h.db'),
    ('cp --link of the live DB', 'cp --link {L} {O}/h.db'),
    ('cp -al after cd, relative store', 'cd {R} && cp -al store {O}/clone'),
    ('mv over the live DB', 'mv {O}/claudeclaw.db {L}'),
    ('mv the live DB away', 'mv {L} {O}/gone.db'),
    ('mv the live WAL away', 'mv {L}-wal {O}/gone.wal'),
    ('mv the store dir away', 'mv {S} {O}/gone'),
    ('mv into the store dir', 'mv {O}/claudeclaw.db {S}'),
    ('ln hard link of the live DB', 'ln {L} {O}/x.db'),
    ('ln -f hard link over the live DB', 'ln -f {O}/claudeclaw.db {L}'),
    ('ln -s symlink replaces the live DB', 'ln -sf {O}/claudeclaw.db {L}'),
    ('ln hard link after cd, relative source', 'cd {R} && ln store/claudeclaw.db {O}/x.db'),
    ('ln hard link of the WAL', 'ln {L}-wal {O}/x.wal'),
    ('install over the live DB', 'install -m 644 {O}/claudeclaw.db {L}'),
    ('install -t into the store', 'install -m 644 -t {S} {O}/claudeclaw.db'),
    ('rsync into the store dir', 'rsync -a {O}/ {S}/'),
    ('rsync over the live DB', 'rsync -av {O}/claudeclaw.db {L}'),
    ('rsync --link-dest the store', 'rsync -a --link-dest={S} {S}/ {O}/x/'),
    ('rsync --link-dest the store, separate word', 'rsync -a --link-dest {S} {S}/ {O}/x/'),
    ('scp over the live DB', 'scp {O}/claudeclaw.db {L}'),
    ('ditto over the live DB', 'ditto {O}/claudeclaw.db {L}'),
    ('dd of= the live DB', 'dd if={O}/claudeclaw.db of={L}'),
    ('dd of= the live WAL', 'dd if=/dev/zero of={L}-wal bs=1 count=1'),
    ('tee the live DB', 'cat {O}/claudeclaw.db | tee {L}'),
    ('tee -a the live WAL', 'echo x | tee -a {L}-wal'),
    ('redirect over the live DB', 'cat {O}/claudeclaw.db > {L}'),
    ('redirect append to the live WAL', 'echo x >> {L}-wal'),
    ('redirect truncate the live DB', ': > {L}'),
    ('redirect &> the live DB', 'cat {O}/claudeclaw.db &> {L}'),
    ('redirect after cd, relative db', 'cd {S} && cat {O}/claudeclaw.db > claudeclaw.db'),
    ('redirect with fd prefix', 'cat {O}/claudeclaw.db 1>{L}'),
    ('sqlite3 .backup into the live DB', 'sqlite3 {O}/claudeclaw.db ".backup {L}"'),
    ('sqlite3 .backup main into the store', 'sqlite3 {O}/claudeclaw.db ".backup main {S}/claudeclaw.db"'),
    ('sqlite3 .backup quoted target', 'sqlite3 {O}/claudeclaw.db ".backup \'{L}\'"'),
    ('sqlite3 .save into the live DB', 'sqlite3 {O}/claudeclaw.db ".save {L}"'),
    ('sqlite3 .clone into the live shm', 'sqlite3 {O}/claudeclaw.db ".clone {S}/claudeclaw.db-shm"'),
    ('sqlite3 .backup over a second live db', 'sqlite3 {O}/claudeclaw.db ".backup {S}/other.db"'),
    ('sqlite3 VACUUM INTO the live DB', 'sqlite3 {O}/claudeclaw.db "VACUUM INTO \'{L}\'"'),
    ('sqlite3 VACUUM main INTO the live journal', 'sqlite3 {O}/claudeclaw.db "vacuum main into \'{S}/claudeclaw.db-journal\'"'),
    ('sqlite3 VACUUM INTO after a comment', 'sqlite3 {O}/claudeclaw.db "VACUUM /* x */ INTO \'{L}\'"'),
    ('sqlite3 .backup in a heredoc', 'sqlite3 {O}/claudeclaw.db <<EOF\n.backup {L}\nEOF'),
    ('sqlite3 .backup after cd, relative', 'cd {S} && sqlite3 {O}/claudeclaw.db ".backup claudeclaw.db"'),
    ('find -fprint over the live DB', 'find . -maxdepth 0 -fprint {L}'),
    ('find -fprintf over the live WAL', 'find . -maxdepth 0 -fprintf {L}-wal x'),
    # ---- commands the gate has no handler for: the payload rides in an argument ----
    ('git alias runs the CLI', "git -c alias.x='!npm run dashboard-user add x' x"),
    ('git alias with a sh -c', "git -c alias.y='!sh -c \"npm run dashboard-user add x\"' y"),
    ('git pager runs the CLI before a safe sub-command', "git -c core.pager='npm run dashboard-user add x' log"),
    ('git rebase --exec', "git rebase --exec 'npm run dashboard-user add x' HEAD~1"),
    ('git config writes an alias', "git config alias.x '!npm run dashboard-user add x'"),
    ('awk system()', "awk 'BEGIN{system(\"npm run dashboard-user add x\")}'"),
    ('gawk pipe to getline', "gawk 'BEGIN { \"npm run dashboard-user add x\" | getline }'"),
    ('awk path in system()', "awk 'BEGIN{system(\"./scripts/dashboard-user.ts add x\")}'"),
    ('make variable carries the CLI', 'make run CMD="npm run dashboard-user add x"'),
    ('make -C with a variable', 'make -C . x ARGS="tsx scripts/dashboard-user.ts add x"'),
    ('vim -c', "vim -c '!npm run dashboard-user add x'"),
    ('ex -c', "ex -c '!npm run dashboard-user add x' notes.txt"),
    ('vim -c with a path', "vim -c '!./scripts/dashboard-user.ts add x'"),
    ('expect -c', "expect -c 'spawn npm run dashboard-user add x'"),
    ('expect heredoc', 'expect <<EOF\nspawn npm run dashboard-user add x\nEOF'),
    ('emacs --eval', "emacs --batch --eval '(shell-command \"npm run dashboard-user add x\")'"),
    ('rsync -e runs a command', "rsync -e 'npm run dashboard-user add x' a b"),
    ('docker exec runs the CLI', 'docker exec app npm run dashboard-user add x'),
    ('kubectl exec runs the CLI', 'kubectl exec pod -- npm run dashboard-user add x'),
    ('unknown client writes an auth table', 'mongo-sql-tool DELETE FROM api_tokens'),
    ('unknown tool with an SQL argument', 'unknown-tool --exec "INSERT INTO dashboard_users(username) VALUES (\'x\')"'),
    ('unknown tool with SQL in a heredoc', 'unknown-tool <<EOF\nUPDATE dashboard_users SET role=\'admin\';\nEOF'),
    ('unknown tool with a comment-split SQL', 'unknown-tool "UPDATE /* x */ api_tokens SET revoked_at=1"'),
    ('unknown tool with --password-stdin in a string', "vim -c '!some-tool add x --password-stdin'"),
    ('deno eval auth write', 'deno eval "db.exec(\'DELETE FROM api_tokens\')"'),
    ('deno eval insert', 'deno eval "db.prepare(\'INSERT INTO dashboard_users(username) VALUES (1)\').run()"'),
    ('deno eval app mutator', 'deno eval "createDashboardUser(\'x\', \'h\')"'),
    ('deno eval execs the CLI', 'deno eval "new Deno.Command(\'npm\', {args: [\'run\', \'dashboard-user\', \'add\', \'x\']}).outputSync()"'),
    ('deno run -e', 'deno run --eval "db.exec(\'DELETE FROM api_tokens\')"'),
    ('nine command shapes in one argument', "vim -c '" + '; '.join(['npm run dashboard-user list'] * 9) + "'"),
    ('tar -x into the live store dir', 'tar -xf a.tar -C {S}'),
    ('tar x (old style) into the live store dir', 'tar xf a.tar -C {S}'),
    ('tar --directory= the live store dir', 'tar -xf a.tar --directory={S}'),
    ('tar -x names the live DB as a member', 'tar -xf a.tar -C {R} store/claudeclaw.db'),
    ('tar -c writes the archive over the live DB', 'tar -cf {L} x'),
    ('tar czf over the live DB', 'tar czf {L} x'),
    ('tar -r appends to the live DB', 'tar -rf {L} x'),
    ('tar -f attached over the live DB', 'tar -c -f{L} x'),
    ('unzip -d the live store dir', 'unzip -o x.zip -d {S}'),
    ('unzip -dDIR attached', 'unzip x.zip -d{S}'),
    ('unzip names the live DB as a member', 'unzip x.zip store/claudeclaw.db -d {R}'),
    ('curl --output the live DB', 'curl --output {L} http://x'),
    ('wget --output-document the live DB', 'wget --output-document={L} http://x'),
    ('gzip the live DB (replaces it)', 'gzip {L}'),
    ('gzip -k the live DB', 'gzip -k {L}'),
    ('xz the live DB', 'xz {L}'),
    ('zip -m moves the live DB away', 'zip -m {O}/a.zip {L}'),
    ('open the live DB', 'open {L}'),
    ('gzip a hard link of the live DB', 'gzip {H}/blob.bin'),
    ('gzip a symlink to the live DB', 'gzip {K}/link.db'),
    ('gzip the live -wal', 'gzip {S}/claudeclaw.db-wal'),
    ('unknown tool --out=live', 'frobnicate --out={L}'),
    ('unknown tool -oLIVE glued', 'frobnicate -o{L}'),
    ('unknown tool of=live', 'dcfldd if=x of={L}'),
    ('gzip a dynamic path that ends in the store tail', 'gzip $X/store/claudeclaw.db'),
    ('an unknown command is handed the live DB path (not a function of the text)', 'add_if list {R} store/claudeclaw.db'),
    ('a name that is no function of the text is judged like any command', 'cnt {L}'),
    ('sudo gzip the live DB', 'sudo gzip {L}'),
    ('nohup gzip the live DB', 'nohup gzip {L}'),
    ('xargs gzip the live DB', 'echo {L} | xargs gzip'),
    ('after a relative cd the live name still counts', 'cd store && gzip claudeclaw.db'),
    ('after a relative cd the -wal name still counts', 'cd store && gzip claudeclaw.db-wal'),
    ('link hardlinks the live DB', 'link {L} {O}/copy.db'),
    ('link hardlinks a hard link of the live DB', 'link {H}/hard.db {O}/c'),
    ('cpio -p -l of the live DB', 'echo {L} | cpio -pdl {O}/x'),
    ('cpio -p -l of the live store dir', 'find {S} -type f | cpio -pdl {O}/x'),
    ('cpio -p -l with a list the gate cannot see', 'cat list.txt | cpio -pdl {O}/x'),
    ('cpio -p into the live store dir', 'find {O} -type f | cpio -pd {S}'),
    ('cpio -o archive over the live DB', 'find {O} -type f | cpio -o -O {L}'),
    ('pax -rw -l of the live store dir', 'pax -rw -l {S} {O}/x'),
    ('pax -rw into the live store dir', 'pax -rw {O}/f {S}'),
    ('pax -w archive over the live DB', 'pax -w -f {L} {O}/f'),
    ('sqlite3 writefile() the live DB', 'sqlite3 {O}/a.db "select writefile(\'{L}\', x\'00\')"'),
    ('sqlite3 writefile() the live -wal', 'sqlite3 {O}/a.db "select writefile(\'{S}/claudeclaw.db-wal\', x\'00\')"'),
    ('sqlite3 writefile() joined path', 'sqlite3 {O}/a.db "select writefile(\'{S}/\' || \'claudeclaw.db\', x\'00\')"'),
    ('sqlite3 writefile() with a parameter', 'sqlite3 {O}/a.db "select writefile(:p, x\'00\')"'),
    ('sqlite3 writefile() with a comment before the paren', 'sqlite3 {O}/a.db "select writefile /* x */ (\'{L}\', x\'00\')"'),
    ('sqlite3 quoted writefile name', 'sqlite3 {O}/a.db "select \\"writefile\\"(\'{L}\', x\'00\')"'),
    ('sqlite3 .output the live DB', 'sqlite3 {O}/a.db ".output {L}" "select 1"'),
    ('sqlite3 .once the live DB', 'sqlite3 {O}/a.db ".once {L}" "select 1"'),
    ('sqlite3 .log the live DB', 'sqlite3 {O}/a.db ".log {L}" "select 1"'),
    ('sqlite3 .trace the live DB', 'sqlite3 {O}/a.db ".trace {L}" "select 1"'),
    ('sqlite3 .output prefix .outp', 'sqlite3 {O}/a.db ".outp \'{L}\'" "select 1"'),
    ('sqlite3 .backup prefix .bac', 'sqlite3 {O}/a.db ".bac {L}"'),
    ('sqlite3 .output with an option', 'sqlite3 {O}/a.db ".output -x {L}"'),
    ('sqlite3 .output |command', 'sqlite3 {O}/a.db ".output |sh"'),
    ('sqlite3 .once -e (editor)', 'sqlite3 {O}/a.db ".once -e"'),
    ('sqlite3 .shell prefix .sh', 'sqlite3 {O}/a.db ".sh id"'),
    ('sqlite3 .system prefix .sys', 'sqlite3 {O}/a.db ".sys id"'),
    ('sqlite3 edit() runs an editor', 'sqlite3 {O}/a.db "select edit(\'x\', \'sh\')"'),
    ('sqlite3 .imp prefix on the live DB', 'sqlite3 {L} ".imp x.csv t"'),
    ('sqlite3 .op prefix opens the live DB', 'sqlite3 {O}/a.db ".op {L}" "update dashboard_users set role = \'admin\'"'),
    ('sqlite3 .rea prefix reads a script with an auth write', 'sqlite3 {L} ".rea {R}/bad.sql"'),
    ('VACUUM INTO the live DB with a line comment between the words', 'sqlite3 {O}/a.db "vacuum -- c\n into \'{L}\'"'),
    ('VACUUM INTO the live DB with a comment before the literal', 'sqlite3 {O}/a.db "vacuum into -- c\n \'{L}\'"'),
    ('VACUUM INTO the live DB with a block comment', 'sqlite3 {O}/a.db "vacuum /* c */ into \'{L}\'"'),
    ('VACUUM main INTO the live DB', 'sqlite3 {O}/a.db "vacuum main into \'{L}\'"'),
    ('VACUUM "main" INTO the live DB', 'sqlite3 {O}/a.db "vacuum \\"main\\" into \'{L}\'"'),
    ('VACUUM [main] INTO the live DB', 'sqlite3 {O}/a.db "vacuum [main] into \'{L}\'"'),
    ('VACUUM INTO a joined path', 'sqlite3 {O}/a.db "vacuum into \'{S}/\' || \'claudeclaw.db\'"'),
    ('VACUUM INTO a parenthesised literal', 'sqlite3 {O}/a.db "vacuum into (\'{O}/x.db\')"'),
    ('VACUUM INTO a function call', 'sqlite3 {O}/a.db "vacuum into lower(\'{O}/X.db\')"'),
    ('VACUUM INTO a parameter', 'sqlite3 {O}/a.db "vacuum into :p"'),
    ('writable_schema + UPDATE sqlite_master on the live DB', 'sqlite3 {L} "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=\'x\' WHERE name=\'dashboard_users\'"'),
    ('DELETE FROM sqlite_master on the live DB', 'sqlite3 {L} "PRAGMA writable_schema=1; DELETE FROM sqlite_master WHERE name=\'api_tokens\'"'),
    ('writable_schema alone on the live DB', 'sqlite3 {L} "pragma main.writable_schema = true"'),
    ('UPDATE sqlite_schema on the live DB', 'sqlite3 {L} "update sqlite_schema set sql=1"'),
    ('python writes sqlite_master', 'python3 -c "import sqlite3; c=sqlite3.connect(\'{L}\'); c.execute(\'PRAGMA writable_schema=ON\')"'),
    ('VACUUM INTO after a dot-command line with an apostrophe', 'sqlite3 {O}/a.db ".print it\'s\nvacuum into lower(\'X\')"'),
]

ALLOWED = [
    # ---- the read-only CLI form ----
    ('npm run list', 'npm run dashboard-user -- list'),
    ('writable_schema on a copy elsewhere', 'sqlite3 {O}/a.db "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=1"'),
    ('reading sqlite_master on the live DB', 'sqlite3 {L} "select name from sqlite_master"'),
    ('npm run list no --', 'npm run dashboard-user list'),
    ('tsx list', 'tsx scripts/dashboard-user.ts list'),
    ('npx tsx list', 'npx tsx scripts/dashboard-user.ts list'),
    ('node compiled list', 'node dist/scripts/dashboard-user.js list'),
    ('list piped', 'npm run dashboard-user -- list | head -5'),
    ('list redirected', 'npm run dashboard-user -- list > /tmp/users.txt 2>&1'),
    # ---- prose and files that only NAME the CLI ----
    ('commit message', 'git commit -m "docs: mention npm run dashboard-user -- add in the guide"'),
    ('echo prose', 'echo "run npm run dashboard-user -- add bob on the machine"'),
    ('printf prose', "printf '%s\\n' 'npm run dashboard-user add bob'"),
    ('comment line', '# npm run dashboard-user add bob\necho hi'),
    ('cat the script', 'cat scripts/dashboard-user.ts'),
    ('grep for it', 'grep -rn "dashboard-user" package.json docs'),
    ('rg for the verb', 'rg "reset-password" scripts'),
    ('git add the script', 'git add scripts/dashboard-user.ts'),
    ('git diff the script', 'git diff -- scripts/dashboard-user.ts'),
    ('wc the script', 'wc -l scripts/dashboard-user.ts scripts/security-reset.sh'),
    ('ls scripts', 'ls scripts/dashboard-user* scripts/security-reset*'),
    ('sed the docs', 'sed -i "" "s/dashboard-user/dashboard-user/" docs/x.md'),
    ('heredoc into a doc', 'cat > docs/x.md <<EOF\nRun npm run dashboard-user -- add bob.\nEOF'),
    ('heredoc quoted with $() text', "cat > docs/x.md <<'EOF'\nuse $(npm run dashboard-user add bob) never\nEOF"),
    ('heredoc into a doc, then work', 'cat > /tmp/f <<EOF\nplain text\nEOF\nls'),
    ('git commit heredoc message', 'git commit -m "$(cat <<\'EOF\'\nfix: dashboard-user list output\n\nCo-Authored-By: someone\nEOF\n)"'),
    ('vitest filter', 'npx vitest run dashboard-user'),
    ('vitest file', 'npx vitest run src/__tests__/dashboard-user-format.test.ts'),
    ('npm test filter', 'npm test -- dashboard-user'),
    ('npm run test filter', 'npm run test -- dashboard-user'),
    ('node test file with name', 'node --test src/__tests__/dashboard-user-format.test.js'),
    ('tsc the script', 'npx tsc --noEmit scripts/dashboard-user.ts'),
    ('node --check', 'node --check scripts/dashboard-user.ts'),
    ('npm run other', 'npm run build'),
    ('npm run dashboard-url', 'npm run dashboard-url'),
    ('tsx other script', 'tsx scripts/dashboard-url.ts'),
    ('python3 script file', 'python3 scripts/__tests__/gates-token-failclosed.test.py'),
    ('python3 prints', 'python3 -c "print(1)"'),
    ('python3 doc edit naming the CLI', 'python3 - <<PY\nopen("docs/x.md", "w").write("run npm run dashboard-user -- list")\nPY'),
    ('node -e unrelated', 'node -e "console.log(1)"'),
    ('bash -c unrelated', 'bash -c "echo hi"'),
    ('bash script ok', 'bash ok.sh'),
    ('bash script missing', 'bash does-not-exist.sh'),
    ('bash heredoc unrelated', 'bash <<EOF\necho hi\nEOF'),
    ('eval unrelated', 'eval "echo hi"'),
    ('eval ssh-agent', 'eval "$(ssh-agent -s)"'),
    ('export then echo', 'export X=dashboard-user; echo $X'),
    ('var then grep', 'X=dashboard-user; grep -n $X package.json'),
    ('tmux unrelated', 'tmux send-keys -t main "ls -la" Enter'),
    ('tmux list', 'tmux list-sessions'),
    ('ssh unrelated', 'ssh host "ls"'),
    ('osascript unrelated', "osascript -e 'display notification \"hi\"'"),
    ('find exec unrelated', 'find . -name "*.ts" -exec wc -l {} \\;'),
    ('xargs unrelated', 'ls | xargs wc -l'),
    ('echo into xargs unrelated', 'echo a b | xargs echo'),
    ('timeout unrelated', 'timeout 5 npm run build'),
    ('for loop unrelated', 'for f in a b; do echo $f; done'),
    ('docker login stdin', 'echo $TOKEN | docker login -u x --password-stdin ghcr.io'),
    ('podman login stdin', 'podman login --password-stdin -u x registry'),
    ('echo with $((', 'echo $((1+2))'),
    ('curl pipe nothing known', 'curl -s http://localhost:3420/api/health'),
    ('git log -S sql', 'git log -S"DELETE FROM api_tokens" --oneline'),
    ('grep sql in src', 'grep -rn "INSERT INTO api_tokens" src'),
    ('rg sql in src', 'rg "UPDATE dashboard_users" src'),
    ('echo sql', 'echo "UPDATE dashboard_users SET role=1"'),
    # ---- SQL: reads and unrelated writes on the live store ----
    ('sqlite3 select users', 'sqlite3 -readonly {L} "SELECT username, role FROM dashboard_users"'),
    ('sqlite3 select tokens count', 'sqlite3 {L} "SELECT count(*) FROM api_tokens"'),
    ('sqlite3 select sessions', 'sqlite3 {L} "select * from auth_sessions"'),
    ('sqlite3 select approvals', 'sqlite3 {L} "SELECT id, status FROM approvals ORDER BY id DESC LIMIT 5"'),
    ('sqlite3 .dump', 'sqlite3 {L} ".dump"'),
    ('sqlite3 .schema', 'sqlite3 {L} ".schema api_tokens"'),
    ('sqlite3 .tables', 'sqlite3 {L} ".tables"'),
    ('sqlite3 pragma read', 'sqlite3 {L} "PRAGMA table_info(dashboard_users)"'),
    ('sqlite3 select with sub-select', 'sqlite3 {L} "SELECT * FROM kanban_cards WHERE x IN (SELECT id FROM api_tokens)"'),
    ('sqlite3 insert-select reads auth table', 'sqlite3 {L} "INSERT INTO memories(x) SELECT username FROM dashboard_users"'),
    ('sqlite3 update unrelated', 'sqlite3 {L} "UPDATE kanban_cards SET status=\'done\' WHERE id=1"'),
    ('sqlite3 insert unrelated', 'sqlite3 {L} "INSERT INTO memories(content) VALUES (\'x\')"'),
    ('sqlite3 delete unrelated', 'sqlite3 {L} "DELETE FROM idea_box WHERE id=1"'),
    ('sqlite3 update tokens usage table', 'sqlite3 {L} "UPDATE token_usage SET x=1"'),
    ('sqlite3 update chat sessions table', 'sqlite3 {L} "UPDATE sessions SET message_count=0"'),
    ('sqlite3 file select', 'sqlite3 {L} < {R}/ok.sql'),
    ('sqlite3 read ok', 'sqlite3 {L} ".read {R}/ok.sql"'),
    ('sqlite3 live backup out', 'sqlite3 {L} ".backup {O}/b.db"'),
    ('sqlite3 here-string select', 'sqlite3 {L} <<< "SELECT 1"'),
    # ---- SQL: a COPY of the DB is the QA instances' own business ----
    ('sqlite3 copy update users', 'sqlite3 {O}/claudeclaw.db "UPDATE dashboard_users SET role=\'admin\'"'),
    ('sqlite3 copy delete tokens', 'sqlite3 {O}/claudeclaw.db "DELETE FROM api_tokens"'),
    ('sqlite3 copy heredoc', 'sqlite3 {O}/claudeclaw.db <<EOF\nINSERT INTO api_tokens(id) VALUES (1);\nEOF'),
    ('sqlite3 copy relative, no cd (the cwd is the event cwd)', 'sqlite3 ../copy/claudeclaw.db "DELETE FROM approvals"'),
    ('sqlite3 copy relative ./ no cd', 'sqlite3 ./../copy/claudeclaw.db "DELETE FROM approvals"'),
    ('sqlite3 copy relative after a cd into the copy (the cd target is followed)', 'cd {O} && sqlite3 claudeclaw.db "DELETE FROM approvals"'),
    ('sqlite3 copy relative after a cd to an absolute dir, with ./', 'cd {O}; sqlite3 ./claudeclaw.db "DELETE FROM approvals"'),
    ('sqlite3 copy absolute after a cd', 'cd {O} && sqlite3 {O}/claudeclaw.db "DELETE FROM approvals"'),
    ('cd then cp of unrelated names, unknown cd', 'cd .. && cp {O}/x.json {O}/y.json'),
    ('unknown cd then mv of unrelated names', 'pushd {R}; mv ok.sh {O}/ok2.sh'),
    ('unknown cd then cp -r of a code dir', 'pushd {R}; cp -r scripts {O}/scripts-copy'),
    ('unknown cd then redirect to a plain name', 'pushd store; echo x > note.txt'),
    ('unknown cd then select on a relative live db', 'pushd store; sqlite3 claudeclaw.db "SELECT count(*) FROM api_tokens"'),
    ('sqlite3 copy absolute after pushd', 'pushd {O}; sqlite3 {O}/claudeclaw.db "DELETE FROM approvals"; popd'),
    ('sqlite3 copy absolute after env -C', 'env -C {O} sqlite3 {O}/claudeclaw.db "DELETE FROM approvals"'),
    ('sqlite3 memory db after a cd', 'cd {O} && sqlite3 :memory: "CREATE TABLE api_tokens(id); INSERT INTO api_tokens VALUES (1)"'),
    ('sqlite3 relative live select after a cd', 'cd store && sqlite3 claudeclaw.db "SELECT count(*) FROM api_tokens"'),
    ('cd then ls', 'cd {R} && ls'),
    ('cd then a build', 'cd {R} && npm run build'),
    ('git -C status', 'git -C {R} status'),
    ('two names of a non-live file, only reading', 'sqlite3 {T}/twin1.db "SELECT * FROM api_tokens"'),
    ('sqlite3 memory db', 'sqlite3 :memory: "CREATE TABLE api_tokens(id); INSERT INTO api_tokens VALUES (1)"'),
    ('sqlite3 no db, stdin', 'sqlite3 <<EOF\nCREATE TABLE api_tokens(id);\nINSERT INTO api_tokens VALUES (1);\nEOF'),
    ('sqlite3 copy .import', 'sqlite3 {O}/claudeclaw.db ".import rows.csv dashboard_users"'),
    ('sqlite3 copy decoded input', 'zcat dump.sql.gz | sqlite3 {O}/copy.db'),
    ('sqlite3 copy attach copy', 'sqlite3 {O}/claudeclaw.db "ATTACH \'{O}/claudeclaw.db\' AS y; DELETE FROM y.api_tokens"'),
    ('sqlite3 copy .open copy', 'sqlite3 {O}/claudeclaw.db ".open {O}/claudeclaw.db" "DELETE FROM api_tokens"'),
    # ---- interpreter code: reads and unrelated writes ----
    ('python select', 'python3 -c "import sqlite3; print(sqlite3.connect(\'x.db\').execute(\'SELECT * FROM dashboard_users\').fetchall())"'),
    ('python heredoc select', 'python3 - <<PY\nimport sqlite3\nprint(sqlite3.connect(DB).execute("SELECT count(*) FROM api_tokens").fetchone())\nPY'),
    ('python unrelated update', 'python3 - <<PY\nc.execute("UPDATE kanban_cards SET status=\'done\' WHERE id=1")\nPY'),
    ('python heredoc w/o exec api naming the CLI', 'python3 - <<PY\nprint("use dashboard-user")\nPY'),
    ('node select', 'node -e "db.prepare(\'SELECT * FROM device_keys\').all()"'),
    ('node unrelated insert', 'node -e "db.exec(\'INSERT INTO memories VALUES (1)\')"'),
    ('node reads via listApiTokenRows', 'node -e "console.log(listApiTokenRows())"'),
    ('node getValidApiToken', 'node -e "console.log(getValidApiToken(\'x\'))"'),
    # ---- QA flows on a throw-away store (MARVEEN_STORE_DIR outside the live store) ----
    ('isolated store, CLI add', 'MARVEEN_STORE_DIR={O} npx tsx scripts/dashboard-user.ts add bob'),
    ('isolated store, password-stdin', "echo pw | MARVEEN_STORE_DIR={O} npx tsx scripts/dashboard-user.ts add bob --password-stdin"),
    ('isolated store, env form', 'env MARVEEN_STORE_DIR={O} npm run dashboard-user -- add bob'),
    ('isolated store, variable form', 'S={O}; echo pw | MARVEEN_STORE_DIR=$S npx tsx scripts/dashboard-user.ts add bob --password-stdin'),
    ('isolated store, export form', 'export MARVEEN_STORE_DIR={O}; npx tsx scripts/dashboard-user.ts reset-password bob'),
    ('isolated store, quoted', 'MARVEEN_STORE_DIR="{O}" HOME="{O}" npx tsx scripts/dashboard-user.ts add bob'),
    # ---- code that only talks ABOUT the CLI / auth names ----
    ('python status message naming the CLI + a subprocess', 'python3 << \'PYEOF\'\nimport json, subprocess\ncontent = """status: dashboard-user list works, 3 tests green"""\nsubprocess.run(["curl", "-s", "http://localhost:3420/api/messages", "-d", json.dumps({"content": content})])\nPYEOF'),
    ('python source edit naming a mutator', 'python3 - <<EOF\np = "src/agent-tokens.ts"\ns = open(p).read()\ns = s.replace("import { getDb, insertApiToken } from", "import { getDb, insertApiToken, revokeApiToken } from")\nopen(p, "w").write(s)\nEOF'),
    ('python source edit with a template literal', 'python3 - <<EOF\nnew = "return tenantId ? `tenant=${tenantId}` : \'tenant=global\'"\nimport subprocess\nsubprocess.run(["git", "add", "-A"])\nEOF'),
    # ---- relative isolated store without a cd; the symlinks / hard links dirs are not the copy dir ----
    ('isolated store, relative, no cd', 'MARVEEN_STORE_DIR=../copy npx tsx scripts/dashboard-user.ts add bob'),
    ('isolated store, relative export, no cd', 'export MARVEEN_STORE_DIR=../copy; npx tsx scripts/dashboard-user.ts add bob'),
    ('isolated store, absolute after a cd', 'cd {R} && MARVEEN_STORE_DIR={O} npx tsx scripts/dashboard-user.ts add bob'),
    ('isolated store, a dir that does not exist yet', 'MARVEEN_STORE_DIR={O}/fresh npx tsx scripts/dashboard-user.ts add bob'),
    # ---- copying FROM the live store is how QA instances start; unrelated copies / writes ----
    ('cp the live DB out', 'cp {L} {O}/claudeclaw-qa.db'),
    ('cp the live DB out, relative', 'cp store/claudeclaw.db ../copy/claudeclaw-qa.db'),
    ('cp the live DB with its sidecars out', 'cp {L} {L}-wal {L}-shm {O}/'),
    ('cp -a the store out', 'cp -a {S} {O}/store-copy'),
    ('cp a copy onto a copy', 'cp {O}/claudeclaw.db {O}/other.db'),
    ('cp after cd, unrelated names', 'cd {R} && cp scripts/dashboard-use1.ts {O}/x.ts'),
    ('cp -r after cd, no db names', 'cd {R} && cp -r scripts {O}/scripts-copy'),
    ('mv unrelated', 'mv {O}/other.db {O}/other2.db'),
    ('mv unrelated after cd', 'cd {R} && mv ok.sh {O}/ok2.sh'),
    ('ln -s a symlink to the live DB', 'ln -s {L} {O}/s.db'),
    ('ln hard link of a copy', 'ln {O}/claudeclaw.db {O}/h2.db-copy'),
    ('rg for the SQL text', 'rg "insert into api_tokens" src'),
    ('grep -rn for the SQL text', 'grep -rn "update dashboard_users" src'),
    ('gh pr create with the SQL text in the body', 'gh pr create --body "docs: INSERT INTO api_tokens is blocked"'),
    ('gh pr view', 'gh pr view 12 --json title'),
    ('man ls', 'man ls'),
    ('less -N', 'less -N {O}/x'),
    ('sort -u', 'sort -u {O}/x'),
    ('sed -n print', "sed -n '1,5p' {O}/x"),
    ('sed in a pipe', "sed 's/a/b/' {O}/x | sort | head"),
    ('git log --oneline', 'git log --oneline -5'),
    ('git diff --stat', 'git diff --stat'),
    ('git log --output into a copy dir', 'git log --output={O}/log.txt'),
    ('git grep -n', 'git grep -n foo -- src'),
    ('git cherry-pick -x', 'git cherry-pick -x abc123'),
    ('chmod on a copy', 'chmod 644 {O}/claudeclaw.db'),
    ('truncate a copy', 'truncate -s 0 {O}/a.db'),
    ('rm a state file in the store dir', 'rm {S}/note.json'),
    ('touch a new file in a copy dir', 'touch {O}/new'),
    ('sed -i on a plain file', "sed -i 's/a/b/' {O}/x.txt"),
    ('sort -o into a copy dir', 'sort -o {O}/sorted {O}/x'),
    ('curl -o into a copy dir', 'curl -o {O}/page.html http://x'),
    ('wget -q', 'wget -q http://x'),
    ('throw-away store CLI with an unrelated ln in the command', 'ln -sf {O}/claudeclaw.db {T}/unrelated-link2; echo pw | MARVEEN_STORE_DIR={O} npx tsx scripts/dashboard-user.ts add x --password-stdin'),
    ('cp a copy named like the live db, with an unrelated ln in the command', 'cp {L} {O}/fresh-copy/claudeclaw.db; ln -sf {O}/claudeclaw.db {O}/unrelated-link'),
    ('install unrelated', 'install -m 644 {R}/ok.sh {O}/ok.sh'),
    ('install from the live DB', 'install -m 644 {L} {O}/x.db'),
    ('rsync the store out', 'rsync -a {S}/ {O}/x/'),
    ('rsync unrelated', 'rsync -a {R}/scripts/ {O}/scripts/'),
    ('dd from the live DB', 'dd if={L} of={O}/x.db'),
    ('tee into a copy', 'echo x | tee {O}/log.txt'),
    ('tee -a into a copy', 'echo x | tee -a {O}/log.txt'),
    ('redirect into a copy', 'echo hi > {O}/x.txt'),
    ('redirect a dump out', 'sqlite3 {L} .dump > {O}/dump.sql'),
    ('redirect a dump out, append', 'sqlite3 {L} .dump >> {O}/dump.sql'),
    ('state file in the store dir (redirect)', 'echo x > {S}/note.txt'),
    ('state file in the store dir (tee)', 'echo x | tee {S}/note.json'),
    ('state file in the store dir (cp)', 'cp {O}/claudeclaw.db.txt {S}/note.txt'),
    ('a new backup db next to the live one', 'sqlite3 {L} ".backup {S}/pre-x-backup.db"'),
    ('cp a plain file into a store subdir', 'cp {O}/x.json {S}/backups/x.json'),
    ('QA script truncates its own copy through a variable', ': > $S/claudeclaw.db'),
    ('for loop whose list holds SQL text', "for c in 'sqlite3 x \"DELETE FROM api_tokens\"'; do echo $c; done"),
    ('redirect to /dev/null and stderr', 'ls {S} > /dev/null 2>&1; ls 2>/dev/null'),
    ('redirect fd dup', 'ls {S} 2>&1 >&2'),
    ('sqlite3 .backup out of the live DB', 'sqlite3 {L} ".backup {O}/b2.db"'),
    ('sqlite3 .clone out of the live DB', 'sqlite3 {L} ".clone {O}/c.db"'),
    ('sqlite3 VACUUM INTO a copy', 'sqlite3 {L} "VACUUM INTO \'{O}/v.db\'"'),
    ('sqlite3 .backup of a copy to a copy', 'sqlite3 {O}/claudeclaw.db ".backup {O}/b3.db"'),
    ('sqlite3 select vacuum word', 'sqlite3 {O}/claudeclaw.db "SELECT \'vacuum into the void\'"'),
    ('find -fprint into a copy', 'find . -maxdepth 0 -fprint {O}/found.txt'),
    # ---- the generic argument fallback must not turn prose into a block ----
    ('echo CLI shape', 'echo "npm run dashboard-user add x"'),
    ('echo SQL', 'echo "INSERT INTO api_tokens VALUES (1)"'),
    ('git commit -m naming the CLI', 'git commit -m "docs: npm run dashboard-user"'),
    ('git commit -m naming an auth-table write', 'git commit -m "fix: update api_tokens handling"'),
    ('git commit -am', 'git commit -am "chore: tsx scripts/dashboard-user.ts is documented"'),
    ('git -c user.name commit', 'git -c user.name=x commit -m "npm run dashboard-user add"'),
    ('git log --grep', 'git log --grep "npm run dashboard-user add" --oneline'),
    ('git tag -m', 'git tag -a v1 -m "note: npm run dashboard-user"'),
    ('git stash push -m', 'git stash push -m "wip: DELETE FROM api_tokens docs"'),
    ('git status', 'git status'),
    ('git diff the script', 'git diff --stat -- scripts/dashboard-user.ts'),
    ('git -C commit', 'git -C {R} commit -m "docs: npm run dashboard-user"'),
    ('grep the CLI shape', 'grep -rn "npm run dashboard-user" docs'),
    ('rg the CLI shape', 'rg "tsx scripts/dashboard-user.ts" docs'),
    ('gh pr body naming the CLI', 'gh pr create --title t --body "run npm run dashboard-user -- add bob on the box"'),
    ('curl data naming the CLI', 'curl -s -d \'{"content":"npm run dashboard-user add x is blocked"}\' http://localhost:3420/api/messages'),
    ('curl data naming SQL', 'curl -s -d \'{"content":"DELETE FROM api_tokens is blocked"}\' http://localhost:3420/api/messages'),
    ('make plain', 'make -C . x'),
    ('make test', 'make test'),
    ('awk plain', "awk '{print $1}' notes.txt"),
    ('awk with a pipe field separator', "awk -F'|' '{print $2}' notes.txt"),
    ('awk naming the CLI as data', "awk '/dashboard-user/ {print}' notes.txt"),
    ('vim plain', 'vim notes.txt'),
    ('vim -c plain', "vim -c 'set number' notes.txt"),
    ('expect -f', 'expect -f script.exp'),
    ('docker exec list', 'docker exec app npm run dashboard-user -- list'),
    ('kubectl exec unrelated', 'kubectl exec pod -- npm test'),
    ('unknown tool, unrelated SQL read', 'unknown-tool "SELECT * FROM api_tokens"'),
    ('unknown tool, unrelated write', 'unknown-tool "UPDATE kanban_cards SET status=1"'),
    ('unknown tool with a heredoc, unrelated', 'unknown-tool <<EOF\nhello\nEOF'),
    ('deno eval plain', 'deno eval "console.log(1)"'),
    ('deno eval select', 'deno eval "db.prepare(\'SELECT * FROM api_tokens\').all()"'),
    ('deno run file', 'deno run -A scripts/x.ts'),
    ('jq plain', "jq '.a' x.json"),
    ('sed plain', "sed 's/a/b/' x.txt"),
    ('cat heredoc naming the CLI', 'cat <<EOF\nnpm run dashboard-user add x\nEOF'),
    ('tee heredoc naming the CLI', 'tee docs/x.md <<EOF\nrun npm run dashboard-user -- add bob\nEOF'),
    ('ls the live DB', 'ls -la {L}'),
    ('cat the live DB', 'cat {L} | head -c 16'),
    ('stat the live DB', 'stat {L}'),
    ('wc the live DB', 'wc -c {L}'),
    ('sha256sum the live DB', 'sha256sum {L}'),
    ('shasum the live DB', 'shasum -a 256 {L}'),
    ('xxd the live DB', 'xxd {L} | head'),
    ('strings the live DB', 'strings {L} | head'),
    ('file the live DB', 'file {L}'),
    ('du the live DB', 'du -h {L}'),
    ('grep the live DB', 'grep -c SQLite {L}'),
    ('diff the live DB with its copy', 'diff -q {L} {O}/claudeclaw.db'),
    ('lsof the live DB', 'lsof {L}'),
    ('test -f the live DB', 'test -f {L} && echo yes'),
    ('[ -f ] the live DB', '[ -f {L} ] && echo yes'),
    ('realpath the live DB', 'realpath {L}'),
    ('tar -tf the live DB', 'tar -tf {L}'),
    ('tar --list -f the live DB', 'tar --list -f {L}'),
    ('tar -c backs the live DB up into a copy dir', 'tar -czf {O}/b.tgz -C {S} claudeclaw.db'),
    ('tar -c of the live DB path', 'tar -cf {O}/a.tar {L}'),
    ('tar -c of the store dir', 'tar -czf {O}/s.tgz -C {R} store'),
    ('tar -x into a copy dir', 'tar -xf a.tar -C {O}'),
    ('tar -xzf a member into a copy dir', 'tar -xzf a.tgz -C {O} x.txt'),
    ('unzip -d a copy dir', 'unzip x.zip -d {O}'),
    ('unzip -l lists', 'unzip -l x.zip -d {S}'),
    ('cp the live DB into a copy dir', 'cp {L} {O}/c.db'),
    ('rsync the live DB into a copy dir', 'rsync -a {L} {O}/c.db'),
    ('sqlite3 reads the live DB', 'sqlite3 {L} "select count(*) from kanban_cards"'),
    ('ls the store dir', 'ls -la {S}/'),
    ('rg in the store dir', 'rg x {S}'),
    ('git status with a prose mention', 'git commit -m "docs: the store/claudeclaw.db file is the live DB"'),
    ('gh pr create body mentions the live DB', 'gh pr create --title t --body "the gate guards store/claudeclaw.db"'),
    ('gzip a copy', 'gzip -k {O}/claudeclaw.db'),
    ('gzip a state file in the store dir', 'gzip {S}/note.json'),
    ('QA script gzips its own copy through a variable', 'cd sub && gzip $S/claudeclaw.db'),
    ('a dynamic name part is only judged by the store-tail hint', 'cd sub && gzip claudeclaw$N.db'),
    ('mkdir a dynamic store dir', 'mkdir -p $X/store $X/home'),
    ('a script function is handed the live DB path (backup.sh add_if)', 'add_if() {\n  test -e "$1/$2" && echo "$2"\n}\nadd_if list {R} store/claudeclaw.db'),
    ('a `function` keyword function is handed the live DB path', 'function cnt { wc -c "$1"; }\ncnt {L}'),
    ('after a relative cd an ordinary name passes', 'cd sub && gzip notes.txt'),
    ('flag glued value that is no path', 'frobnicate -vvv --level=3'),
    ('link between two copies', 'link {O}/a {O}/b'),
    ('cpio -p -l of a copy', 'echo {O}/f | cpio -pdl {O}/x'),
    ('cpio -p of a copy dir', 'find {O} -type f | cpio -pd {O}/y'),
    ('pax -rw copies without -l', 'pax -rw {S} {O}/x'),
    ('pax -rw -l copies', 'pax -rw -l {O}/a {O}/b'),
    ('sqlite3 writefile() into a copy dir', 'sqlite3 {O}/a.db "select writefile(\'{O}/o.bin\', x\'00\')"'),
    ('sqlite3 readfile() of the live DB', 'sqlite3 {O}/a.db "select length(readfile(\'{L}\'))"'),
    ('sqlite3 writefile word inside a string', 'sqlite3 {O}/a.db "select \'writefile(\' || 1"'),
    ('sqlite3 .output to a copy file', 'sqlite3 {O}/a.db ".output {O}/dump.sql" .dump'),
    ('sqlite3 .output stdout', 'sqlite3 {O}/a.db ".output stdout" "select 1"'),
    ('sqlite3 .once to a copy file', 'sqlite3 {O}/a.db ".once {O}/o.txt" "select 1"'),
    ('sqlite3 .excel', 'sqlite3 {O}/a.db ".excel" "select 1"'),
    ('sqlite3 .log off', 'sqlite3 {O}/a.db ".log off" "select 1"'),
    ('sqlite3 .trace stdout', 'sqlite3 {O}/a.db ".trace stdout" "select 1"'),
    ('sqlite3 .save a copy', 'sqlite3 {O}/a.db ".save {O}/b.db"'),
    ('VACUUM INTO a copy', 'sqlite3 {O}/a.db "vacuum into \'{O}/c.db\'"'),
    ('VACUUM main INTO a copy', 'sqlite3 {O}/a.db "vacuum main into \'{O}/c.db\';"'),
    ('VACUUM INTO a copy with comments', 'sqlite3 {O}/a.db "select 1; -- hi\nvacuum -- c\n into /* x */ \'{O}/z.db\'"'),
    ('VACUUM INTO a copy, double-quoted literal', 'sqlite3 {O}/a.db "vacuum into \\"{O}/c.db\\""'),
    ('plain VACUUM', 'sqlite3 {O}/a.db "vacuum;"'),
    ('VACUUM INTO words inside a string literal', 'sqlite3 {O}/a.db "select \'a\'\'; vacuum into lower(\'\'X\'\')\'"'),
    ('edit word inside a string', 'sqlite3 {O}/a.db "select \'edit(x)\'"'),
]


def table_failures(mod):
    """Run both tables against a gate module; return a list of failure descriptions."""
    fails = []
    for label, cmd in BLOCKED:
        c = FX.sub(cmd)
        try:
            mod.inspect(c, FX.root)
            fails.append('NOT BLOCKED: %s :: %s' % (label, cmd[:100]))
        except (mod.Deny, mod.InspectionLimit, mod.Opaque):
            pass
        except Exception as exc:   # an internal error is fail-closed in main(), but is a bug here
            fails.append('CRASH %s: %s :: %s' % (type(exc).__name__, exc, label))
    for label, cmd in ALLOWED:
        c = FX.sub(cmd)
        try:
            mod.inspect(c, FX.root)
        except (mod.Deny, mod.InspectionLimit, mod.Opaque) as exc:
            fails.append('WRONGLY BLOCKED: %s :: %s :: %s' % (label, cmd[:100], getattr(exc, 'reason', exc)))
        except Exception as exc:
            fails.append('CRASH %s: %s :: %s' % (type(exc).__name__, exc, label))
    return fails


GATE = load_gate()


class TestTable(unittest.TestCase):
    def test_blocked_shapes_are_blocked(self):
        fails = [f for f in table_failures(GATE) if f.startswith('NOT BLOCKED')]
        self.assertEqual(fails, [], '\n' + '\n'.join(fails))

    def test_allowed_shapes_pass(self):
        fails = [f for f in table_failures(GATE) if f.startswith('WRONGLY')]
        self.assertEqual(fails, [], '\n' + '\n'.join(fails))

    def test_no_row_crashes_the_gate(self):
        fails = [f for f in table_failures(GATE) if f.startswith('CRASH')]
        self.assertEqual(fails, [], '\n' + '\n'.join(fails))

    def test_table_is_not_trivially_small(self):
        self.assertGreater(len(BLOCKED), 200)
        self.assertGreater(len(ALLOWED), 80)

    def test_every_auth_table_has_a_blocked_write_and_an_allowed_read(self):
        for t in GATE.AUTH_TABLES:
            for verb in ('INSERT INTO', 'UPDATE', 'DELETE FROM', 'REPLACE INTO', 'DROP TABLE', 'ALTER TABLE'):
                with self.assertRaises(GATE.Deny, msg='%s %s' % (verb, t)):
                    GATE.inspect('sqlite3 %s "%s %s x"' % (FX.live, verb, t), FX.root)
            GATE.inspect('sqlite3 %s "SELECT * FROM %s"' % (FX.live, t), FX.root)

    def test_the_block_message_names_the_reason(self):
        with self.assertRaises(GATE.Deny) as cm:
            GATE.inspect('npm run dashboard-user -- add bob', FX.root)
        self.assertIn('dashboard-user', cm.exception.reason)
        with self.assertRaises(GATE.Deny) as cm:
            GATE.inspect('sqlite3 %s "DELETE FROM api_tokens"' % FX.live, FX.root)
        self.assertIn('api_tokens', cm.exception.reason)


# ---------------------------------------------------------------------------------------------
# the exit-code contract through a real subprocess
# ---------------------------------------------------------------------------------------------
def run_gate(event, raw=None, env_extra=None, path=GATE_PATH, timeout=30):
    env = dict(os.environ)
    env.update(FX.env)
    env['AUTH_ADMIN_GATE_NO_AUDIT'] = '1'
    env.update(env_extra or {})
    data = raw if raw is not None else json.dumps(event)
    p = subprocess.run([sys.executable, path], input=data, capture_output=True, text=True, env=env,
                       cwd=FX.root, timeout=timeout)
    return p.returncode, p.stderr


def bash_event(cmd):
    return {'tool_name': 'Bash', 'tool_input': {'command': cmd}, 'cwd': FX.root}


class TestContract(unittest.TestCase):
    def test_block_is_exit_2_with_a_message(self):
        code, err = run_gate(bash_event('npm run dashboard-user -- add bob'))
        self.assertEqual(code, 2)
        self.assertIn('AUTH-ADMIN-KAPU: BLOKKOLVA', err)

    def test_allow_is_exit_0_and_silent(self):
        code, err = run_gate(bash_event('npm run dashboard-user -- list'))
        self.assertEqual((code, err), (0, ''))

    def test_a_clean_command_is_exit_0(self):
        self.assertEqual(run_gate(bash_event('ls -la'))[0], 0)

    def test_other_tools_are_not_inspected(self):
        ev = {'tool_name': 'Read', 'tool_input': {'file_path': 'scripts/dashboard-user.ts'}, 'cwd': FX.root}
        self.assertEqual(run_gate(ev)[0], 0)

    def test_bad_input_blocks(self):
        for raw in ('', 'not json', '[]', '"x"', '{', 'null'):
            code, err = run_gate(None, raw=raw)
            self.assertEqual(code, 2, repr(raw))
            self.assertIn('BLOKKOL', err)

    def test_a_bash_event_without_a_readable_command_blocks(self):
        for ti in ({}, {'command': None}, {'command': 5}, {'command': ['npm']}, None):
            code, _ = run_gate({'tool_name': 'Bash', 'tool_input': ti, 'cwd': FX.root})
            self.assertEqual(code, 2, repr(ti))

    def test_oversized_event_blocks(self):
        code, err = run_gate(None, raw=json.dumps(bash_event('echo ' + 'a' * 600000)))
        self.assertEqual(code, 2)
        self.assertIn('BLOKKOL', err)

    def test_internal_error_blocks(self):
        # a gate whose inspect() blows up must not become permissive
        src = GATE_SRC.replace('def inspect(cmd, cwd=\'\'):', "def inspect(cmd, cwd=''):\n    raise ZeroDivisionError('boom')\n\ndef _unused(cmd, cwd=''):", 1)
        mut = os.path.join(FX.tmp, 'mutant-internal.py')
        open(mut, 'w').write(src)
        code, err = run_gate(bash_event('ls'), path=mut)
        self.assertEqual(code, 2)
        self.assertIn('hibara futott', err)

    def test_a_hang_becomes_an_explicit_exit_2(self):
        src = GATE_SRC.replace('def inspect(cmd, cwd=\'\'):', "def inspect(cmd, cwd=''):\n    import time as _t\n    _t.sleep(30)\n\ndef _unused(cmd, cwd=''):", 1)
        mut = os.path.join(FX.tmp, 'mutant-hang.py')
        open(mut, 'w').write(src)
        t0 = time.time()
        code, err = run_gate(bash_event('ls'), path=mut, env_extra={'AUTH_ADMIN_GATE_TIMEOUT_S': '1'})
        self.assertEqual(code, 2)
        self.assertLess(time.time() - t0, 6)
        self.assertIn('idokeret', err)

    def test_the_alarm_is_under_the_hook_timeout(self):
        self.assertLess(GATE.HARD_TIMEOUT_S, 10)   # settings.json: timeout 10
        # the env override can only make it SHORTER
        src = GATE_SRC.replace('def inspect(cmd, cwd=\'\'):', "def inspect(cmd, cwd=''):\n    import time as _t\n    _t.sleep(9)\n\ndef _unused(cmd, cwd=''):", 1)
        mut = os.path.join(FX.tmp, 'mutant-hang2.py')
        open(mut, 'w').write(src)
        t0 = time.time()
        code, _ = run_gate(bash_event('ls'), path=mut, env_extra={'AUTH_ADMIN_GATE_TIMEOUT_S': '999'})
        self.assertEqual(code, 2)
        self.assertLess(time.time() - t0, GATE.HARD_TIMEOUT_S + 3)

    def test_the_gate_imports_nothing_it_cannot_lose(self):
        # stdlib only: no agent_token / ledger_lib import at module level (the audit imports them lazily)
        top = [l for l in GATE_SRC.splitlines() if l.startswith('import ') or l.startswith('from ')]
        for l in top:
            self.assertNotIn('ledger_lib', l)
            self.assertNotIn('agent_token', l)


# ---------------------------------------------------------------------------------------------
# bounded, linear work; over a limit the gate DENIES
# ---------------------------------------------------------------------------------------------
class TestBounds(unittest.TestCase):
    def deny_or_pass_fast(self, cmd, limit_s=3.0):
        t0 = time.time()
        try:
            GATE.inspect(cmd, FX.root)
            denied = False
        except (GATE.Deny, GATE.InspectionLimit, GATE.Opaque):
            denied = True
        self.assertLess(time.time() - t0, limit_s, 'took too long for %d chars' % len(cmd))
        return denied

    def test_command_over_the_size_limit_is_denied(self):
        self.assertTrue(self.deny_or_pass_fast('echo ' + 'a' * (GATE.MAX_CMD_CHARS + 10)))

    def test_command_at_a_normal_big_size_passes_fast(self):
        self.assertFalse(self.deny_or_pass_fast('echo ' + 'a' * 30000))

    def test_too_many_heredoc_openers_denied(self):
        cmd = '\n'.join('cat <<E%d > /dev/null\nx\nE%d' % (i, i) for i in range(GATE.MAX_HEREDOC_OPENERS + 5))
        self.assertTrue(self.deny_or_pass_fast(cmd))

    def test_the_heredoc_opener_cap_is_not_hit_by_a_normal_command(self):
        cmd = '\n'.join('cat <<E%d > /dev/null\nx\nE%d' % (i, i) for i in range(5))
        self.assertFalse(self.deny_or_pass_fast(cmd))

    def test_overlong_opener_line_denied(self):
        cmd = 'cat <<EOF ' + ('# ' + 'x' * 10) * 600 + ' > /dev/null\nbody\nEOF'
        self.assertGreater(len(cmd.split('\n')[0]), GATE.MAX_OPENER_LINE_CHARS)
        self.assertTrue(self.deny_or_pass_fast(cmd))

    def test_deep_nesting_denied(self):
        cmd = 'echo hi'
        for _ in range(GATE.MAX_NEST + 2):
            cmd = 'bash -c "%s"' % cmd.replace('\\', '\\\\').replace('"', '\\"')
        self.assertTrue(self.deny_or_pass_fast(cmd))

    def test_moderate_nesting_still_works_and_still_blocks(self):
        cmd = 'npm run dashboard-user add bob'
        for _ in range(3):
            cmd = 'bash -c "%s"' % cmd.replace('\\', '\\\\').replace('"', '\\"')
        self.assertTrue(self.deny_or_pass_fast(cmd))

    def test_many_substitutions_denied_not_slow(self):
        cmd = 'echo ' + ' '.join('$(echo %d)' % i for i in range(GATE.MAX_SUBS + 20))
        self.assertTrue(self.deny_or_pass_fast(cmd))

    def test_nested_substitution_bomb_is_fast(self):
        cmd = 'echo ' + '$(' * 3000 + 'x' + ')' * 3000
        self.deny_or_pass_fast(cmd)

    def test_quadratic_shapes_are_linear(self):
        shapes = [
            '<<' * 30000,
            '<<A\n' * 25 + 'x' * 100000,
            "'" * 100000,
            '"$(' * 20000,
            '`' * 100000,
            '\\' * 100000,
            'a=b ' * 20000,
            '; ' * 50000,
            '| ' * 50000,
            '{a,b}' * 5000,
            'echo ' + '$X' * 30000,
            'sqlite3 ' + FX.live + ' "' + 'UPDATE ' * 15000 + '"',
            'sqlite3 ' + FX.live + ' "' + '/*' * 30000 + '"',
            'sqlite3 ' + FX.live + ' "' + 'update   ' * 12000 + '"',
            'sqlite3 ' + FX.live + ' "' + 'insert into ' * 9000 + '"',
            'sqlite3 ' + FX.live + ' "UPDATE ' + ' ' * 100000 + '"',
            'sqlite3 ' + FX.live + ' "-- ' + 'x' * 100000 + '\n"',
            'python3 -c "' + 'create trigger a ' * 6000 + '"',
            # the shapes that were quadratic or could be: a lazy scan per opener, to the end of the text
            'python3 -c "' + 'create trigger a ' * 7000 + '"',
            'python3 -c "' + 'create   trigger   ' * 7000 + '"',
            'python3 -c "' + 'update /* ' * 12000 + '"',
            'python3 -c "' + '/*' * 60000 + '"',
            'python3 -c "' + 'update /* x */ ' * 8000 + '"',
            'python3 -c "' + 'update -- x\\n' * 12000 + '"',
            'python3 -c "' + 'insert or ' * 12000 + '"',
            'python3 -c "' + 'drop table if ' * 8000 + '"',
            'python3 -c "' + 'delete from ' * 10000 + '"',
        ]
        for s in shapes:
            self.deny_or_pass_fast(s, limit_s=4.0)

    def test_work_budget_stops_amplification(self):
        # each level repeats the inner text 4 times: 4^6 inspections without a budget
        cmd = 'echo hi'
        for _ in range(5):
            cmd = 'bash -c "%s; %s; %s; %s"' % ((cmd.replace('\\', '\\\\').replace('"', '\\"'),) * 4)
        self.deny_or_pass_fast(cmd, limit_s=4.0)


# ---------------------------------------------------------------------------------------------
# lexer details the rules rely on
# ---------------------------------------------------------------------------------------------
class TestLexer(unittest.TestCase):
    def words(self, cmd):
        st = GATE.State(FX.root)
        return [[w.text for w in s.words] for s in GATE.lex(cmd, st)]

    def test_quotes_and_escapes(self):
        self.assertEqual(self.words('echo "a b" \'c d\' e\\ f'), [['echo', 'a b', 'c d', 'e f']])

    def test_operators_split_segments(self):
        self.assertEqual(self.words('a && b || c; d | e & f'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']])

    def test_operator_inside_quotes_does_not_split(self):
        self.assertEqual(self.words('grep "a|b;c" f'), [['grep', 'a|b;c', 'f']])

    def test_redirects_are_not_arguments(self):
        self.assertEqual(self.words('cmd a > out 2>&1 b < in'), [['cmd', 'a', 'b']])

    def test_comment_skipped_only_at_word_start(self):
        self.assertEqual(self.words('echo a#b # gone\nnext'), [['echo', 'a#b'], ['next']])

    def test_heredoc_body_is_not_a_command(self):
        segs = GATE.lex('cat <<EOF > f\nnpm run dashboard-user add\nEOF\nls', GATE.State(FX.root))
        self.assertEqual([[w.text for w in s.words] for s in segs], [['cat'], ['ls']])
        self.assertEqual(segs[0].heredocs[0][0], 'npm run dashboard-user add')

    def test_assignment_with_quoted_value(self):
        st = GATE.State(FX.root)
        GATE.lex('X="a b"; Y=c', st)
        self.assertEqual((st.vars.get('X'), st.vars.get('Y')), ('a b', 'c'))

    def test_unknown_variable_marks_the_word_dynamic(self):
        segs = GATE.lex('npm run "$NOPE"', GATE.State(FX.root))
        self.assertTrue(segs[0].words[2].dyn)

    def test_ansi_c_quoting(self):
        self.assertEqual(self.words("echo $'a\\x41\\101\\n'"), [['echo', 'aAA\n']])

    def test_brace_expansion_alternatives(self):
        st = GATE.State(FX.root)
        w = GATE.lex('echo a{b,c}d', st)[0].words[1]
        self.assertEqual(sorted(w.alts), ['abd', 'acd'])

    def test_substitution_bodies_are_collected(self):
        seg = GATE.lex('echo $(one) `two` "$(three)"', GATE.State(FX.root))[0]
        self.assertEqual(sorted(seg.subs), ['one', 'three', 'two'])

    def test_crlf_is_whitespace(self):
        self.assertEqual(self.words('echo a\r\nls'), [['echo', 'a'], ['ls']])


# ---------------------------------------------------------------------------------------------
# MUTATION: break the gate in one spot at a time; the table must notice every time
# ---------------------------------------------------------------------------------------------
MUTANTS = [
    ('CLI decision never blocks', 'def _cli_decision(rest, state):\n    if len(rest) == 1', 'def _cli_decision(rest, state):\n    return\n    if len(rest) == 1'),
    ('list exemption widened to anything', "if len(rest) == 1 and rest[0] == 'list':", "if rest and rest[0] == 'list':"),
    ('list exemption removed', "if len(rest) == 1 and rest[0] == 'list':\n        return", "if False:\n        return"),
    ('SQL write check disabled on the live store', 'if live and (hit or SQL_DOT_WRITE.search(text)):', 'if False:'),
    ('SQL write check ignores the live flag', 'if live and (hit or SQL_DOT_WRITE.search(text)):', 'if (hit or SQL_DOT_WRITE.search(text)):'),
    ('block comments not stripped (comment hides the table)', "    if '/*' not in text:\n        return text\n    out = []", "    if True:\n        return text\n    out = []"),
    ('trigger heads uncapped', '        if n > MAX_TRIGGER_HEADS:', '        if False:'),
    ('trigger header too long allowed', 'if len(text) - m.end() > TRIGGER_WINDOW and not TRIGGER_ANY_ON.search(window):', 'if False:'),
    ('raw text view of the SQL dropped', '    views = (text,) if stripped is text else (text, stripped)', '    views = (stripped,)'),
    ('sed exempt from the generic scan again', "    'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'uniq', 'cut', 'tr',\n", "    'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'uniq', 'cut', 'tr', 'sed',\n"),
    ('rg --pre exempt', "    if name == 'rg':\n        return not any(", "    if name == 'rg':\n        return True or not any("),
    ('sort --compress-program exempt', "return not any(t.startswith('--co') for t in texts)", 'return True'),
    ('less +cmd exempt', "            if t[:1] in ('+', '!'):", '            if False:'),
    ('man options exempt', "            if t.startswith('-') and not re.fullmatch(r'-(?:[akfwWhV]+", "            if False and not re.fullmatch(r'-(?:[akfwWhV]+"),
    ('gh any subcommand exempt', 'return sub in _GH_DATA_SUBS', 'return True'),
    ('git options after a safe sub not checked', '        _git_post_sub_checks(args, state)\n', '        pass\n'),
    ('target writers not checked', '    if name in _TARGET_WRITERS:\n        _handle_target_writers(name, args, state)\n', '    if name in _TARGET_WRITERS:\n        pass\n'),
    ('sed w file ignored', '        for a in args:\n            for m in _SED_WRITE.finditer(a.text):', '        for a in []:\n            for m in _SED_WRITE.finditer(a.text):'),
    ('output option ignored', '    for w in _out_values(name, args):', '    for w in []:'),
    ('everything is a copy', 'def _in_store_dir(real, state):\n    for d in', 'def _in_store_dir(real, state):\n    return False\n    for d in'),
    ('a dynamic db path counts as a copy', 'if path_word is None or path_word.dyn:\n        return True', 'if path_word is None or path_word.dyn:\n        return False'),
    ('realpath dropped (symlink to live)', '            reals = [os.path.realpath(p)]', '            reals = [os.path.abspath(p)]'),
    ('interpreter code is not inspected for SQL', "    hit = _sql_write_summary(text)\n    if hit:\n        raise Deny('iras a hitelesito tablakra interpreter-kodbol", "    hit = None\n    if hit:\n        raise Deny('iras a hitelesito tablakra interpreter-kodbol"),
    ('app mutators not inspected', 'm = None if python else APP_MUTATORS.search(text)', 'm = None'),
    ('interpreter exec of the CLI not inspected', 'if CLI_MARKER.search(text) and EXEC_API.search(text):', 'if False:'),
    ('substitution bodies not checked', '        for body in seg.subs:\n            check_command(body, state, depth + 1)', '        for body in []:\n            check_command(body, state, depth + 1)'),
    ('unquoted heredoc substitutions not checked', 'if not quoted:       # an unquoted heredoc', 'if False:       # an unquoted heredoc'),
    ('stdin heredoc of a shell not inspected', "    for t in _stdin_texts(seg, state):       # script on stdin\n        check_command(t, state, depth + 1)", "    for t in []:       # script on stdin\n        check_command(t, state, depth + 1)"),
    ('shell -c script not inspected', "        for alt in script.alts:\n            check_command(alt, state, depth + 1)\n        return", "        return"),
    ('eval not inspected', "        check_command(joined, state, depth + 1)\n        return", "        return"),
    ('env -S not inspected', "    if name == 'env-S':\n        for alt in (args[0].alts if args else []):\n            check_command(alt, state, depth + 1)\n        return", "    if name == 'env-S':\n        return"),
    ('xargs producer words ignored', "            if pn in ('echo', 'printf'):\n                fed = ", "            if False:\n                fed = "),
    ('find -exec ignored', "    if name == 'find':\n        _handle_find(args, seg, state, depth)\n        return", "    if name == 'find':\n        return"),
    ('tmux ignored', "    if name in ('tmux', 'screen'):\n        _handle_tmux(args, state, depth)", "    if name in ('tmux', 'screen'):\n        return\n        _handle_tmux(args, state, depth)"),
    ('ssh ignored', "    if name in ('ssh', 'mosh'):\n        _handle_ssh(args, seg, state, depth)\n        return", "    if name in ('ssh', 'mosh'):\n        return"),
    ('--password-stdin check removed', "    if (any(a.text == '--password-stdin' for a in args) and name not in _LOGIN_OK\n            and not state.isolated_cli):", "    if False:"),
    ('--password-stdin exempt for everything', "and name not in _LOGIN_OK\n", "and name in ('docker',)\n"),
    ('decoder in front of a shell allowed', "    elif name in _DECODERS:\n        raise Opaque()", "    elif name in _DECODERS:\n        pass"),
    ('decoder further up the pipeline allowed', "        if n2 in _DECODERS:\n            raise Opaque()", "        if False:\n            raise Opaque()"),
    ('eval of decoded output allowed', "if seg is not None and any(re.search(r'\\b(?:%s)\\b' % '|'.join(_DECODERS), s) for s in seg.subs):\n            raise Deny('eval", "if False:\n            raise Deny('eval"),
    ('dynamic npm script name allowed', "if w.dyn and not name == 'bun':", "if False:"),
    ('shell variables not expanded', "    def vars_get(name):\n        if name in state.vars:\n            return state.vars[name]", "    def vars_get(name):\n        if False:\n            return state.vars[name]"),
    ('brace expansion off', 'alts = _brace_alts(w)', 'alts = None'),
    ('glob expansion off', "        if any(c in alt for c in '*?['):", "        if False:"),
    ('script stem ignores extensions', "    for e in _EXTS:\n        if low.endswith(e):\n            return low[:-len(e)]\n    return low", "    return low"),
    ('security-reset prefix dropped', "CLI_PREFIXES = ('security-reset',)", "CLI_PREFIXES = ()"),
    ('shell script files not read', "        txt = _read_text_file(args[i].text, state)\n        if txt is not None:\n            check_shell_script(txt, state, depth)\n        return\n    for t in _stdin_texts", "        return\n    for t in _stdin_texts"),
    ('bash FILE named like the CLI not checked', "        if _word_hits_cli(args[i], state.cwd):          # bash scripts/security-reset.sh", "        if False:          # bash scripts/security-reset.sh"),
    ('.read not followed', "    while k < len(texts) and k < 64:       # .read FILE adds that file's text (nested, bounded)", "    while False:       # .read FILE adds that file's text (nested, bounded)"),
    ('session-wide live flag per text only', "    eff = live\n    for t in texts:\n        for m in SQL_DOT_OPEN", "    eff = live\n    for t in []:\n        for m in SQL_DOT_OPEN"),
    ('isolated store exemption always on', "    state.isolated_cli = _isolated_store(seg, words, cmdword, state)", "    state.isolated_cli = True"),
    ('isolated store exemption never on', "    state.isolated_cli = _isolated_store(seg, words, cmdword, state)", "    state.isolated_cli = False"),
    ('isolated store ignores the live store', "        if real == d or real.startswith(d + os.sep) or d.startswith(real + os.sep):\n            return False       # the live store", "        if False:\n            return False       # the live store"),
    ('isolated store: a parent of the live store allowed', " or d.startswith(real + os.sep):\n            return False       # the live store", ":\n            return False       # the live store"),
    ('isolated store: unresolved value allowed', "    if not val or '$' in val or '`' in val:\n        return False", "    if not val:\n        return False"),
    ('python mutators looked for again', "    m = None if python else APP_MUTATORS.search(text)", "    m = APP_MUTATORS.search(text)"),
    ('no db file means live', "if dbword is not None else False   # no file = a transient DB", "if dbword is not None else True   # no file = a transient DB"),
    ('direct script path not read', "        if '/' in alt and alt.lower().endswith(('.sh', '.bash')):\n            txt = _read_text_file(alt, state)\n            if txt is not None:\n                check_shell_script(txt, state, depth)\n            return", "        if False:\n            return"),
    ('approvals not protected', "    'approvals', 'approvals_old', 'approval_events',\n", "    'x_approvals_gone',\n"),
    ('device_keys not protected', "'dashboard_users', 'auth_sessions', 'api_tokens', 'device_keys',", "'dashboard_users', 'auth_sessions', 'api_tokens',"),
    ('ATTACH of the live DB ignored', "            if target and (target.startswith('$') or _db_is_live(Word(target), state)):\n                eff = True", "            if False:\n                eff = True"),
    ('.open of the live DB ignored', "            if _db_is_live(Word(m.group(1).strip('\\'\"')), state):\n                eff = True", "            if False:\n                eff = True"),
    ('.shell allowed', "    if SQL_DOT_SHELL.search(text):\n        raise Deny", "    if False:\n        raise Deny"),
    ('size limit removed', "    if len(cmd) > MAX_CMD_CHARS:\n        raise InspectionLimit", "    if False:\n        raise InspectionLimit"),
    ('opener cap removed', "                if openers[0] > MAX_HEREDOC_OPENERS:", "                if False:"),
    ('nesting limit removed', "    if depth > MAX_NEST:\n        raise InspectionLimit", "    if False:\n        raise InspectionLimit"),
    ('substitution cap removed', "        if state.budget.subs > MAX_SUBS:", "        if False:"),
    ('every path counts as a made link', "    if state.link_global:\n        return True\n    for d in state.link_dests:", "    return True\n    for d in state.link_dests:"),
    ('link into a throw-away store dir ignored', "if below and x.startswith(real.rstrip('/') + os.sep):", "if False and x.startswith(real.rstrip('/') + os.sep):"),
    ('work budget removed', "    state.budget.chars += len(cmd)\n    if state.budget.chars > MAX_WORK_CHARS:", "    state.budget.chars += len(cmd)\n    if False:"),
    ('internal error allowed', "        sys.stderr.write('AUTH-ADMIN-KAPU: a kapu maga hibara futott (%s: %s), ezert BLOKKOL. Ez a '\n                         'kapu hibaja, nem a tied.\\n' % (type(exc).__name__, exc))\n        sys.exit(2)", "        sys.exit(0)"),
    ('bad json allowed', "        sys.stderr.write('AUTH-ADMIN-KAPU: a bemenet nem olvashato, ezert BLOKKOL.\\n')\n        sys.exit(2)\n    tool", "        sys.exit(0)\n    tool"),
    ('inspection limit allowed', "    except InspectionLimit as exc:\n        block(", "    except InspectionLimit as exc:\n        sys.exit(0)\n        block("),
    ('general live-argument rule off', '    _handle_live_args(name, args, seg, state)\n', '    pass\n'),
    ('live-argument rule: everything is read-only', '    if name in _LIVE_ARG_SKIP or name in _LIVE_READONLY or name in state.funcs:', '    if True:'),
    ('live-argument rule: cat not read-only', "    'cat', 'head', 'tail', 'wc', 'stat', 'ls', 'file', 'du', 'df',", "    'head', 'tail', 'wc', 'stat', 'ls', 'file', 'du', 'df',"),
    ('live-argument rule: dynamic words resolved as plain paths', "        return bool(_DYN_LIVE_FILE_HINT.search(cand))   # only a path that ENDS", "        return _live_path(Word(cand), state)   # only a path that ENDS"),
    ('live-argument rule: a dynamic store DIR counts as the live file', "_DYN_LIVE_FILE_HINT = re.compile(r'(?:^|/)store/(?:claudeclaw[^/]*|[^/]*\\.db(?:-wal|-shm|-journal)?)$', re.I)", "_DYN_LIVE_FILE_HINT = re.compile(r'(?:^|/)store/?(?:claudeclaw[^/]*|[^/]*\\.db(?:-wal|-shm|-journal)?)?$', re.I)"),
    ('live-argument rule: shell functions are not skipped', "    if name in _LIVE_ARG_SKIP or name in _LIVE_READONLY or name in state.funcs:", "    if name in _LIVE_ARG_SKIP or name in _LIVE_READONLY:"),
    ('shell function names (f() {) not collected', "            state.funcs.add(ws[0].text)", "            pass"),
    ('shell function names (function f) not collected', "            state.funcs.add(ws[1].text)", "            pass"),
    ('live-argument rule: --opt=VALUE ignored', "        if '=' in t:\n            out.append(t.split('=', 1)[1])\n        elif not t.startswith('--')", "        if False:\n            out.append(t.split('=', 1)[1])\n        elif not t.startswith('--')"),
    ('live-argument rule: glued -oVALUE ignored', "        elif not t.startswith('--') and len(t) > 2:\n            out.append(t[2:])", '        elif False:\n            out.append(t[2:])'),
    ('live-argument rule: of=VALUE ignored', "        out.append(t)\n        if '=' in t:\n            out.append(t.split('=', 1)[1])", "        out.append(t)\n        if False:\n            out.append(t.split('=', 1)[1])"),
    ('live-argument rule: unknown directory means a copy', "        return os.path.basename(cand.rstrip('/')) in _LIVE_DB_NAMES", '        return False'),
    ('live-argument rule: unknown directory means live', "        return os.path.basename(cand.rstrip('/')) in _LIVE_DB_NAMES", '        return True'),
    ('tar old-style bundle not read', "        old = idx == 0 and re.fullmatch(r'[A-Za-z]+', t) is not None", '        old = False'),
    ('tar -x directory not checked', "        for d in dirs:\n            if _live_path(d, state, True):\n                _deny_live_write('tar -x -C ' + d.text)", "        for d in []:\n            if _live_path(d, state, True):\n                _deny_live_write('tar -x -C ' + d.text)"),
    ('tar -x directory without the store-dir hint', "            if _live_path(d, state, True):\n                _deny_live_write('tar -x -C ' + d.text)", "            if _live_path(d, state):\n                _deny_live_write('tar -x -C ' + d.text)"),
    ('tar -x members not checked', "        for m in members:\n            w = _join_word(dirs[-1] if dirs else None, m)\n            if w is not None and _live_path(w, state):\n                _deny_live_write('tar -x ' + m.text)", "        for m in []:\n            w = _join_word(dirs[-1] if dirs else None, m)\n            if w is not None and _live_path(w, state):\n                _deny_live_write('tar -x ' + m.text)"),
    ('tar archive write not checked', "    if modes & set('cru'):", '    if False:'),
    ('tar reading counts as writing', "    if modes & set('cru'):", '    if True:'),
    ('unzip -d directory not checked', "    for d in dirs:\n        if _live_path(d, state, True):\n            _deny_live_write('unzip -d ' + d.text)", "    for d in []:\n        if _live_path(d, state, True):\n            _deny_live_write('unzip -d ' + d.text)"),
    ('unzip members not checked', '    for m in pos[1:]:', '    for m in []:'),
    ('unzip listing not skipped', '    if listing:\n        return\n', '    if False:\n        return\n'),
    ('pax -rw destination not checked', "            if _live_path(pos[-1], state, True):\n                _deny_live_write('pax -rw -> ' + pos[-1].text)", "            if False:\n                _deny_live_write('pax -rw -> ' + pos[-1].text)"),
    ('pax -rw -l sources not checked', '            if link:\n                for s in pos[:-1]:', '            if False:\n                for s in pos[:-1]:'),
    ('pax -w archive not checked', "        if 'w' in letters and 'r' not in letters:", '        if False:'),
    ('cpio -o archive not checked', "    if 'o' in letters:\n        for f in filevals:", '    if False:\n        for f in filevals:'),
    ('cpio -p destination not checked', "        if pos and _live_path(pos[-1], state, True):\n            _deny_live_write('cpio -p -> ' + pos[-1].text)", "        if False:\n            _deny_live_write('cpio -p -> ' + pos[-1].text)"),
    ('cpio -p -l with an unreadable list allowed', "            if pn not in ('echo', 'printf', 'ls', 'find'):", '            if False:'),
    ('cpio -p -l sources not checked', "            for s in pa:\n                if _live_path(s, state, True, True, source=True):\n                    _deny_live_write('cpio -p -l", "            for s in []:\n                if _live_path(s, state, True, True, source=True):\n                    _deny_live_write('cpio -p -l"),
    ('link is not a hard-link maker', "    elif name in ('ln', 'link'):\n        symbolic =", "    elif name == 'ln':\n        symbolic ="),
    ('sqlite3 file dot-commands: only the full name', '        full = next((f for f in _SQL_DOT_FILE_OUT if f.startswith(nm)), None)', '        full = next((f for f in _SQL_DOT_FILE_OUT if f == nm), None)'),
    ('sqlite3 file dot-commands: only .backup / .save / .clone', "_SQL_DOT_FILE_OUT = ('backup', 'save', 'clone', 'output', 'once', 'excel', 'log', 'trace')", "_SQL_DOT_FILE_OUT = ('backup', 'save', 'clone')"),
    ('sqlite3 .output |command and -e allowed', "            if any(t.startswith('|') for t in names) or '-e' in opts:", '            if False:'),
    ('sqlite3 edit() allowed', "        if not _sql_inert(spans, m.start()):\n            raise Deny('sqlite3 edit()", "        if False:\n            raise Deny('sqlite3 edit()"),
    ('VACUUM INTO / writefile non-literal target allowed', '    if target is None:\n        if inert:\n            return\n', '    if target is None:\n        return\n'),
    ('VACUUM INTO / writefile in a string not recognised', '    if target is None:\n        if inert:\n            return\n', '    if target is None:\n        if False:\n            return\n'),
    ('every position counts as inside a string', 'def _sql_inert(spans, pos):\n    for s, e in spans:', 'def _sql_inert(spans, pos):\n    return True\n    for s, e in spans:'),
    ('VACUUM schema-name form skipped', '            e = _sql_ident_end(text, i)\n            if e < 0:\n                continue\n', '            continue\n            e = _sql_ident_end(text, i)\n            if e < 0:\n                continue\n'),
    ('SQL line comments not skipped between tokens', "        elif text.startswith('--', i):\n            j = text.find('\\n', i)\n            i = n if j == -1 else j + 1\n", "        elif False:\n            j = text.find('\\n', i)\n            i = n if j == -1 else j + 1\n"),
    ('SQL block comments not skipped between tokens', "        elif text.startswith('/*', i):\n            j = text.find('*/', i + 2)\n            i = n if j == -1 else j + 2\n        else:\n            break", "        elif False:\n            j = text.find('*/', i + 2)\n            i = n if j == -1 else j + 2\n        else:\n            break"),
    ('writefile() not inspected', '    for m in _SQL_WORD_WRITEFILE.finditer(text):', '    for m in []:'),
    ('SQL .shell: full names only', "SQL_DOT_SHELL = re.compile(r'(?m)^\\s*\\.(?:sh(?:e(?:l(?:l)?)?)?|sy(?:s(?:t(?:e(?:m)?)?)?)?)\\b', re.I)", "SQL_DOT_SHELL = re.compile(r'(?m)^\\s*\\.(?:shell|system)\\b', re.I)"),
    ('SQL .import / .restore: full names only', "SQL_DOT_WRITE = re.compile(r'(?m)^\\s*\\.(?:im(?:p(?:o(?:r(?:t)?)?)?)?|res(?:t(?:o(?:r(?:e)?)?)?)?)\\b.*$', re.I)", "SQL_DOT_WRITE = re.compile(r'(?m)^\\s*\\.(?:import|restore)\\b.*$', re.I)"),
    ('SQL .open: full name only', "SQL_DOT_OPEN = re.compile(r'(?m)^\\s*\\.op(?:e(?:n)?)?\\s+", "SQL_DOT_OPEN = re.compile(r'(?m)^\\s*\\.open\\s+"),
    ('SQL .read: full name only', "SQL_DOT_READ = re.compile(r'(?m)^\\s*\\.rea(?:d)?\\s+", "SQL_DOT_READ = re.compile(r'(?m)^\\s*\\.read\\s+"),
]


class TestMutation(unittest.TestCase):
    def test_original_has_no_table_failures(self):
        self.assertEqual(table_failures(GATE), [])

    def test_every_mutant_is_caught(self):
        survivors = []
        bad = [name for name, old, _new in MUTANTS if GATE_SRC.count(old) != 1]
        self.assertEqual(bad, [], 'mutant anchors not unique / not present: %s' % bad)
        for name, old, new in MUTANTS:
            mutant = load_gate(GATE_SRC.replace(old, new, 1), name='mutant')
            caught = bool(table_failures(mutant))
            if not caught:
                caught = self._caught_elsewhere(name, GATE_SRC.replace(old, new, 1))
            if not caught:
                survivors.append(name)
        self.assertEqual(survivors, [], 'mutants that survived: %s' % survivors)

    def _caught_elsewhere(self, name, src):
        """Mutants the table cannot see (limits, main() fail-closed paths): the dedicated checks."""
        mod = load_gate(src, name='mutant2')
        try:
            if name == 'trigger heads uncapped':
                try:
                    mod.inspect('python3 -c "' + 'create trigger a ' * 6000 + '"', FX.root)
                except mod.InspectionLimit:
                    return False
                except (mod.Deny, mod.Opaque):
                    return True
                return True
            if name == 'size limit removed':
                t0 = time.time()
                try:
                    mod.inspect('echo ' + 'a' * (mod.MAX_CMD_CHARS + 10), FX.root)
                    return True
                except (mod.Deny, mod.InspectionLimit):
                    return False
            if name == 'opener cap removed':
                cmd = '\n'.join('cat <<E%d > /dev/null\nx\nE%d' % (i, i) for i in range(mod.MAX_HEREDOC_OPENERS + 5))
                try:
                    mod.inspect(cmd, FX.root)
                    return True
                except mod.InspectionLimit:
                    return False
            if name == 'nesting limit removed':
                cmd = 'echo hi'
                for _ in range(mod.MAX_NEST + 2):
                    cmd = 'bash -c "%s"' % cmd.replace('\\', '\\\\').replace('"', '\\"')
                try:
                    mod.inspect(cmd, FX.root)
                    return True
                except mod.InspectionLimit:
                    return False
            if name == 'substitution cap removed':
                cmd = 'echo ' + ' '.join('$(echo %d)' % i for i in range(mod.MAX_SUBS + 20))
                try:
                    mod.inspect(cmd, FX.root)
                    return True
                except mod.InspectionLimit:
                    return False
            if name == 'work budget removed':
                cmd = 'echo hi'
                for _ in range(5):
                    cmd = 'bash -c "%s; %s; %s; %s"' % ((cmd.replace('\\', '\\\\').replace('"', '\\"'),) * 4)
                try:
                    mod.inspect(cmd, FX.root)
                    return True
                except mod.InspectionLimit:
                    return False
        except Exception:
            return False
        # main()-level fail-closed paths: run the mutant as a process
        mut = os.path.join(FX.tmp, 'mutant-%s.py' % abs(hash(name)))
        open(mut, 'w').write(src)
        if name == 'internal error allowed':
            boom = src.replace('def inspect(cmd, cwd=\'\'):', "def inspect(cmd, cwd=''):\n    raise ZeroDivisionError('x')\n\ndef _unused(cmd, cwd=''):", 1)
            open(mut, 'w').write(boom)
            return run_gate(bash_event('ls'), path=mut)[0] != 2
        if name == 'bad json allowed':
            return run_gate(None, raw='not json', path=mut)[0] != 2
        if name == 'inspection limit allowed':
            return run_gate(bash_event('echo ' + 'a' * 140000), path=mut)[0] != 2
        return False


if __name__ == '__main__':
    unittest.main(verbosity=1)
