# F00 Prerequisites

Marveen runs natively — no Docker, no containers. The installer handles most dependencies automatically, but a few tools need to be present before you begin.

## Supported operating systems

| System | Notes |
|--------|-------|
| macOS 14+ | Full support |
| macOS 10.15–13 | Partial (Homebrew "best effort" mode) |
| Ubuntu 22.04 / 24.04 | Full support |
| Debian 12+ | Full support |
| Fedora 40+ / Nobara / RHEL 9+ | Full support |
| Windows 11 | Requires WSL 2 + Ubuntu (see below) |

> **Windows:** Marveen runs inside Ubuntu under WSL 2. The `install-windows.ps1` script installs WSL and Ubuntu, then continues with the Linux installer inside Ubuntu. Every subsequent step happens in the Ubuntu shell.

## Required prerequisites

### Claude Code CLI

Marveen uses Claude Code CLI to run agents.

**Installation:**

```bash
npm install -g @anthropic-ai/claude-code
```

**Verification:**

```bash
claude --version
```

> The CLI must be available on `PATH`. The installer checks for it and offers to install it if missing.

### Node.js v20+

The backend services require Node.js 20 or newer. The installer prefers `node@22` (stable ABI for `better-sqlite3`).

**Verification:**

```bash
node --version   # v20.x or newer
```

**macOS:** the installer installs it automatically via Homebrew if missing.  
**Linux:** `install-linux.sh` installs it via the package manager (`apt` / `dnf`).

### npm

npm typically ships with Node.js.

```bash
npm --version
```

### tmux

Background agents run in tmux sessions.

```bash
tmux -V   # 3.x or newer recommended
```

**macOS:** `brew install tmux`  
**Linux:** `apt install tmux` or `dnf install tmux`

### git

Required for cloning the repository and the update workflow.

```bash
git --version
```

## Optional but recommended prerequisites

### Ollama + nomic-embed-text

Required for semantic memory search (hybrid FTS + vector search). The installer sets it up automatically.

- If missing: search falls back to keyword-only mode.
- Verification: `ollama list` — `nomic-embed-text` should appear in the list.

### Bun

The Telegram channel plugin requires the Bun runtime.

```bash
bun --version
```

The installer installs it automatically if missing (`https://bun.sh/install`).

### Go 1.25+

Required to run the `bumblebee` supply-chain scanner. If missing, the scanner step is skipped; everything else works normally.

```bash
go version
```

### ffmpeg

Used for audio and video processing (e.g. voice message transcription). Without it, video transcription is unavailable.

```bash
ffmpeg -version
```

### Whisper (mlx-whisper / openai-whisper)

Speech-to-text transcription. The installer tries `mlx-whisper` on Apple Silicon and `openai-whisper` elsewhere via `pipx`.

## Network access

The installer and agents reach the following endpoints:

| Address | Purpose |
|---------|---------|
| `api.anthropic.com` | Claude API |
| `api.telegram.org` | Telegram bot (if using Telegram) |
| `ollama.com` | Ollama installer (if missing) |
| `bun.sh` | Bun installer (if missing) |
| `localhost:11434` | Local Ollama API (at runtime) |
| `localhost:3420` | Dashboard (at runtime, configurable) |

## Anthropic authentication

Two options:

**1. OAuth token (recommended):** generate one with `claude setup-token`. The token goes into `.env` or `store/.claude-oauth-token` for the services.

**2. API key:** set `ANTHROPIC_API_KEY` in the environment or in the `.env` file.

> Running `claude auth login` in your terminal (Keychain-based login) is **not sufficient** for the background services — they cannot access the Keychain. The installer warns you if the service-side credential is missing.

---

*Next: [F01 Installation](F01-installation.md)*
