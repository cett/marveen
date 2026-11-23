// The body of the reconnect child (see reconnect-cli.ts, the bootstrap that loads the system_config snapshot first and
// then calls run()). It is imported only by the bootstrap, so config.ts is evaluated after the snapshot is set.
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { logger } from '../logger.js'

export function run(agentName: string): void {
  try {
    const result = attemptChannelMcpReconnect(agentName)
    logger.info(
      { agentName, ok: result.ok, message: result.message },
      'reconnect-cli: reconnect attempt finished',
    )
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    logger.error({ agentName, err }, 'reconnect-cli: reconnect attempt threw')
    process.exit(1)
  }
}
