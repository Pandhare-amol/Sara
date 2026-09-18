// src/services/RecoveryEngine.ts
import { DesktopControlConfig } from '../config/desktopControlConfig';
import { SafetyCheck } from './SafetyCheck';
import { TargetResolver } from './TargetResolver';
import { MouseController } from './MouseController';
import { KeyboardController } from './KeyboardController';

/**
 * RecoveryEngine handles retries and fallback strategies when an action fails.
 * The retry count is taken from DesktopControlConfig.retryCount.
 */
export class RecoveryEngine {
  /** Execute an async action with retries and fallback to UI Automation if needed. */
  static async executeWithRecovery<T>(
    action: () => Promise<T>,
    fallback?: () => Promise<T>,
  ): Promise<T> {
    let attempts = 0;
    const maxAttempts = DesktopControlConfig.retryCount;
    while (true) {
      try {
        const result = await action();
        // Basic sanity verification – ensure screen is fresh
        if (!(await SafetyCheck.isScreenFresh())) {
          throw new Error('Stale screen detected after action');
        }
        return result;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          if (fallback) {
            return await fallback();
          }
          throw err;
        }
        // small back‑off before retry
        await new Promise(r => setTimeout(r, 100 * attempts));
      }
    }
  }
}
