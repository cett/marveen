# F00 Előfeltételek

A Marveen natív módon fut: nincs Docker, nincs konténer. A telepítő elvégzi a legtöbb függőség beállítását, de néhány eszköznek előre elérhetőnek kell lennie.

## Támogatott operációs rendszerek

| Rendszer | Megjegyzés |
|----------|-----------|
| macOS 14+ | Teljes körű támogatás |
| macOS 10.15–13 | Részleges (Homebrew "best effort" mód) |
| Ubuntu 22.04 / 24.04 | Teljes körű támogatás |
| Debian 12+ | Teljes körű támogatás |
| Fedora 40+ / Nobara / RHEL 9+ | Teljes körű támogatás |
| Windows 11 | WSL 2 + Ubuntu szükséges (lásd lent) |

> **Windows:** a Marveen WSL 2 alatt fut Ubuntu-ban. A `install-windows.ps1` szkript telepíti a WSL-t és az Ubuntu-t, majd az Ubuntu-ban folytatja a Linux-os telepítővel. A telepítés minden lépése az Ubuntu shellben zajlik.

## Kötelező előfeltételek

### Claude Code CLI

A Marveen Claude Code CLI-t igényel az ágensek futtatásához.

**Telepítés:**

```bash
npm install -g @anthropic-ai/claude-code
```

**Ellenőrzés:**

```bash
claude --version
```

> A CLI-nek elérhetőnek kell lennie a `PATH`-ban. A telepítő ellenőrzi, és ha hiányzik, felajánlja a telepítést.

### Node.js v20+

A háttérszolgáltatások Node.js 20-as vagy újabb verziót igényelnek. A telepítő a `node@22`-t preferálja (ABI-stabil `better-sqlite3` miatt).

**Ellenőrzés:**

```bash
node --version   # v20.x vagy újabb
```

**macOS:** a telepítő automatikusan telepíti Homebrew-on keresztül, ha hiányzik.  
**Linux:** az `install-linux.sh` a csomagkezelőn keresztül telepíti (`apt` / `dnf`).

### npm

Az npm általában a Node.js-sel együtt érkezik.

```bash
npm --version
```

### tmux

A háttérban futó ágensek tmux munkamenetekben futnak.

```bash
tmux -V   # 3.x vagy újabb ajánlott
```

**macOS:** `brew install tmux`  
**Linux:** `apt install tmux` vagy `dnf install tmux`

### git

A repo klónozásához és a frissítési munkafolyamathoz szükséges.

```bash
git --version
```

## Opcionális, de ajánlott előfeltételek

### Ollama + nomic-embed-text

A szemantikus memóriakereséshez (hibrid FTS + vektorkeresés) szükséges. A telepítő automatikusan telepíti.

- Ha hiányzik: a keresés kulcsszavas módra esik vissza.
- Ellenőrzés: `ollama list` -- a `nomic-embed-text` modellnek szerepelnie kell.

### Bun

A Telegram csatorna plugin Bun runtime-ot igényel.

```bash
bun --version
```

A telepítő automatikusan telepíti, ha hiányzik (`https://bun.sh/install`).

### Go 1.25+

A `bumblebee` supply-chain scanner futtatásához szükséges. Ha hiányzik, a scanner lépés átugrásra kerül, minden más funkció érintetlen marad.

```bash
go version
```

### ffmpeg

Hang- és videófeldolgozáshoz (pl. hangüzenetek átirata) szükséges. Hiányában a videóátirat funkció nem elérhető.

```bash
ffmpeg -version
```

### Whisper (mlx-whisper / openai-whisper)

Hang-szöveg átalakításhoz. A telepítő Apple Silicon Mac-en `mlx-whisper`-t, egyéb esetben `openai-whisper`-t próbál telepíteni `pipx`-en keresztül.

## Hálózati hozzáférés

A telepítő és az ágensek az alábbi végpontokat érik el:

| Cím | Mire kell |
|-----|-----------|
| `api.anthropic.com` | Claude API |
| `api.telegram.org` | Telegram bot (ha Telegram csatornát használsz) |
| `ollama.com` | Ollama telepítő (ha hiányzik) |
| `bun.sh` | Bun telepítő (ha hiányzik) |
| `localhost:11434` | Ollama helyi API (futás közben) |
| `localhost:3420` | Dashboard (futás közben, konfigurálható) |

## Anthropic hitelesítés

Két lehetőség:

**1. OAuth token (ajánlott):** `claude setup-token` paranccsal generálható. A token az ágensek számára a `.env` fájlba vagy a `store/.claude-oauth-token` fájlba kerül.

**2. API kulcs:** az `ANTHROPIC_API_KEY` környezeti változón vagy a `.env` fájlban adható meg.

> A terminálban végrehajtott `claude auth login` (Keychain-alapú bejelentkezés) **nem elegendő** a háttérszolgáltatásokhoz -- azok nem férnek hozzá a Keychainhez. A telepítő figyelmeztet, ha hiányzik a szolgáltatások számára szükséges hitelesítő adat.

---

*Következő fejezet: [F01 Telepítés](F01-telepites.md)*
