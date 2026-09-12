import type { Explanation, SafetyResult } from "./advanced-types";

const piiPatterns: Array<[string, RegExp, string]> = [["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"], ["phone", /\b(?:\+?\d[\d ()-]{7,}\d)\b/g, "[REDACTED_PHONE]"], ["api_key", /\b(?:sk|pk|key)[_-][A-Z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]"]];

export class SafetyService {
  sanitize(text: string): SafetyResult {
    let sanitized = text;
    const redactions: SafetyResult["redactions"] = [];
    for (const [type, pattern, replacement] of piiPatterns) { if (pattern.test(sanitized)) redactions.push({ type, replacement }); sanitized = sanitized.replace(pattern, replacement); pattern.lastIndex = 0; }
    const categories = /\b(kill|bomb|terrorist|explosive)\b/i.test(sanitized) ? ["violent-content"] : [];
    return { allowed: categories.length === 0, text: sanitized, categories, redactions, warnings: redactions.length ? ["PII or secrets were redacted before external processing."] : [] };
  }
  enforce(text: string): string { const result = this.sanitize(text); if (!result.allowed) throw new Error(`Request blocked by safety policy: ${result.categories.join(", ")}.`); return result.text; }
}

export function explainResponse(text: string, confidence: number, evidence: string[] = [], alternatives: string[] = []): Explanation { return { summary: text, confidence: Math.max(0, Math.min(1, confidence)), evidence, alternatives, reasoningTrace: evidence.map((item, index) => `Step ${index + 1}: ${item}`) }; }
