import { InternetCrawlerService } from "../self_improvement/InternetCrawlerService";
import { CognitiveSuperiorityEngine } from "./CognitiveSuperiorityEngine";
import { InnovationTarget, InnovationReport } from "./types";
import { getEpisodicMemory } from "../cognitive/episodicMemory";

export class AutonomousInnovationEngine {
  private crawler: InternetCrawlerService;
  private cognitiveEngine: CognitiveSuperiorityEngine;
  private targets: InnovationTarget[] = [];
  private reports: InnovationReport[] = [];
  private crawlLimitPerHour: number = 5;
  private crawlsThisHour: number = 0;
  private lastCrawlReset: number = Date.now();

  constructor(crawler: InternetCrawlerService, cognitiveEngine: CognitiveSuperiorityEngine) {
    this.crawler = crawler;
    this.cognitiveEngine = cognitiveEngine;
    
    // Seed some targets
    this.targets.push({
      id: `target-seed-1`,
      title: "Improve battery energy density",
      description: "Find novel ways to increase Li-ion or solid-state battery energy density using cross-domain insights.",
      domains: ["materials science", "chemistry", "nanotechnology"],
      status: 'active',
      createdAt: Date.now()
    });
  }

  addTarget(target: Omit<InnovationTarget, 'id' | 'createdAt' | 'status'>) {
    this.targets.push({
      ...target,
      id: `target-${Date.now()}`,
      status: 'active',
      createdAt: Date.now()
    });
  }

  async runInnovationCycle() {
    if (Date.now() - this.lastCrawlReset > 3600000) {
      this.crawlsThisHour = 0;
      this.lastCrawlReset = Date.now();
    }

    const activeTargets = this.targets.filter(t => t.status === 'active');
    for (const target of activeTargets) {
      if (this.crawlsThisHour >= this.crawlLimitPerHour) {
        console.log("AutonomousInnovationEngine: Crawl limit reached for this hour.");
        break;
      }

      try {
        // 1. Crawl for new information
        const abstracts = await InternetCrawlerService.searchArxiv(target.title);
        this.crawlsThisHour++;

        const abstractText = abstracts.length > 0 ? abstracts.join("\n") : "No recent abstracts found.";

        // 2. Synthesize using CognitiveSuperiorityEngine
        const query = {
          question: `Given this recent research abstract: "${abstractText}", synthesize a novel hypothesis for solving: ${target.description}`,
          domains: target.domains,
          depthLevel: 4 as 4,
          allowWebSearch: false
        };

        const asiResponse = await this.cognitiveEngine.processQuery(query);

        // 3. Create innovation report
        const report: InnovationReport = {
          id: `report-${Date.now()}`,
          targetId: target.id,
          hypothesis: asiResponse.answer,
          findings: asiResponse.novelInsights,
          score: asiResponse.confidence,
          generatedAt: Date.now()
        };

        this.reports.push(report);

        // 4. Record to episodic memory
        const memory = getEpisodicMemory();
        memory.record({
          title: `Innovation Report generated for ${target.title}`,
          context: {
            goal: 'Autonomous Innovation',
            environment: 'AutonomousInnovationEngine',
            initialState: target
          },
          plan: { steps: [] },
          execution: { actions: [], observations: [] },
          outcome: {
            success: true,
            goalAchieved: true,
            completionTime: asiResponse.processingTimeMs,
            userIntervention: false
          },
          lesson: {
            keyInsights: [report.hypothesis, ...report.findings]
          },
          metadata: {
            importance: 0.8,
            confidence: report.score
          }
        });

      } catch (e) {
        console.error(`AutonomousInnovationEngine: Failed to run cycle for target ${target.title}`, e);
      }
    }
  }

  getReports(): InnovationReport[] {
    return this.reports;
  }
  
  getTargets(): InnovationTarget[] {
    return this.targets;
  }
}
