export type AutoFixKind = 'import-path' | 'config' | 'runtime';

export interface AutoFixRequest {
  kind: AutoFixKind;
  target: string;
  replacement: string;
  reason?: string;
}

export class AutoFixEngine {
  public applyTextFix(source: string, request: AutoFixRequest): string {
    if (!source || !request.target) {
      return source;
    }

    switch (request.kind) {
      case 'import-path': {
        return source.replaceAll(request.target, request.replacement);
      }
      case 'config': {
        return source.replaceAll(request.target, request.replacement);
      }
      case 'runtime': {
        return source.replaceAll(request.target, request.replacement);
      }
      default:
        return source;
    }
  }
}
