/**
 * Cognitive Architecture - Main Entry Point
 *
 * Exports all cognitive modules for use throughout SARA.
 */

export * from "./types";
export * from "./workingMemory";
export * from "./episodicMemory";
export * from "./semanticMemory";
export * from "./proceduralMemory";
export * from "./autobiographicalMemory";
export * from "./memoryConsolidator";
export * from "./orchestrator";
export * from "./planner";
export * from "./strategyManager";
export * from "./evaluator";
export * from "./integrationBridge";

// Re-export singletons for convenience
export {
  getCognitiveOrchestrator,
  resetCognitiveOrchestrator,
} from "./orchestrator";
export { getPlanningEngine } from "./planner";
export { getStrategyManager } from "./strategyManager";
export { getTaskEvaluator } from "./evaluator";
export { getWorkingMemory, resetWorkingMemory } from "./workingMemory";
export { getEpisodicMemory } from "./episodicMemory";
export { getSemanticMemory } from "./semanticMemory";
export { getProceduralMemory } from "./proceduralMemory";
export { getAutobiographicalMemory } from "./autobiographicalMemory";
export { getMemoryConsolidator } from "./memoryConsolidator";
export {
  getCognitiveIntegrationBridge,
  resetCognitiveIntegrationBridge,
} from "./integrationBridge";
