export interface Memory {
  id: string;
  category: "identity" | "preference" | "goal" | "project" | "relationship" | "emotional" | "behavior" | "decision" | "question";
  tier?: "short_term" | "episodic" | "semantic" | "procedural";
  importance?: number;
  confidence?: number; // 0-1: truth-level confidence
  text: string;
  createdAt: string;
  updatedAt: string;

  // Truth-driven metadata: distinguish fact from assumption
  source?: "fact" | "verified_data" | "user_provided" | "historical_memory" | "external_research" | "reasonable_inference" | "uncertain" | "opinion" | "prediction";
  evidence?: string[]; // Sources or citations supporting this memory
  contradictingEvidence?: string[]; // Known contradictions
  lastVerified?: string; // When this was last confirmed accurate
  verificationStatus?: "verified" | "unverified" | "partially_verified" | "contradicted" | "outdated";

  // Mode context
  mode?: "PERSONAL" | "PROFESSIONAL"; // Which operating mode
}

export type MemoryCategory = Memory["category"];

export interface MemoryTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id: string;
  category: MemoryCategory;
  text: string;
}
