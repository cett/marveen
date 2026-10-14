import pino from 'pino'
import { captureLogCall } from './otel-app-logs.js'

// OTLP application log export (OTel H6b): notes warn and above in a small buffer, the message template only
// (src/otel-app-logs.ts). It cannot fail a log call and changes nothing about the line pino writes.
export const appLogHooks: pino.LoggerOptions['hooks'] = {
  logMethod(args, method, level) {
    captureLogCall(level, args as unknown[])
    return method.apply(this, args)
  },
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  hooks: appLogHooks,
})
