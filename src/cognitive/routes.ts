/**
 * Cognitive API Routes
 *
 * Exposes cognitive architecture capabilities as HTTP endpoints.
 * Integrates with Express.js backend.
 */

import { Request, Response, Router } from "express";
import {
  getCognitiveIntegrationBridge,
  getCognitiveOrchestrator,
  getPlanningEngine,
  getStrategyManager,
  getTaskEvaluator,
} from "./index";
import type { TaskExecutionContext } from "./integrationBridge";
import { callDesktopAgent } from "../../desktop_agent_bridge";
import { runAdvancedReasoningIfNeeded } from "../asi/AdvancedReasoningCoordinator";
import { getDigitalWorldContext } from "./digitalWorldContext";

const router = Router();
const bridge = getCognitiveIntegrationBridge();
const orchestrator = getCognitiveOrchestrator();

router.get("/cognitive/world-context", (_req: Request, res: Response) => {
  res.json({ ok: true, snapshot: getDigitalWorldContext().getSnapshot() });
});

router.post("/cognitive/world-context", (req: Request, res: Response) => {
  const update = req.body?.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return res.status(400).json({ error: "An object-valued 'update' is required." });
  }
  const snapshot = getDigitalWorldContext().update(update, req.body?.observation);
  return res.json({ ok: true, snapshot });
});

router.post("/cognitive/world-context/observations", (req: Request, res: Response) => {
  const { source, kind, summary, details } = req.body || {};
  if (!source || !kind || !summary) {
    return res.status(400).json({ error: "source, kind, and summary are required." });
  }
  const observation = getDigitalWorldContext().recordObservation({ source, kind, summary, details });
  return res.status(201).json({ ok: true, observation, snapshot: getDigitalWorldContext().getSnapshot() });
});
router.post("/cognitive/advanced-reasoning", async (req: Request, res: Response) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "A reasoning question is required." });
    const domains = Array.isArray(req.body?.domains)
      ? req.body.domains.map((domain: unknown) => String(domain).trim()).filter(Boolean).slice(0, 5)
      : ["general"];
    const depthLevel = Math.max(1, Math.min(5, Number(req.body?.depthLevel || 3))) as 1 | 2 | 3 | 4 | 5;
    const result = await runAdvancedReasoningIfNeeded(question, 12_000);
    if (!result) return res.status(503).json({ error: "ASI_REASONING_UNAVAILABLE: the question was not eligible or the reasoning provider is unavailable." });
    res.json({ ok: true, requiresConfirmation: true, result });
  } catch (error: any) {
    res.status(503).json({ error: error?.message || "Advanced reasoning is unavailable." });
  }
});

/**
 * POST /cognitive/plan
 * Create a plan for a goal using memory and reasoning.
 */
router.post("/cognitive/plan", async (req: Request, res: Response) => {
  try {
    const { goal, projectContext, timeConstraint } = req.body;

    if (!goal) {
      return res
        .status(400)
        .json({
          error: "Missing 'goal' parameter",
        });
    }

    const planner = getPlanningEngine();
    const plan = await planner.createPlan(goal, {
      projectContext,
      timeConstraint,
    });

    res.json({
      ok: true,
      plan,
    });
  } catch (error: any) {
    console.error("[CognitiveAPI] /cognitive/plan error:", error);
    res.status(500).json({
      error: error.message || "Failed to create plan",
    });
  }
});

/**
 * POST /cognitive/remember
 * Record a fact, preference, or piece of knowledge.
 */
router.post("/cognitive/remember", async (req: Request, res: Response) => {
  try {
    const { category, content, type } = req.body;

    if (!category || !content || !type) {
      return res.status(400).json({
        error:
          "Missing required parameters: category, content, type",
      });
    }

    const memory = orchestrator.rememberFact(
      category,
      content,
      type as any
    );

    res.json({
      ok: true,
      memory,
    });
  } catch (error: any) {
    console.error("[CognitiveAPI] /cognitive/remember error:", error);
    res.status(500).json({
      error:
        error.message ||
        "Failed to record memory",
    });
  }
});

/**
 * GET /cognitive/memory/stats
 * Get comprehensive memory statistics.
 */
router.get(
  "/cognitive/memory/stats",
  async (req: Request, res: Response) => {
    try {
      const stats = orchestrator.getMemoryStats();

      res.json({
        ok: true,
        stats,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/memory/stats error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get memory stats",
      });
    }
  }
);

/**
 * GET /cognitive/preferences
 * Get learned user preferences.
 */
router.get(
  "/cognitive/preferences",
  async (req: Request, res: Response) => {
    try {
      const prefs = orchestrator.getUserPreferences();

      res.json({
        ok: true,
        preferences: prefs,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/preferences error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get preferences",
      });
    }
  }
);

/**
 * GET /cognitive/strategies
 * Get strategy statistics.
 */
router.get(
  "/cognitive/strategies",
  async (req: Request, res: Response) => {
    try {
      const manager = getStrategyManager();
      const stats = manager.getStatistics();
      const strategies = manager.list(10);

      res.json({
        ok: true,
        stats,
        strategies,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/strategies error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get strategies",
      });
    }
  }
);

