// src/self_improvement/SelfImprovementManager.ts
import { EventBus } from "../core/events/EventBus";
import { PerformanceMonitor, RuntimeHealthSnapshot } from "./PerformanceMonitor";
import { PatchGenerator } from "./PatchGenerator";
import { AutoPatcher } from "./AutoPatcher";
import { WebCrawler, Article as CrawledArticle } from "./WebCrawler";
import { KnowledgeIngestor, Article as KnowledgeArticle } from "./KnowledgeIngestor";
import { AutoTrainer } from "./AutoTrainer";

/**
 * Orchestrates the self‑improvement loop.
 *   - Listens to performanceMetrics events.
 *   - When a metric crosses a configurable threshold, asks PatchGenerator for a suggestion.
 *   - Applies the patch via AutoPatcher (respecting config.autoApply).
 *   - Periodically runs the WebCrawler, stores results, and retrains the model.
 */
export class SelfImprovementManager {
  private readonly monitor = PerformanceMonitor.instance;
  private readonly patchGen = new PatchGenerator();
  private readonly applier = new AutoPatcher();
  private readonly crawler = new WebCrawler();
  private readonly ingestor = new KnowledgeIngestor();
  private readonly trainer = new AutoTrainer();

  private readonly cpuThreshold = 80; // percent
  private readonly memoryThresholdMb = 1024; // MB
  private readonly lagThresholdMs = 200; // ms

  constructor() {
    // Subscribe to performance metrics
    EventBus.instance.onEvent("performanceMetrics", (snapshot: RuntimeHealthSnapshot) =>
      this.handleMetrics(snapshot)
    );
  }

  /** Start the continuous loop */
  async start() {
    // Ensure knowledge DB is ready
    await this.ingestor.init();
    // Start periodic crawling / training (daily for demo)
    setInterval(() => this.runCrawlAndTrain(), 24 * 60 * 60 * 1000);
    // Start performance monitoring
    this.monitor.start();
    console.info("SelfImprovementManager started");
  }

  /** Stop monitoring */
  stop() {
    this.monitor.stop();
    // No need to clear the crawl interval for this demo.
  }

  private async handleMetrics(snapshot: RuntimeHealthSnapshot) {
    const { cpuUsagePercent, memoryUsageMb, eventLoopLagMs } = snapshot;
    if (
      cpuUsagePercent > this.cpuThreshold ||
      memoryUsageMb > this.memoryThresholdMb ||
      eventLoopLagMs > this.lagThresholdMs
    ) {
      // For simplicity, target the PerformanceMonitor file itself as a candidate module.
      const modulePath = "d:/project/new_jarvis/Sara/myraa-ai-assistant/src/self_improvement/PerformanceMonitor.ts";
      const suggestion = await this.patchGen.generatePatch(modulePath, snapshot);
      if (suggestion) {
        const applied = this.applier.applyPatch(suggestion.file, suggestion.diff);
        EventBus.instance.emitEvent("patchSuggestion", { suggestion, applied });
      }
    }
  }

  private async runCrawlAndTrain() {
    try {
      const articles: CrawledArticle[] = await this.crawler.crawl();
      for (const art of articles) {
        await this.ingestor.storeArticle(art);
      }
      await this.trainer.train();
      EventBus.instance.emitEvent("knowledgeUpdated", { count: articles.length });
    } catch (e) {
      console.error("SelfImprovementManager crawl/train error", e);
    }
  }
}
