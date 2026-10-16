import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket, connect } from 'net';

/**
 * Minimal plain-SMTP sender for Raster Analysis alerts — no dependency, no
 * TLS / auth: meant for the compose network's Mailpit (dev) or an internal
 * relay. Configure SMTP_HOST / SMTP_PORT / MAIL_FROM; outside production it
 * defaults to the dev Mailpit container (inbox: http://localhost:8025).
 * Sending never throws — an alert email is best effort.
 */
@Injectable()
export class RasterMailService {
  private readonly logger = new Logger(RasterMailService.name);
  private readonly host: string | undefined;
  private readonly port: number;
  private readonly from: string;
  readonly appUrl: string;

  constructor(config: ConfigService) {
    this.host =
      config.get<string>('SMTP_HOST') ?? (config.get<string>('NODE_ENV') === 'production' ? undefined : 'mailpit');
    this.port = Number(config.get<string>('SMTP_PORT') ?? 1025);
    this.from = config.get<string>('MAIL_FROM') ?? 'gis-alerts@municipal-gis.local';
    this.appUrl = config.get<string>('APP_PUBLIC_URL') ?? 'http://localhost:4200';
  }

  async send(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.host) return false;
    const message = [
      `From: Municipal GIS <${this.from}>`,
      `To: <${to}>`,
      `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      // Dot-stuffing: a line starting with "." must be doubled.
      text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    ].join('\r\n');
    try {
      await this.dialog([
        null,
        'HELO municipal-gis',
        `MAIL FROM:<${this.from}>`,
        `RCPT TO:<${to}>`,
        'DATA',
        `${message}\r\n.`,
        'QUIT',
      ]);
      return true;
    } catch (error) {
      this.logger.warn(`Alert email to ${to} not sent: ${(error as Error).message}`);
      return false;
    }
  }

  /** Sends each command after the previous reply; any 4xx/5xx aborts. */
  private dialog(commands: (string | null)[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect({ host: this.host, port: this.port });
      socket.setTimeout(15000, () => socket.destroy(new Error('SMTP timeout')));
      let step = 0;
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        // A reply is complete at a line "NNN <text>" (not "NNN-").
        const lines = buffer.split('\r\n').filter(Boolean);
        const last = lines[lines.length - 1] ?? '';
        if (!/^\d{3} /.test(last)) return;
        buffer = '';
        if (/^[45]/.test(last)) {
          socket.destroy();
          return reject(new Error(`SMTP: ${last}`));
        }
        step++;
        if (step >= commands.length) {
          socket.end();
          return resolve();
        }
        socket.write(`${commands[step]}\r\n`);
      });
      socket.on('error', reject);
      socket.on('close', () => step < commands.length && reject(new Error('SMTP connection closed')));
    });
  }
}
