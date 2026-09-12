export type StrategyPriority = "low" | "medium" | "high" | "critical";
export type KpiStatus = "on_track" | "at_risk" | "off_track" | "unknown";

export interface BusinessEvidence { statement: string; source: string; asOf?: string; confidence: number; verified: boolean; }
export interface BusinessProfile { name: string; offering: string; customers: string; geography?: string; stage?: "idea" | "startup" | "growth" | "mature"; goals: string[]; constraints?: string[]; evidence: BusinessEvidence[]; }
export interface Competitor { name: string; offering: string; strengths: string[]; weaknesses: string[]; evidence: BusinessEvidence[]; }
export interface SwotAnalysis { strengths: string[]; weaknesses: string[]; opportunities: string[]; threats: string[]; evidenceGaps: string[]; }
export interface BusinessAssessment { profile: BusinessProfile; swot: SwotAnalysis; marketPosition: { statement: string; differentiators: string[]; positioningRisks: string[]; confidence: number }; competitiveLandscape: { competitors: Competitor[]; comparisonCriteria: string[]; unknowns: string[] }; assumptions: string[]; recommendedNextQuestions: string[]; }
export interface StrategyAction { id: string; title: string; owner: string; priority: StrategyPriority; dueDate?: string; dependencies: string[]; expectedResult: string; metricIds: string[]; riskControls: string[]; status: "not_started" | "in_progress" | "blocked" | "done"; }
export interface KpiDefinition { id: string; name: string; unit: string; target: number; direction: "higher_is_better" | "lower_is_better"; }
export interface KpiObservation { kpiId: string; value: number; observedAt: string; source: string; }

export class BusinessAssessmentService {
  assess(profile: BusinessProfile, competitors: Competitor[] = []): BusinessAssessment {
    const verified = profile.evidence.filter((item) => item.verified && item.confidence >= 0.7);
    const evidenceGaps = [
      profile.customers ? "" : "Target customer evidence is missing.",
      profile.goals.length ? "" : "Measurable business goals are missing.",
      verified.length ? "" : "No high-confidence verified evidence was supplied.",
    ].filter(Boolean);
    const strengths = profile.evidence.filter((item) => /traction|retention|advantage|patent|revenue|expertise|loyal/i.test(item.statement)).map((item) => item.statement);
    const weaknesses = [...(profile.constraints ?? []), ...profile.evidence.filter((item) => /churn|debt|shortage|dependency|weak|limited/i.test(item.statement)).map((item) => item.statement)];
    const opportunities = profile.goals.map((goal) => `Pursue the stated goal: ${goal}`);
    const threats = competitors.flatMap((competitor) => competitor.strengths.map((strength) => `${competitor.name}: ${strength}`));
    const differentiators = strengths.length ? strengths.slice(0, 5) : ["No differentiator is verified yet; validate this before positioning the business."];
    const confidence = verified.length ? Math.min(0.95, 0.45 + verified.length * 0.1) : 0.2;
    return {
      profile,
      swot: { strengths, weaknesses, opportunities, threats, evidenceGaps },
      marketPosition: { statement: strengths.length ? `${profile.name} can position around its verified strengths for ${profile.customers || "a defined customer segment"}.` : "Market position cannot be determined reliably from the supplied evidence.", differentiators, positioningRisks: evidenceGaps.length ? ["Positioning is based on incomplete evidence."] : [], confidence },
      competitiveLandscape: { competitors, comparisonCriteria: ["customer segment", "value proposition", "price", "distribution", "retention", "proof of outcomes"], unknowns: competitors.flatMap((competitor) => competitor.evidence.length ? [] : [`No evidence supplied for ${competitor.name}.`]) },
      assumptions: [profile.customers ? "The stated customer segment is accurate." : "Customer segment is unknown.", "Supplied evidence is representative rather than selectively sampled."],
      recommendedNextQuestions: ["Which customer problem is urgent enough to pay for now?", "What baseline and target define success?", "Which competitor alternative does the customer use today?"],
    };
  }

  plan(assessment: BusinessAssessment, actions: StrategyAction[]): { actions: StrategyAction[]; alignmentChecklist: string[]; processChanges: string[] } {
    const checklist = ["Each action has one accountable owner.", "Every action links to a measurable KPI.", "Dependencies and approval boundaries are documented.", "Risks have an owner and a mitigation trigger."];
    const processChanges = assessment.swot.evidenceGaps.length ? ["Create an evidence register with source, date, confidence, and verification status.", "Review assumptions before committing budget or changing strategy."] : ["Run a weekly KPI review and a monthly strategy review.", "Record decisions, expected outcomes, and lessons learned."];
    return { actions: actions.map((action) => ({ ...action, riskControls: action.riskControls.length ? action.riskControls : ["Define a measurable stop or review trigger before execution."] })), alignmentChecklist: checklist, processChanges };
  }
}

export class KpiTracker {
  private readonly observations: KpiObservation[] = [];
  constructor(private readonly definitions: KpiDefinition[]) {}
  record(observation: KpiObservation): void { const definition = this.definitions.find((item) => item.id === observation.kpiId); if (!definition) throw new Error(`Unknown KPI '${observation.kpiId}'.`); if (!Number.isFinite(observation.value)) throw new Error("KPI value must be finite."); this.observations.push({ ...observation }); }
  status(kpiId: string): KpiStatus { const definition = this.definitions.find((item) => item.id === kpiId); const current = this.latest(kpiId); if (!definition || !current) return "unknown"; const achieved = definition.direction === "higher_is_better" ? current.value >= definition.target : current.value <= definition.target; const near = definition.direction === "higher_is_better" ? current.value >= definition.target * 0.8 : current.value <= definition.target * 1.2; return achieved ? "on_track" : near ? "at_risk" : "off_track"; }
  latest(kpiId: string): KpiObservation | undefined { return [...this.observations].filter((item) => item.kpiId === kpiId).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]; }
  recommendations(): string[] { return this.definitions.flatMap((definition) => { const current = this.latest(definition.id); const status = this.status(definition.id); if (status === "off_track") return [`Investigate ${definition.name}; current value ${current?.value} ${definition.unit} misses target ${definition.target}. Review owner, assumptions, and corrective action.`,]; if (status === "at_risk") return [`Monitor ${definition.name} more frequently and define an escalation trigger before it misses target.`]; return []; }); }
  snapshot(): Array<KpiDefinition & { status: KpiStatus; latest?: KpiObservation }> { return this.definitions.map((definition) => ({ ...definition, status: this.status(definition.id), latest: this.latest(definition.id) })); }
}
