import { CognitiveSuperiorityEngine } from "./CognitiveSuperiorityEngine";
import { ModelIntegrationService } from "../services/ModelIntegrationService";
import { RecursiveSelfImprovementLoop } from "./RecursiveSelfImprovementLoop";
import { AutonomousInnovationEngine } from "./AutonomousInnovationEngine";
import { EmotionalUnderstandingEngine } from "./EmotionalUnderstandingEngine";
import { MemoryService } from "../services/MemoryService";
import { InternetCrawlerService } from "../self_improvement/InternetCrawlerService";
import { SelfImprovementManager } from "../self_improvement/SelfImprovementManager";
import { ASIQuery, ASIResponse, InnovationReport } from "./types";

export class ASICore {
  public cognitiveEngine: CognitiveSuperiorityEngine;
  public selfImprovementLoop: RecursiveSelfImprovementLoop;
  public innovationEngine: AutonomousInnovationEngine;
  public emotionalEngine: EmotionalUnderstandingEngine;
  public modelIntegrationService: ModelIntegrationService;

  constructor(
    memoryService: MemoryService,
    crawlerService: InternetCrawlerService,
    selfImprovementManager: SelfImprovementManager,
    apiKey: string
  ) {
    this.cognitiveEngine = new CognitiveSuperiorityEngine(memoryService);
    this.emotionalEngine = new EmotionalUnderstandingEngine(memoryService);
    this.selfImprovementLoop = new RecursiveSelfImprovementLoop(selfImprovementManager, apiKey);
    this.innovationEngine = new AutonomousInnovationEngine(crawlerService, this.cognitiveEngine);
    this.modelIntegrationService = ModelIntegrationService.getInstance();
  }

  async ask(query: ASIQuery): Promise<ASIResponse> {
    return await this.cognitiveEngine.processQuery(query);
  }

  /**
   * Run an advanced‑reasoning prompt using Gemini 1.5 Pro.
   */
  async runAdvancedReasoning(prompt: string): Promise<string> {
    return await this.modelIntegrationService.runAdvancedReasoning(prompt);
  }

  getInnovationStatus(): InnovationReport[] {
    return this.innovationEngine.getReports();
  }

  start() {
    this.selfImprovementLoop.start();
    // Run an initial cycle and then schedule periodic ones
    this.innovationEngine.runInnovationCycle();
    setInterval(() => this.innovationEngine.runInnovationCycle(), 3600000);
  }

  stop() {
    this.selfImprovementLoop.stop();
  }
}
