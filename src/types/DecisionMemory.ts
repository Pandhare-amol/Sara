/**
 * Decision and Question Memory Types
 * Tracks business decisions, strategic questions, and evidence-based reasoning
 */

export interface EvidenceItem {
  source: 'customer_interview' | 'market_data' | 'internal_data' | 'competitor_analysis' | 'calculation' | 'assumption' | 'external_research' | 'previous_decision' | 'user_statement';
  content: string;
  date: string;
  confidence: number; // 0-1: how much confidence in this evidence
  verified: boolean;
}

/**
 * DecisionMemory: Business decisions with full reasoning context
 * Enables comparing predictions vs. actual outcomes over time
 */
export interface DecisionMemory {
  id: string;
  type: 'decision';
  timestamp: number;
  confidence: number; // 0-1: confidence in this decision

  // Decision content
  title: string;
  description: string;
  decision: string; // The actual decision made
  reason: string; // Why this decision was made
  category: 'strategy' | 'product' | 'pricing' | 'hiring' | 'project' | 'timeline' | 'resource' | 'marketing' | 'partnership' | 'other';

  // Analysis
  evidence: EvidenceItem[]; // Supporting evidence
  contradictingEvidence: EvidenceItem[]; // Evidence against
  risks: Array<{ risk: string; probability: number; impact: string; mitigation: string }>;
  alternatives: Array<{ alternative: string; reason: string; whyNotChosen: string }>;

  // Predictions (for later evaluation)
  expectedOutcome: string;
  expectedValue?: number; // Financial or quantitative expectation
  timeToEvaluate: string; // When to check if prediction was right
  metrics: string[]; // How to measure success

  // Metadata
  decidedBy: 'sara' | 'user';
  mode: 'PERSONAL' | 'PROFESSIONAL'; // Which context
  relatedGoals: string[]; // Which goals does this serve
  tags: string[];
  metadata: Record<string, any>;

  // Resolution (filled in after time has passed)
  actualOutcome?: string;
  actualValue?: number;
  evaluatedAt?: number;
  evaluationNotes?: string;
  predictionAccuracy?: number; // 0-1: how accurate was the prediction
  lessonsLearned?: string;
}

/**
 * QuestionMemory: Strategic and tactical questions SARA asks
 * Enables SARA to ask follow-up questions, track what was answered, and use answers to improve
 */
export interface QuestionMemory {
  id: string;
  type: 'question';
  timestamp: number;

  // Question content
  question: string;
  category: 'clarification' | 'validation' | 'research' | 'strategic' | 'tactical' | 'personal' | 'preference';
  importance: number; // 0-1: how important is this question
  reason: string; // Why SARA is asking
  source: 'proactive' | 'user_initiated' | 'memory_gap' | 'contradiction_detected' | 'decision_support';

  // Context
  relatedMemories?: string[]; // Memory IDs this question is grounded in
  relatedDecisions?: string[]; // Decision IDs this question supports
  relatedGoals?: string[];

  // Tracking
  asked: boolean;
  askedAt?: number;
  userResponded: boolean;
  answer?: string; // User's answer when they respond
  answeredAt?: number;
  answerConfidence?: number; // How confident is the answer

  // Impact
  didUserAnswerChange?: Record<string, any>; // Did the answer change memory/decisions?
  followUpQuestion?: string; // Should we ask a follow-up?

  tags: string[];
  metadata: Record<string, any>;
}

export function createDecisionMemory(
  title: string,
  description: string,
  decision: string,
  reason: string,
  category: DecisionMemory['category'],
  evidence: EvidenceItem[] = [],
  confidence: number = 0.7
): DecisionMemory {
  return {
    id: `mem-dec-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'decision',
    timestamp: Date.now(),
    confidence,
    title,
    description,
    decision,
    reason,
    category,
    evidence,
    contradictingEvidence: [],
    risks: [],
    alternatives: [],
    expectedOutcome: '',
    timeToEvaluate: '',
    metrics: [],
    decidedBy: 'sara',
    mode: 'PROFESSIONAL',
    relatedGoals: [],
    tags: ['business_decision'],
    metadata: {},
  };
}

export function createQuestionMemory(
  question: string,
  category: QuestionMemory['category'],
  reason: string,
  source: QuestionMemory['source'] = 'proactive',
  importance: number = 0.5
): QuestionMemory {
  return {
    id: `mem-q-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'question',
    timestamp: Date.now(),
    question,
    category,
    importance,
    reason,
    source,
    asked: false,
    userResponded: false,
    tags: [],
    metadata: {},
  };
}
