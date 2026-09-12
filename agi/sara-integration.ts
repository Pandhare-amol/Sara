import type { AgiService } from "./service";
import type { AgiInsight } from "./types";

export type SaraFeature = "search" | "recommendations" | "analytics" | "notifications" | "workflows" | "forms" | "reports" | "troubleshooting";
export interface SaraFeatureResult { feature: SaraFeature; insight: AgiInsight; suggestions: string[]; summary?: string; predictedIntent?: string; }
export interface SaraIntegrationConfig { enabled: boolean; features: Partial<Record<SaraFeature, boolean>>; }

export class SaraIntegrationLayer {
  constructor(private readonly service: AgiService, private readonly config: SaraIntegrationConfig = { enabled: false, features: {} }) {}
  async enrich(feature: SaraFeature, input: string, sessionId: string, userId?: string): Promise<SaraFeatureResult | null> {
    if (!this.config.enabled || this.config.features[feature] === false) return null;
    const insight = await this.service.analyze(input, sessionId, userId);
    const suggestions = [...insight.suggestions];
    if (feature === "search") suggestions.push("Use semantic context and related terms");
    if (feature === "workflows") suggestions.push("Review the next expected workflow step");
    if (feature === "notifications") suggestions.push(insight.sentiment === "negative" ? "Use a calm, supportive notification tone" : "Use the user's preferred notification timing");
    if (feature === "forms") suggestions.push("Pre-populate only fields confirmed by the user");
    return { feature, insight, suggestions: [...new Set(suggestions)], predictedIntent: insight.intent, summary: feature === "reports" ? input.slice(0, 500) : undefined };
  }
  async semanticSearch(query: string, sessionId: string, userId?: string): Promise<string[]> { return (await this.service.context.retrieve(query, userId)).filter((item) => item.sessionId === sessionId || !sessionId).map((item) => item.content); }
  async recommend(input: string, sessionId: string, userId?: string): Promise<string[]> { return (await this.enrich("recommendations", input, sessionId, userId))?.suggestions ?? []; }
}

export interface SuccessMetrics { taskCompletionMs?: number; satisfaction?: number; adopted?: boolean; errorsPrevented?: number; costSaved?: number; }
export class SaraSuccessMetrics { private readonly values: SuccessMetrics[] = []; record(metrics: SuccessMetrics): void { this.values.push({ ...metrics }); } snapshot(): SuccessMetrics { const values = this.values; return { taskCompletionMs: average(values.map((item) => item.taskCompletionMs)), satisfaction: average(values.map((item) => item.satisfaction)), adopted: values.filter((item) => item.adopted).length > values.length / 2, errorsPrevented: values.reduce((sum, item) => sum + (item.errorsPrevented ?? 0), 0), costSaved: values.reduce((sum, item) => sum + (item.costSaved ?? 0), 0) }; } }
function average(values: Array<number | undefined>): number | undefined { const numbers = values.filter((value): value is number => value !== undefined); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : undefined; }
