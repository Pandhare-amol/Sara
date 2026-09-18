// src/services/SafetyCheck.ts
import { DesktopControlConfig } from '../config/desktopControlConfig';

export class SafetyCheck {
  /**
   * Verify that a target resolution meets the confidence threshold.
   * Returns true if safe, otherwise throws an error.
   */
  static verifyConfidence(confidence: number): void {
    if (confidence < DesktopControlConfig.confidenceThreshold) {
      throw new Error(`Confidence ${confidence} below threshold ${DesktopControlConfig.confidenceThreshold}`);
    }
  }

  /** Placeholder for stale screen detection – always returns true for now */
  static async isScreenFresh(): Promise<boolean> {
    // In a full implementation, compare timestamps or checksum of last screenshot.
    return true;
  }
}
