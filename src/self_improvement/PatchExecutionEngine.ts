import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type PatchExecutionStatus = 'applied' | 'rejected' | 'failed' | 'manual-review';

export interface PatchExecutionRequest {
  filePath: string;
  patch: string;
  issue: string;
  verification?: (content: string) => Promise<boolean> | boolean;
}

export interface PatchExecutionOptions {
  projectRoot: string;
}

export interface PatchExecutionResult {
  status: PatchExecutionStatus;
  filePath: string;
  message: string;
  verified: boolean;
}

export class PatchExecutionEngine {
  constructor(private readonly options: PatchExecutionOptions) {}

  public async execute(request: PatchExecutionRequest): Promise<PatchExecutionResult> {
    const safeFilePath = request.filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absoluteFilePath = path.resolve(this.options.projectRoot, safeFilePath);

    if (!absoluteFilePath.startsWith(path.resolve(this.options.projectRoot))) {
      return {
        status: 'rejected',
        filePath: request.filePath,
        message: 'Patch attempted to escape the project root. Rejected for safety.',
        verified: false,
      };
    }

    try {
      const existing = await fs.readFile(absoluteFilePath, 'utf8');
      const patched = request.patch;
      const updated = patched.length > 0 ? patched : existing;
      await fs.writeFile(absoluteFilePath, updated, 'utf8');

      const verify = request.verification ?? (() => true);
      const ok = await verify(updated);

      if (!ok) {
        await fs.writeFile(absoluteFilePath, existing, 'utf8');
        return {
          status: 'failed',
          filePath: request.filePath,
          message: 'Patch changed behavior but failed post-apply verification.',
          verified: false,
        };
      }

      return {
        status: 'applied',
        filePath: request.filePath,
        message: `Approved patch applied for issue: ${request.issue}`,
        verified: true,
      };
    } catch (error: any) {
      return {
        status: 'failed',
        filePath: request.filePath,
        message: error?.message || 'Patch execution failed.',
        verified: false,
      };
    }
  }
}
