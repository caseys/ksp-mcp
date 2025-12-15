import { createWriteStream, mkdirSync, WriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/**
 * Lightweight trace logger that records raw transport IO when KOS_TRACE is set.
 */
export class TransportTraceLogger {
  private readonly enabled: boolean;
  private stream: WriteStream | null = null;

  constructor(private readonly context: string) {
    this.enabled = Boolean(process.env.KOS_TRACE);
    if (!this.enabled) {
      return;
    }

    const dir =
      process.env.KOS_TRACE_DIR ??
      join(process.cwd(), 'logs');
    mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = randomUUID().split('-')[0];
    const filePath = join(dir, `kos-trace-${context}-${timestamp}-${id}.log`);
    this.stream = createWriteStream(filePath, { flags: 'a' });
    this.stream.write(`# Trace start ${new Date().toISOString()} (${context})\n`);
  }

  logSend(data: string | Buffer): void {
    this.write('SEND', data);
  }

  logReceive(data: string | Buffer): void {
    this.write('RECV', data);
  }

  logInfo(message: string): void {
    this.write('INFO', message);
  }

  logError(error: unknown): void {
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.write('ERROR', msg);
  }

  close(): void {
    if (!this.stream) {
      return;
    }
    this.stream.write(`# Trace end ${new Date().toISOString()}\n`);
    this.stream.end();
    this.stream = null;
  }

  private write(type: 'SEND' | 'RECV' | 'INFO' | 'ERROR', payload: string | Buffer): void {
    if (!this.stream) {
      return;
    }

    const stamp = new Date().toISOString();
    const formatted = typeof payload === 'string'
      ? this.formatStringPayload(payload)
      : this.formatBufferPayload(payload);

    this.stream.write(`[${stamp}] [${this.context}] ${type}: ${formatted}\n`);
  }

  private formatStringPayload(payload: string): string {
    const buffer = Buffer.from(payload, 'utf8');
    return this.formatBufferPayload(buffer);
  }

  private formatBufferPayload(buffer: Buffer): string {
    const text = JSON.stringify(buffer.toString('utf8'));
    const hexHash = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
    const hexPreview = buffer.toString('hex');
    return `${text} (bytes=${buffer.length}, sha1=${hexHash}, hex=${hexPreview})`;
  }
}
