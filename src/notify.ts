import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'

/**
 * Send one message to the configured channel and say whether every part of it arrived. A missing channel
 * config and a failed plain-text retry both count as "not delivered"; nothing throws. A caller that only
 * wants a best-effort notice uses notifyChannel; one that must react to a message that did not reach the
 * owner (a human-only approval request) uses this.
 */
export async function deliverToChannel(text: string): Promise<boolean> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    return false
  }

  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(text)
  const chunks = provider.splitMessage(formatted)

  let allDelivered = true
  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk, parseMode)
    } catch {
      try {
        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, text.slice(0, 4096))
      } catch {
        /* last resort, give up */
        allDelivered = false
      }
    }
  }
  return allDelivered
}

export async function notifyChannel(text: string): Promise<void> {
  await deliverToChannel(text)
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel

// Security-event notification (break-glass password reset, security:reset).
// Unlike notifyChannel, a missing channel config is an EXPECTED state here
// (fresh installs, channel-less deployments), so it stays fully silent -- the
// recovery path must never depend on, or be noisy about, Telegram being wired.
export async function notifySecurityEvent(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) return
  try {
    await notifyChannel(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
