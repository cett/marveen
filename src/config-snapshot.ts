// The PostgreSQL snapshot of the system_config overrides (phase 3, step 6c-3). A leaf module: it imports nothing from config.ts
// (config.ts imports it), so the bootstrap in src/index.ts can set the snapshot before config.ts evaluates. Set once per
// process, stored as a frozen copy.
//
// The constants config.ts computes from the overrides are evaluated at import time, so a setSystemConfig after the boot
// does not reach them. That is not new: the SQLite cache has always been read once per process, and the restart flows
// re-run the bootstrap, which loads the snapshot again.

/** A PostgreSQL install started without its snapshot: the process refuses (it must not read the SQLite file instead). */
export class ConfigSnapshotMissingError extends Error {
  constructor() {
    super('PostgreSQL install but no system_config snapshot: start through dist/index.js (the bootstrap loads it), '
      + 'or a script through scripts/with-config.ts (the runner loads it).')
    this.name = 'ConfigSnapshotMissingError'
  }
}

let snapshot: Readonly<Record<string, string>> | undefined

/** Sets the snapshot of this process. A second call throws: the first value stays. The rows are copied and frozen. */
export function setConfigSnapshot(rows: Record<string, string>): void {
  if (snapshot !== undefined) throw new Error('config snapshot is already set (it is set once per process)')
  snapshot = Object.freeze({ ...rows })
}

/** The snapshot of this process, or undefined before the bootstrap set it. */
export function getConfigSnapshot(): Readonly<Record<string, string>> | undefined {
  return snapshot
}
