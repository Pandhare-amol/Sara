import { PatchReviewEngine } from './PatchReviewEngine';
import { PatchExecutionEngine } from './PatchExecutionEngine';

export interface SelfMaintenanceRequest {
  filePath: string;
  issue: string;
  patch: string;
  verification?: (content: string) => Promise<boolean> | boolean;
}

export interface SelfMaintenanceResult {
  status: 'applied' | 'rejected' | 'failed' | 'manual-review';
  reviewStatus: 'approve' | 'reject' | 'manual-review';
  verified: boolean;
  details: string;
}

export class SelfMaintenanceOrchestrator {
  private readonly reviewEngine = new PatchReviewEngine();
  private readonly executionEngine: PatchExecutionEngine;

  constructor(private readonly options: { projectRoot: string }) {
    this.executionEngine = new PatchExecutionEngine(options);
  }

  public async run(request: SelfMaintenanceRequest): Promise<SelfMaintenanceResult> {
    const review = this.reviewEngine.review({
      issue: request.issue,
      filePath: request.filePath,
      patch: request.patch,
    });

    if (review.status !== 'approve') {
      return {
        status: review.status === 'reject' ? 'rejected' : 'manual-review',
        reviewStatus: review.status,
        verified: false,
        details: review.reason,
      };
    }

    const execution = await this.executionEngine.execute({
      filePath: request.filePath,
      issue: request.issue,
      patch: request.patch,
      verification: request.verification,
    });

    return {
      status: execution.status,
      reviewStatus: 'approve',
      verified: execution.verified,
      details: execution.message,
    };
  }
}
