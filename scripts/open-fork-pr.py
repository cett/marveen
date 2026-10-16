#!/usr/bin/env python3
"""open-fork-pr: open a pull request on the fork (cett/marveen) from the command line.

    python3 scripts/open-fork-pr.py --head <branch> --title <title> --body-file <path> [--base develop]

The body comes from a file (a PR body is long and holds backticks and quotes that a command line would mangle).
The file is only read, never deleted.

How it works:
  1. The GitHub credential comes from `git credential fill` for github.com (the same helper git push uses, so the
     osxkeychain entry is reused; no token variable, no token file). Prompting is switched off.
  2. POST https://api.github.com/repos/cett/marveen/pulls with {title, head, base, body}.
  3. On success one line goes to stdout: `PR <number> <html_url>`.

Failure: a non-zero exit and the GitHub error message on stderr (for a validation error, the messages of its
errors list, e.g. "A pull request already exists for ..."). The token is never printed: it lives in one Authorization
header, redirects are not followed (a redirect would carry the header to wherever it points), and anything written to
the terminal first has the token value replaced with ***.

Exit codes: 0 success, 1 runtime failure (no credential, GitHub refused, network, unreadable answer), 2 usage error
(bad or missing argument, unreadable body file).

Test seam: OPEN_FORK_PR_API_BASE replaces https://api.github.com, and is accepted only for a loopback http address
(127.0.0.1 / localhost / [::1]), so an environment variable can never point the credential at another host.
Pure standard library, Python 3.9 compatible.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = 'cett/marveen'
DEFAULT_API_BASE = 'https://api.github.com'
DEFAULT_BASE_BRANCH = 'develop'
HTTP_TIMEOUT = 30
CREDENTIAL_TIMEOUT = 15
MAX_ERROR_CHARS = 600
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '[::1]', '::1')


class Usage(Exception):
    """A bad argument: exit 2."""


class Failure(Exception):
    """A runtime failure: exit 1."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Return the 3xx as an error instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_base():
    override = os.environ.get('OPEN_FORK_PR_API_BASE')
    if not override:
        return DEFAULT_API_BASE
    parsed = urllib.parse.urlsplit(override)
    if parsed.scheme != 'http' or (parsed.hostname or '') not in LOOPBACK_HOSTS:
        raise Usage('OPEN_FORK_PR_API_BASE is only accepted for a loopback http address')
    return override.rstrip('/')


def read_token():
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    try:
        done = subprocess.run(
            ['git', 'credential', 'fill'],
            input='protocol=https\nhost=github.com\n\n',
            capture_output=True, text=True, timeout=CREDENTIAL_TIMEOUT, env=env,
        )
    except (OSError, subprocess.SubprocessError):
        raise Failure('could not run `git credential fill`')
    if done.returncode != 0:
        raise Failure('`git credential fill` found no GitHub credential')
    for line in done.stdout.splitlines():
        if line.startswith('password='):
            token = line[len('password='):]
            if token:
                return token
    raise Failure('`git credential fill` returned no password for github.com')


def scrub(text, token):
    if token:
        text = text.replace(token, '***')
    return text


def describe_error(status, raw, token):
    """GitHub's message, plus the messages of its errors list, cut to a bounded length."""
    text = ''
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except ValueError:
        data = None
    if isinstance(data, dict):
        parts = [str(data.get('message') or '')]
        errors = data.get('errors')
        if isinstance(errors, list):
            for item in errors:
                if isinstance(item, dict):
                    detail = item.get('message') or ' '.join(
                        str(item[k]) for k in ('resource', 'field', 'code') if item.get(k))
                else:
                    detail = str(item)
                if detail:
                    parts.append(detail)
        text = ': '.join(p for p in parts if p)
    if not text:
        text = re.sub(r'\s+', ' ', raw.decode('utf-8', 'replace')).strip()
    text = scrub(text, token)
    if len(text) > MAX_ERROR_CHARS:
        text = text[:MAX_ERROR_CHARS] + '...'
    return 'GitHub %d: %s' % (status, text or 'no message')


def open_pr(head, title, body, base):
    url = '%s/repos/%s/pulls' % (api_base(), REPO)
    token = read_token()
    payload = json.dumps({'title': title, 'head': head, 'base': base, 'body': body}).encode('utf-8')
    request = urllib.request.Request(url, data=payload, method='POST', headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'marveen-open-fork-pr',
    })
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=HTTP_TIMEOUT) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as err:
        try:
            raw = err.read()
        except Exception:
            raw = b''
        raise Failure(describe_error(err.code, raw, token))
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, 'reason', err)
        raise Failure(scrub('could not reach GitHub: %s' % reason, token))
    try:
        data = json.loads(raw.decode('utf-8'))
        number = data['number']
        html_url = data['html_url']
    except (ValueError, KeyError, TypeError):
        raise Failure(scrub('GitHub answered %s without a pull request number and URL' % status, token))
    return number, html_url


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog='open-fork-pr.py', description='Open a pull request on %s.' % REPO)
    parser.add_argument('--head', required=True, help='branch to merge')
    parser.add_argument('--title', required=True, help='pull request title')
    parser.add_argument('--body-file', required=True, help='file holding the pull request body (read only)')
    parser.add_argument('--base', default=DEFAULT_BASE_BRANCH, help='target branch (default: %(default)s)')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        for name in ('head', 'title', 'base'):
            if not getattr(args, name).strip():
                raise Usage('--%s must not be empty' % name)
        try:
            with open(args.body_file, encoding='utf-8') as handle:
                body = handle.read()
        except (OSError, UnicodeDecodeError) as err:
            raise Usage('cannot read the body file: %s' % err.__class__.__name__)
        number, html_url = open_pr(args.head.strip(), args.title, body, args.base.strip())
    except Usage as err:
        print('open-fork-pr: %s' % err, file=sys.stderr)
        return 2
    except Failure as err:
        print('open-fork-pr: %s' % err, file=sys.stderr)
        return 1
    print('PR %s %s' % (number, html_url))
    return 0


if __name__ == '__main__':
    sys.exit(main())
