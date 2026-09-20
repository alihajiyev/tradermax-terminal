import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import type { LogEntry } from '../../renderer/types/trading.js';

export class Logger {
  private context: string;
  private logs: LogEntry[] = [];
  private maxLogs: number = 10000;
  private logFile: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(context: string) {
    this.context = context;
    const logDir = join(app.getPath('userData'), 'tradermax', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFile = join(logDir, `${context.toLowerCase()}-${new Date().toISOString().split('T')[0]}.log`);
    this.initializeWriteStream();
  }

  private initializeWriteStream(): void {
    this.writeStream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  private formatMessage(level: LogEntry['level'], message: string, meta?: any): LogEntry {
    return {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      level,
      context: this.context,
      message,
      meta,
    };
  }

  private write(log: LogEntry): void {
    this.logs.push(log);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const logLine = `${new Date(log.timestamp).toISOString()} [${log.level.toUpperCase()}] [${log.context}] ${log.message}${log.meta ? ` ${JSON.stringify(log.meta)}` : ''}\n`;
    
    if (this.writeStream) {
      this.writeStream.write(logLine);
    }

    // Also log to console in development
    if (process.env.NODE_ENV === 'development') {
      const consoleMethod = log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[${log.context}]`, log.message, log.meta || '');
    }
  }

  info(message: string, meta?: any): void {
    this.write(this.formatMessage('info', message, meta));
  }

  warn(message: string, meta?: any): void {
    this.write(this.formatMessage('warn', message, meta));
  }

  error(message: string, meta?: any): void {
    this.write(this.formatMessage('error', message, meta));
  }

  debug(message: string, meta?: any): void {
    this.write(this.formatMessage('debug', message, meta));
  }

  getLogs(limit: number = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
    if (this.writeStream) {
      this.writeStream.end();
      this.initializeWriteStream();
    }
  }

  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

// Global logger instance for main process
export const mainLogger = new Logger('Main');