/**
 * GET /cognitive/project/:project
 * Get context for a specific project.
 */
router.get(
  "/cognitive/project/:project",
  async (req: Request, res: Response) => {
    try {
      const { project } = req.params;
      const context =
        orchestrator.getProjectContext(project);

      res.json({
        ok: true,
        project,
        context,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/project/:project error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get project context",
      });
    }
  }
);

/**
 * POST /cognitive/memory/consolidate
 * Manually trigger memory consolidation (learning pass).
 */
router.post(
  "/cognitive/memory/consolidate",
  async (req: Request, res: Response) => {
    try {
      const report = await orchestrator.consolidateMemories();

      res.json({
        ok: true,
        report,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/memory/consolidate error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to consolidate memories",
      });
    }
  }
);

/**
 * POST /cognitive/task/execute
 * Execute a task with full cognitive flow:
 * context → plan → execute → evaluate → learn
 */
router.post(
  "/cognitive/task/execute",
  async (req: Request, res: Response) => {
    try {
      const {
        taskId,
        conversationId,
        goal,
        userInput,
        projectContext,
        maxDuration,
      } = req.body;

      if (!goal || !userInput) {
        return res.status(400).json({
          error:
            "Missing required parameters: goal, userInput",
        });
      }

      // Execute task using desktop agent with real tool calls
      const executionResult = await bridge.executeTaskWithCognition(
        {
          taskId: taskId || `task-${Date.now()}`,
          conversationId,
          goal,
          userInput,
          projectContext,
          maxDuration,
          startTime: Date.now(),
        },
        async (plan, context) => {
          const actions = [];
          const errors = [];
          const corrections = [];

          // Execute each plan step using the desktop agent
          for (const step of plan.steps) {
            try {
              // Use the tool from the plan step, or fallback to the action name
              const toolName = step.tool || step.action;
              const toolArgs = step.args || {};

              console.debug(`[CognitiveRoutes] Executing tool: ${toolName}`, toolArgs);

              // Call the desktop agent with the tool and arguments
              const agentResult = await callDesktopAgent(toolName, toolArgs);

              // Record the action
              actions.push({
                id: step.id,
                index: step.index,
                tool: toolName,
                args: toolArgs,
                success: agentResult.ok,
                output: agentResult.result || agentResult.error || "No output",
                duration: 0, // Desktop agent doesn't report timing
              });

              // If tool failed, record as error
              if (!agentResult.ok) {
                errors.push({
                  id: `error-${step.id}`,
                  stepId: step.id,
                  message: agentResult.error || "Unknown error",
                  tool: toolName,
                  args: toolArgs,
                });
              }
            } catch (error: any) {
              console.error(`[CognitiveRoutes] Tool execution failed: ${step.tool}`, error);

              // Record the action as failed
              actions.push({
                id: step.id,
                index: step.index,
                tool: step.tool || step.action,
                args: step.args || {},
                success: false,
                output: error.message || "Tool execution failed",
                duration: 0,
              });

              // Record the error
              errors.push({
                id: `error-${step.id}`,
                stepId: step.id,
                message: error.message || "Unknown error",
                tool: step.tool || step.action,
                args: step.args || {},
              });
            }
          }

          // Determine overall success from the actual execution outcome rather
          // than from the tool intent or a generated sentence.
          const allSucceeded = actions.length > 0 && actions.every((a) => a.success);
          const overallSuccess = allSucceeded && errors.length === 0;

          return {
            actions,
            errors,
            corrections,
            result: overallSuccess
              ? (executionResult?.output || "Task completed successfully")
              : (errors.length > 0
                ? `Task failed: ${errors.map((e) => e.message || "Unknown error").join("; ")}`
                : (executionResult?.output || "Task did not complete successfully")),
          };
        }
      );

      res.json({
        ok: true,
        result: executionResult,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/task/execute error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to execute task",
      });
    }
  }
);

/**
 * GET /cognitive/work-summary
 * Get summary of recent work.
 */
router.get(
  "/cognitive/work-summary",
  async (req: Request, res: Response) => {
    try {
      const days = parseInt(
        (req.query.days as string) || "1",
        10
      );
      const summary =
        orchestrator.getWorkSummary(days);

      res.json({
        ok: true,
        days,
        summary,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/work-summary error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get work summary",
      });
    }
  }
);

/**
 * GET /cognitive/contradictions
 * Find conflicting knowledge in semantic memory.
 */
router.get(
  "/cognitive/contradictions",
  async (req: Request, res: Response) => {
    try {
      const contradictions =
        orchestrator.getKnowledgeContradictions();

      res.json({
        ok: true,
        contradictions,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/contradictions error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get contradictions",
      });
    }
  }
);

/**
 * GET /cognitive/active-projects
 * Get currently active projects.
 */
router.get(
  "/cognitive/active-projects",
  async (req: Request, res: Response) => {
    try {
      const projects =
        orchestrator.getActiveProjects();

      res.json({
        ok: true,
        projects,
      });
    } catch (error: any) {
      console.error(
        "[CognitiveAPI] /cognitive/active-projects error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Failed to get active projects",
      });
    }
  }
);

export default router;
