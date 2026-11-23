import { ConsoleLogger } from '@nestjs/common';

export interface LogEntry {
  at: string;
  level: 'warn' | 'error';
  context: string;
  message: string;
}

/** The newest backend warnings / errors, kept in memory for Admin → Logs. */
export const LOG_BUFFER: LogEntry[] = [];
const MAX = 2000;

function push(level: LogEntry['level'], message: unknown, context?: string, stack?: unknown) {
  const text = [message instanceof Error ? message.message : String(message), typeof stack === 'string' ? stack : '']
    .filter(Boolean)
    .join('\n');
  LOG_BUFFER.push({ at: new Date().toISOString(), level, context: context ?? '', message: text.slice(0, 4000) });
  if (LOG_BUFFER.length > MAX) LOG_BUFFER.splice(0, LOG_BUFFER.length - MAX);
}

/** Nest console logger that also remembers warnings and errors. */
export class BufferedLogger extends ConsoleLogger {
  override warn(message: unknown, ...rest: unknown[]): void {
    push('warn', message, typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : this.context);
    super.warn(message, ...(rest as [string]));
  }

  override error(message: unknown, ...rest: unknown[]): void {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : this.context;
    push('error', message, context, rest.length > 1 ? rest[0] : undefined);
    super.error(message, ...(rest as [string]));
  }
}
