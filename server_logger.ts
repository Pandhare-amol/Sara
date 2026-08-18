import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { dataFile } from './server_paths';

export interface StructuredLog {
  timestamp: string;
  correlation_id?: string;
  component: string;
  task_id?: string;
  agent?: string;
  tool?: string;
  action?: string;
  result?: string;
  latency_ms?: number;
  error?: string;
  verification?: string;
  memory_event?: string;
}

export class Logger {
  private logFile: string;

  constructor() {
    this.logFile = dataFile('logs/sara_production.log');
    try {
      fsSync.mkdirSync(path.dirname(this.logFile), { recursive: true });
    } catch {}
  }

  public async log(entry: Omit<StructuredLog, 'timestamp'>) {
    const logEntry: StructuredLog = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    
    if (entry.error) {
      console.error(`[${logEntry.component}] ERROR: ${entry.error}`);
    }
    
    try {
      await fs.appendFile(this.logFile, logLine, 'utf8');
    } catch (e) {
      console.error('[Logger] Failed to write to log file', e);
    }
  }
}

export const sysLogger = new Logger();
