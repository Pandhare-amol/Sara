export interface ASIQuery {
  question: string;
  domains: string[]; // e.g. ['physics', 'economics', 'psychology']
  depthLevel: 1 | 2 | 3 | 4 | 5; // 5 = maximum reasoning depth
  allowWebSearch: boolean;
}

export interface ASIResponse {
  answer: string;
  confidence: number; // 0-1
  novelInsights: string[];
  crossDomainLinks: Array<{ domainA: string; domainB: string; link: string }>;
  proposedNextSteps: string[];
  reasoningTrace: string[];
  processingTimeMs: number;
  assumptions?: string[];
  risks?: string[];
  evidenceGaps?: string[];
}

export interface InnovationTarget {
  id: string;
  title: string;
  description: string;
  domains: string[];
  status: 'active' | 'prototyping' | 'verified' | 'archived';
  createdAt: number;
}

export interface InnovationReport {
  id: string;
  targetId: string;
  hypothesis: string;
  findings: string[];
  prototypeResult?: string;
  score: number; // 0-1
  generatedAt: number;
}

export interface IntrospectionResult {
  cycleId: string;
  bottlenecksIdentified: string[];
  patchesProposed: number;
  durationMs: number;
  timestamp: number;
}

export interface EmotionalProfile {
  valence: number; // -1 to 1 (negative to positive)
  arousal: number; // -1 to 1 (calm to excited)
  stressLevel: number; // 0 to 1
  dominantEmotion: string;
  lastUpdated: number;
}
