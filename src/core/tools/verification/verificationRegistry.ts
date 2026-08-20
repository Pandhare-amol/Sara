/**
 * Verification contract for tool execution outcomes.
 * Independent verification happens AFTER execution succeeds.
 */

export type VerifierName = 
  | "filesystem"
  | "window"
  | "process"
  | "browser"
  | "screen"
  | "clipboard"
  | "none";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  evidence?: unknown;
  reason?: string;
}

export interface VerificationOutcome {
  verified: boolean;
  method: VerifierName;
  checks: VerificationCheck[];
  details: string;
  confidence: number; // 0.0 to 1.0
  observedState?: Record<string, unknown>;
}

export interface ToolVerifier {
  canVerify(tool: string, args: Record<string, unknown>): boolean;
  verify(
    tool: string,
    args: Record<string, unknown>,
    executionResult: unknown,
  ): Promise<VerificationOutcome>;
  timeout?: number;
}

/**
 * Registry of verifiers for specific tools.
 * Each verifier performs independent checks to confirm the tool's action took effect.
 */
export class VerificationRegistry {
  private verifiers: Map<VerifierName, ToolVerifier> = new Map();
  private toolToVerifier: Map<string, VerifierName[]> = new Map();

  registerVerifier(name: VerifierName, verifier: ToolVerifier): void {
    this.verifiers.set(name, verifier);
  }

  mapToolToVerifier(tool: string, verifierNames: VerifierName[]): void {
    this.toolToVerifier.set(tool, verifierNames);
  }

  getVerifiers(tool: string): ToolVerifier[] {
    const names = this.toolToVerifier.get(tool) || [];
    return names
      .map((name) => this.verifiers.get(name))
      .filter((v): v is ToolVerifier => v !== undefined);
  }

  async verifyExecution(
    tool: string,
    args: Record<string, unknown>,
    executionResult: unknown,
  ): Promise<VerificationOutcome | null> {
    const verifiers = this.getVerifiers(tool);
    if (verifiers.length === 0) {
      return null; // no verifier available for this tool
    }

    // Use the first applicable verifier
    for (const verifier of verifiers) {
      if (verifier.canVerify(tool, args)) {
        try {
          const timeout = verifier.timeout || 5000;
          return await Promise.race([
            verifier.verify(tool, args, executionResult),
            new Promise<VerificationOutcome>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Verification timeout for ${tool} after ${timeout}ms`)),
                timeout,
              ),
            ),
          ]);
        } catch (error) {
          return {
            verified: false,
            method: "none",
            checks: [
              {
                name: "verifier_error",
                passed: false,
                reason: String(error),
              },
            ],
            details: `Verification error: ${String(error)}`,
            confidence: 0,
          };
        }
      }
    }

    return null; // no verifier could handle this tool
  }
}
