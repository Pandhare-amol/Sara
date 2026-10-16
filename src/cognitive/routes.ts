/**
 * Cognitive API Routes
 *
 * Exposes cognitive architecture capabilities as HTTP endpoints.
 * Integrates with Express.js backend.
 */

import { Request, Response, Router } from "express";
import {
  getCognitiveOrchestrator,
  getPlanningEngine,
  getStrategyManager,
} from "./index";

const router = Router();
const orchestrator = getCognitiveOrchestrator();

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
router.post("/cognitive/remember", (_req: Request, res: Response) => {
  return res.status(410).json({
    ok: false,
    error: "Legacy cognitive memory writes bypass user review. Use /api/memories with explicit consent.",
  });
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
router.post("/cognitive/memory/consolidate", (_req: Request, res: Response) => {
  return res.status(410).json({
    ok: false,
    error: "Legacy memory consolidation is disabled until proposals can be reviewed individually.",
  });
});

/**
 * The old cognitive executor accepted a plan's arbitrary tool name/arguments
 * without an independent approval or tool-argument policy. Keep the read-only
 * cognitive views, but do not route this legacy entry point to the desktop.
 * Browser work goes through the reviewed, bounded task workflow instead.
 */
router.post("/cognitive/task/execute", (_req: Request, res: Response) => {
  return res.status(410).json({
    ok: false,
    error: "Legacy cognitive execution is disabled. Use /api/workflows/browser/plan for reviewed browser work.",
  });
});

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
