// Live tool children of the pane leader, for the stuck tool-call watcher.
//
// While a long foreground Bash/python tool call runs, the TUI counter freezes and the pane-leader claude idles at
// ~1-2% CPU, which matches the idle wedge profile of the CPU guard exactly (observed: tag=baked seconds=20
// stagnantPolls=7 cpuPercent=1.8 -> respawn-pane while a python harness was working). The genuine wedge (a hung MCP
// or stdio reply) has NO tool child doing work. So before recovering, look at the pane leader's descendants: a
// non-shell descendant that is running, or that burned CPU during the last polls, means a tool call is alive and
// the freeze is not a wedge.
//
// Which children count: only processes UNDER a shell child of the pane leader. The Bash tool runs every command as
// `<shell> -c ...` directly under claude, so a tool call's work is always in a shell's subtree. The leader's other
// direct children (an MCP or channel plugin, caffeinate, node MCP servers) stay alive, and sometimes busy, in a REAL
// wedge and must not mask it. Residual risk: an MCP server that is itself launched through a shell would count; the
// hard cap (MAX_CHILD_DEFER_MS) bounds that.
//
// The deferral is never endless: once the counter has been stagnant for MAX_CHILD_DEFER_MS, recovery proceeds
// whatever the children do. 15 minutes is well above a normal long foreground tool call (test suites and builds take
// 5-10 minutes) and short enough that a frozen TUI whose "tool child" never ends is restored within a quarter of an
// hour.
//
// Fail-open for recovery: a failed sample (tmux or ps error, unusable pane pid) never refreshes the last-activity
// stamp (a broken poll cannot keep a deferral alive) and zeroes the CPU baseline (a CPU jump across the gap is not
// read as fresh activity). A persistent failure lets the activity window, and in the end the hard cap, run out.
//
// Stated limit: a tool child that only sleeps (no CPU, state S, e.g. a bare `sleep 600`) is not detected as active.

export interface ProcSample { pid: number; ppid: number; state: string; cpuMs: number; comm: string }

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'])
export const CHILD_ACTIVE_CPU_DELTA_MS = 1000
export const CHILD_ACTIVITY_WINDOW_MS = 90_000
export const MAX_CHILD_DEFER_MS = 15 * 60_000

// Pure: has the stagnation lasted so long that child activity may no longer defer recovery? No stagnation recorded
// (null) is not expired.
export function childDeferExpired(stagnantSince: number | null, nowMs: number, maxMs = MAX_CHILD_DEFER_MS): boolean {
  return stagnantSince !== null && nowMs - stagnantSince >= maxMs
}

// Pure: `ps cputime` -> ms. Formats: [[dd-]hh:]mm:ss[.ff] (macOS mm:ss.ff, Linux hh:mm:ss).
export function parsePsCpuTimeMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const [, d, h, mi, s] = m
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s)) * 1000
}

// Pure: parse `ps -axww -o pid=,ppid=,stat=,cputime=,comm=` (comm last: it may hold spaces).
export function parseProcSnapshot(out: string): ProcSample[] {
  const rows: ProcSample[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const cpuMs = parsePsCpuTimeMs(m[4]!)
    if (cpuMs === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3]!, cpuMs, comm: m[5]! })
  }
  return rows
}

function commBase(comm: string): string {
  return comm.split('/').pop()!.replace(/^-/, '').trim()
}

function isShellComm(comm: string): boolean {
  return SHELL_NAMES.has(commBase(comm))
}

// Pure: the process the tool-call subtree hangs under. Normally the pane pid IS the claude process. If a session's
// pane pid is a shell or a wrapper script, the claude process is its non-shell child (preferring one named `claude`,
// else the single non-shell child); with none identifiable the result is null (the guard cannot scope the subtree and
// stays inactive; the caller warns once).
export function resolveToolRoot(procs: ProcSample[], panePid: number): { root: number | null; viaShell: boolean } {
  const self = procs.find((p) => p.pid === panePid)
  if (!self) return { root: null, viaShell: false }
  if (!isShellComm(self.comm)) return { root: panePid, viaShell: false }
  const kids = procs.filter((p) => p.ppid === panePid && !isShellComm(p.comm))
  const claude = kids.find((k) => commBase(k.comm) === 'claude') ?? (kids.length === 1 ? kids[0] : undefined)
  return { root: claude ? claude.pid : null, viaShell: true }
}

// Pure: the non-shell processes in the subtrees of the SHELL children of rootPid (the root, its non-shell direct
// children and their subtrees are excluded).
export function toolDescendants(procs: ProcSample[], rootPid: number): ProcSample[] {
  const kids = new Map<number, ProcSample[]>()
  for (const p of procs) {
    const l = kids.get(p.ppid) ?? []
    l.push(p)
    kids.set(p.ppid, l)
  }
  const out: ProcSample[] = []
  const seen = new Set<number>([rootPid])
  const stack: number[] = []
  for (const c of kids.get(rootPid) ?? []) {
    if (isShellComm(c.comm)) { seen.add(c.pid); stack.push(c.pid) }
  }
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      stack.push(c.pid)
      if (!isShellComm(c.comm)) out.push(c)
    }
  }
  return out
}

export interface ChildActivity { cpuMs: Map<number, number> | null; lastActiveAt: number | null }

// Pure: fold one snapshot into the tracker. A descendant is ACTIVE when it is in the running state, or its cumulative
// CPU grew by >= CHILD_ACTIVE_CPU_DELTA_MS since the previous poll (a pid first seen after a baseline exists counts
// its whole CPU time: it was spawned within the last poll). The first poll of a spell has no baseline, so only the
// running state counts there.
export function observeToolChildren(prev: ChildActivity, procs: ProcSample[], rootPid: number, nowMs: number): ChildActivity {
  const kids = toolDescendants(procs, rootPid)
  const cpuMs = new Map<number, number>(kids.map((k) => [k.pid, k.cpuMs]))
  const active = kids.some(
    (k) => k.state.startsWith('R') || (prev.cpuMs !== null && k.cpuMs - (prev.cpuMs.get(k.pid) ?? 0) >= CHILD_ACTIVE_CPU_DELTA_MS),
  )
  return { cpuMs, lastActiveAt: active ? nowMs : prev.lastActiveAt }
}

// Pure: is a tool call alive (activity seen within the window)?
export function toolChildRecentlyActive(a: ChildActivity | undefined, nowMs: number): boolean {
  return a?.lastActiveAt != null && nowMs - a.lastActiveAt < CHILD_ACTIVITY_WINDOW_MS
}
