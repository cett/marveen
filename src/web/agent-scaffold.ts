// Agent scaffolding barrel (kept for import-path compatibility with the
// ~30 consumers of this module -- split into agent-scaffold-hooks.ts and
// agent-scaffold-templates.ts for #773/#779; see those files for the real
// code). Re-exports everything that was previously exported from here.

export * from './agent-scaffold-hooks.js'
export * from './agent-scaffold-templates.js'
