import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { ASICore } from '../src/asi/ASICore';
import { MemoryService } from '../src/services/MemoryService';
import { InternetCrawlerService } from '../src/self_improvement/InternetCrawlerService';
import { SelfImprovementManager } from '../src/self_improvement/SelfImprovementManager';
import { AutonomousInnovationEngine } from '../src/asi/AutonomousInnovationEngine';
import { CognitiveSuperiorityEngine } from '../src/asi/CognitiveSuperiorityEngine';

describe('ASI Layer Components', () => {

  it('AutonomousInnovationEngine should respect rate limits', async () => {
    const mockMemoryService = {
      addMemory: mock.fn(),
      getMemory: mock.fn(),
      searchMemories: mock.fn()
    } as unknown as MemoryService;
    
    const mockCrawler = {
      searchArxiv: mock.fn(async () => {
        return [{ summary: "Test abstract" }];
      })
    } as unknown as InternetCrawlerService;

    const mockCognitiveEngine = {
      processQuery: mock.fn(async () => {
        return {
          answer: "Hypothesis",
          confidence: 0.9,
          novelInsights: ["Insight"],
          processingTimeMs: 100
        };
      })
    } as unknown as CognitiveSuperiorityEngine;

    const engine = new AutonomousInnovationEngine(mockCrawler, mockCognitiveEngine);
    
    // Add multiple targets to trigger rate limit (limit is 5/hour)
    for (let i = 0; i < 7; i++) {
      engine.addTarget({
        title: `Target ${i}`,
        description: "Test",
        domains: ["science"]
      });
    }

    await engine.runInnovationCycle();

    // Verify it only crawled 5 times (due to the 5 limit)
    assert.strictEqual(mockCrawler.searchArxiv.mock.calls.length, 5);
  });

  it('ASICore initializes all engines correctly', () => {
    const mockMemoryService = {} as MemoryService;
    const mockCrawler = {} as InternetCrawlerService;
    const mockSim = {} as SelfImprovementManager;
    
    const core = new ASICore(mockMemoryService, mockCrawler, mockSim, 'fake-api-key');
    assert.ok(core.cognitiveEngine);
    assert.ok(core.selfImprovementLoop);
    assert.ok(core.innovationEngine);
    assert.ok(core.emotionalEngine);
  });
});
