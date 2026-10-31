// Side-effect module: import it FIRST in a command-line tool whose stdout is its result. It makes
// the shared logger (src/logger.ts) write to stderr, so startup lines such as "Migration applied" and
// the schema report never mix into the output a caller parses. ES module imports run in order, so
// this must come before anything that loads src/db.js or src/logger.js.
process.env.LOG_TO_STDERR = '1'
