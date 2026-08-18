/**
 * Cognitive API Integration Tests
 *
 * Tests for all cognitive endpoints showing proper usage and expected responses.
 * Can be run with: npm test -- cognitive.integration.test.ts
 */

describe("Cognitive API Integration Tests", () => {
  const BASE_URL = "http://localhost:3000";

  describe("POST /cognitive/plan", () => {
    it("should create a plan for a simple goal", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "Create a TypeScript project",
          projectContext: "SARA Cognitive Module",
          timeConstraint: 300000, // 5 minutes
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan.id).toBeDefined();
      expect(result.plan.goal).toBe("Create a TypeScript project");
      expect(result.plan.steps).toBeDefined();
      expect(Array.isArray(result.plan.steps)).toBe(true);
      expect(result.plan.confidence).toBeGreaterThanOrEqual(0);
      expect(result.plan.confidence).toBeLessThanOrEqual(1);
      expect(result.plan.estimatedDuration).toBeDefined();
      expect(result.plan.reasoning).toBeDefined();
    });

    it("should handle missing goal parameter", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectContext: "Test" }),
      });

      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/goal/i);
    });

    it("should create plan with skill-based strategy if applicable", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "Open Visual Studio Code",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.plan.reasoning.whyChosen).toBeDefined();
    });
  });

  describe("POST /cognitive/remember", () => {
    it("should remember a fact", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "general",
          content: "SARA is a cognitive AI assistant",
          type: "fact",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.memory).toBeDefined();
      expect(result.memory.id).toBeDefined();
      expect(result.memory.type).toBe("fact");
      expect(result.memory.content).toBe("SARA is a cognitive AI assistant");
    });

    it("should remember a preference", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "user",
          content: "User prefers dark mode",
          type: "preference",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.memory.type).toBe("preference");
    });

    it("should handle missing parameters", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "test" }),
      });

      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.error).toBeDefined();
    });
  });

  describe("GET /cognitive/memory/stats", () => {
    it("should return memory statistics", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/memory/stats`);

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.stats.episodic).toBeDefined();
      expect(result.stats.semantic).toBeDefined();
      expect(result.stats.procedural).toBeDefined();
      expect(result.stats.autobiographical).toBeDefined();

      // Verify structure
      expect(result.stats.episodic.count).toBeGreaterThanOrEqual(0);
      expect(result.stats.semantic.count).toBeGreaterThanOrEqual(0);
      expect(result.stats.procedural.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe("GET /cognitive/preferences", () => {
    it("should return learned preferences", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/preferences`);

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.preferences).toBeDefined();
      expect(Array.isArray(result.preferences)).toBe(true);
    });
  });

  describe("GET /cognitive/strategies", () => {
    it("should return strategy statistics", async () => {
      const response = await fetch(`${BASE_URL}/cognitive/strategies`);

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.strategies).toBeDefined();
      expect(Array.isArray(result.strategies)).toBe(true);
    });
  });

  describe("GET /cognitive/project/:project", () => {
    it("should return project context", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/project/SARA`
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.project).toBe("SARA");
      expect(result.context).toBeDefined();
    });
  });

  describe("POST /cognitive/memory/consolidate", () => {
    it("should trigger memory consolidation", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/memory/consolidate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.report).toBeDefined();
      expect(result.report.skillsGenerated).toBeDefined();
      expect(result.report.preferencesExtracted).toBeDefined();
    });
  });

  describe("GET /cognitive/work-summary", () => {
    it("should return work summary for last day", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/work-summary?days=1`
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.days).toBe(1);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe("string");
    });

    it("should support custom day range", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/work-summary?days=7`
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.days).toBe(7);
    });
  });

  describe("GET /cognitive/contradictions", () => {
    it("should return knowledge contradictions", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/contradictions`
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.contradictions).toBeDefined();
      expect(Array.isArray(result.contradictions)).toBe(true);
    });
  });

  describe("GET /cognitive/active-projects", () => {
    it("should return active projects", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/active-projects`
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.projects).toBeDefined();
      expect(Array.isArray(result.projects)).toBe(true);
    });
  });

  describe("POST /cognitive/task/execute", () => {
    it("should execute task with full cognitive flow", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/task/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: "test-task-001",
            goal: "Create a test file",
            userInput: "Create a new test file with default content",
            projectContext: "Testing",
          }),
        }
      );

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.result.taskId).toBe("test-task-001");
      expect(result.result.success).toBeDefined();
      expect(result.result.goalAchieved).toBeDefined();
      expect(result.result.plan).toBeDefined();
      expect(result.result.evaluation).toBeDefined();
      expect(result.result.episode).toBeDefined();
      expect(result.result.reward).toBeDefined();
      expect(result.result.durationMs).toBeGreaterThan(0);
    });

    it("should handle missing required parameters", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/task/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: "test-002",
            // Missing: goal and userInput
          }),
        }
      );

      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.error).toBeDefined();
    });

    it("should generate evaluation and learning signals", async () => {
      const response = await fetch(
        `${BASE_URL}/cognitive/task/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: `test-${Date.now()}`,
            goal: "Test goal",
            userInput: "Test input",
          }),
        }
      );

      const result = await response.json();
      const { result: execution } = result;

      expect(execution.evaluation).toBeDefined();
      expect(execution.evaluation.metrics).toBeDefined();
      expect(execution.evaluation.reasoning).toBeDefined();
      expect(execution.evaluation.reward).toBeDefined();
      expect(execution.evaluation.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Error Handling", () => {
    it("should return appropriate 5xx errors for server failures", async () => {
      // Test with invalid request that might cause server error
      const response = await fetch(`${BASE_URL}/cognitive/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect([400, 500]).toContain(response.status);
    });
  });

  describe("API Response Format", () => {
    it("should consistently use ok/error format", async () => {
      // Test success response
      const successResponse = await fetch(`${BASE_URL}/cognitive/memory/stats`);
      const successData = await successResponse.json();

      expect(successData).toHaveProperty("ok");
      expect(successData).toHaveProperty("stats");

      // Test error response
      const errorResponse = await fetch(`${BASE_URL}/cognitive/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const errorData = await errorResponse.json();

      expect(errorData).toHaveProperty("error");
    });
  });
});

/**
 * Manual Testing Guide
 *
 * Start the server:
 *   npm run dev
 *
 * Test individual endpoints:
 *
 *   # Create a plan
 *   curl -X POST http://localhost:3000/cognitive/plan \
 *     -H "Content-Type: application/json" \
 *     -d '{"goal":"Create a file","projectContext":"test"}'
 *
 *   # Remember a fact
 *   curl -X POST http://localhost:3000/cognitive/remember \
 *     -H "Content-Type: application/json" \
 *     -d '{"category":"general","content":"SARA is AI","type":"fact"}'
 *
 *   # Get memory stats
 *   curl http://localhost:3000/cognitive/memory/stats
 *
 *   # Get preferences
 *   curl http://localhost:3000/cognitive/preferences
 *
 *   # Execute task with full workflow
 *   curl -X POST http://localhost:3000/cognitive/task/execute \
 *     -H "Content-Type: application/json" \
 *     -d '{"goal":"Test task","userInput":"Do something"}'
 *
 *   # Get work summary
 *   curl "http://localhost:3000/cognitive/work-summary?days=1"
 *
 *   # Trigger consolidation
 *   curl -X POST http://localhost:3000/cognitive/memory/consolidate
 */
