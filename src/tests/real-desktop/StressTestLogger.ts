// src/tests/real-desktop/StressTestLogger.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Simple logger that appends JSON entries to a log file */
export class StressTestLogger {
  private logPath: string;
  private entries: any[] = [];

  constructor(logFileName: string = 'stress_test_log.json') {
    const config = require('../../config/desktopControlConfig').DesktopControlConfig;
    const dir = path.resolve(config.stressTest.tempDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.logPath = path.join(dir, logFileName);
  }

  /** Generate a new UUID for identifiers */
  static generateId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  /** Record an action with detailed metrics */
  record(entry: any) {
    const timestamp = new Date().toISOString();
    const enriched = { timestamp, ...entry };
    this.entries.push(enriched);
    // Append to file (one JSON per line for easy streaming)
    fs.appendFileSync(this.logPath, JSON.stringify(enriched) + '\n');
  }

  /** Get all logged entries (useful for later verification) */
  getAll(): any[] {
    return this.entries;
  }
}

export default StressTestLogger;
