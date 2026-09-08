// Former 2259-line monolith, split by domain (775) into:
//   agent-process-spawn.ts     -- process lifecycle (start/stop/restart)
//   agent-process-session.ts   -- tmux session + pane state (also owns the
//                                 shared tmux/claude bin resolvers)
//   agent-process-config.ts    -- per-agent config/channel provisioning
//   agent-process-identity.ts  -- first-run gates + identity slash setup
// Thin re-export shim so every existing importer keeps working unchanged.
export * from './agent-process-spawn.js'
export * from './agent-process-session.js'
export * from './agent-process-config.js'
export * from './agent-process-identity.js'
