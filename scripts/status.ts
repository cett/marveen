import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'
import { SERVICE_ID, WEB_PORT, launchdStatusPattern, systemdStatusUnits } from '../src/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (label: string, detail?: string) =>
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` — ${detail}` : ''}`)
const warn = (label: string, detail?: string) =>
  console.log(`  ${YELLOW}⚠${RESET} ${label}${detail ? ` — ${detail}` : ''}`)
const fail = (label: string, detail?: string) =>
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` — ${detail}` : ''}`)

console.log(`\n${BOLD}Marveen Allapot${RESET}\n`)

// Node.js
const nodeVersion = process.version
const major = parseInt(nodeVersion.slice(1), 10)
if (major >= 20) {
  ok('Node.js', nodeVersion)
} else {
  fail('Node.js', `${nodeVersion} — minimum v20 szukseges`)
}

// Claude CLI
try {
  const cv = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
  ok('Claude CLI', cv)
} catch {
  fail('Claude CLI', 'nem talalhato')
}

// .env
const envPath = join(PROJECT_ROOT, '.env')
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8')
  const getVal = (key: string) => {
    const m = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return m?.[1]?.trim()
  }

  // Telegram token
  const token = getVal('TELEGRAM_BOT_TOKEN')
  if (token) {
    ok('Telegram bot token', 'beallitva')
  } else {
    fail('Telegram bot token', 'hianyzik')
  }

  // Chat ID
  const chatId = getVal('ALLOWED_CHAT_ID')
  if (chatId) {
    ok('Chat ID', chatId)
  } else {
    warn('Chat ID', 'nincs beallitva — a bot mindenkit fogad')
  }

  // ElevenLabs
  const elKey = getVal('ELEVENLABS_API_KEY')
  const elVoice = getVal('ELEVENLABS_VOICE_ID')
  if (elKey && elVoice) {
    ok('ElevenLabs TTS', 'konfigurálva')
  } else if (elKey) {
    warn('ElevenLabs TTS', 'API kulcs megvan, de Voice ID hianyzik')
  } else {
    warn('ElevenLabs TTS', 'nincs konfigurálva')
  }
} else {
  fail('.env fajl', 'nem talalhato — futtasd: npm run setup')
}

// Adatbázis (a futó dashboardon át, nem a fájlt nyitjuk meg)
// The operator's token (store/.operator-token); the shared dashboard token only when that file is missing.
const operatorTokenPath = join(PROJECT_ROOT, 'store', '.operator-token')
const sharedTokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')
const tokenPath = existsSync(operatorTokenPath) ? operatorTokenPath : sharedTokenPath
async function apiGet(path: string): Promise<any> {
  const token = readFileSync(tokenPath, 'utf-8').trim()
  const res = await fetch(`http://localhost:${WEB_PORT}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
if (existsSync(tokenPath)) {
  try {
    const stats = await apiGet('/api/memories/stats')
    ok('Adatbazis', 'valaszol a dashboardon at')
    ok('Emlekek szama', String(stats.total))
    try {
      const schedules = await apiGet('/api/schedules')
      ok('Utemezett feladatok', String(schedules.length))
    } catch {
      warn('Utemezett feladatok', 'nem sikerult lekerdezni')
    }
  } catch {
    warn('Adatbazis', 'a dashboard nem valaszol, az emlekek es feladatok szama nem elerheto')
  }
} else {
  warn('Adatbazis', 'nincs dashboard token (a dashboard meg nem indult el)')
}

// Szolgáltatás állapot
const os = platform()
if (os === 'darwin') {
  try {
    const out = execSync(`launchctl list | grep -E "${launchdStatusPattern(SERVICE_ID)}" 2>/dev/null`, {
      encoding: 'utf-8',
    }).trim()
    if (out) {
      ok('Hatterszolgaltatas (launchd)', 'fut')
    } else {
      warn('Hatterszolgaltatas (launchd)', 'nem fut')
    }
  } catch {
    warn('Hatterszolgaltatas (launchd)', 'nem talalhato')
  }
} else if (os === 'linux') {
  try {
    execSync(systemdStatusUnits(SERVICE_ID).map((u) => `systemctl --user is-active ${u} 2>/dev/null`).join(' || '), { encoding: 'utf-8' })
    ok('Hatterszolgaltatas (systemd)', 'aktiv')
  } catch {
    warn('Hatterszolgaltatas (systemd)', 'nem aktiv')
  }
}

// PID
const pidPath = join(PROJECT_ROOT, 'store', 'claudeclaw.pid')
if (existsSync(pidPath)) {
  const pid = readFileSync(pidPath, 'utf-8').trim()
  try {
    process.kill(parseInt(pid, 10), 0)
    ok('Folyamat', `fut (PID: ${pid})`)
  } catch {
    warn('Folyamat', `PID fajl letezik (${pid}) de a folyamat nem fut`)
  }
} else {
  warn('Folyamat', 'nem fut (nincs PID fajl)')
}

console.log('')
