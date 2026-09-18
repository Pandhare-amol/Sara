export type PatchReviewStatus = 'approve' | 'reject' | 'manual-review';

export interface PatchReviewRequest {
  issue: string;
  filePath: string;
  patch: string;
}

export interface PatchReviewResult {
  status: PatchReviewStatus;
  reason: string;
  risk: 'low' | 'medium' | 'high';
}

export class PatchReviewEngine {
  public review(request: PatchReviewRequest): PatchReviewResult {
    const patchText = String(request.patch ?? '').trim();
    const filePath = String(request.filePath ?? '');
    const issue = String(request.issue ?? '');

    const destructivePatterns = [
      /rm\s+-rf\s+/i,
      /del\s+\//i,
      /format\s+c:/i,
      /shutdown\s+-s/i,
      /git\s+reset\s+--hard/i,
      /drop\s+database/i,
      /unlink\s*\(|fs\.rmSync\s*\(/i,
      /process\.kill\s*\(/i,
      /\bexec\s*\(/i,
    ];

    if (destructivePatterns.some((pattern) => pattern.test(patchText))) {
      return {
        status: 'reject',
        reason: 'Dangerous patch detected: command or file operation is unsafe for autonomous execution.',
        risk: 'high',
      };
    }

    const safeTextPatterns = [
      /import\s+.*from\s+['"].+['"]/,
      /const\s+\w+\s*=\s*.*;/,
      /if\s*\(/,
      /return\s+.*;/,
      /throw\s+new\s+Error\(/,
      /setInterval\s*\(/,
      /switch\s*\(/,
    ];

    const changesOnlyCode = patchText.length > 0 && !/\b(rm|del|curl|wget|powershell|bash|cmd|git|npm|npx|pip|conda)\b/i.test(patchText);
    const isLikelySafe = (issue.toLowerCase().includes('module') || issue.toLowerCase().includes('import'))
      || safeTextPatterns.some((pattern) => pattern.test(patchText))
      || (filePath.includes('.ts') || filePath.includes('.tsx') || filePath.includes('.js'));

    if (!changesOnlyCode || (!isLikelySafe && filePath.length === 0)) {
      return {
        status: 'manual-review',
        reason: 'Patch needs human review before it can be safely applied.',
        risk: 'medium',
      };
    }

    return {
      status: 'approve',
      reason: 'Patch is bounded to a code-level change and does not include dangerous filesystem or shell operations.',
      risk: 'low',
    };
  }
}
