import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataFile } from "../server_paths";
import { runAgentEvaluation, type EvaluationCase, type EvaluationCategory, type EvaluationSplit } from "../src/core/evaluation/agentEvaluation";
import { retrieveApprovedMemories } from "../src/core/memory/approvedMemory";
import { BrowserWorkflowEngine, browserPostconditionObserved, validateBrowserPlan } from "../src/core/workflows/browserWorkflow";
import { ToolRegistry } from "../src/core/tools/toolRegistry";
import { ToolPolicyEngine } from "../src/core/tools/policyEngine";
import type { TaskRecord } from "../server_state";
import type { StoredMemory } from "../server_memory";

interface Fixture {
  id: string; category: EvaluationCategory; kind: "plan" | "approval" | "memory" | "verification" | "recovery";
  startUrl?: string; plan?: unknown; expectedAllowed?: boolean;
  toolArgs?: Record<string, unknown>; expectedDecision?: string;
  query?: string; memories?: Array<Partial<StoredMemory> & { id: string; text: string; category: string }>;
  expectedIds?: string[]; observation?: { ok: boolean; verified?: boolean; url?: string }; expectedVerified?: boolean;
  expectedUncertain?: boolean;
}

const base = path.dirname(fileURLToPath(import.meta.url));
const fixtures: Array<Fixture & { split: EvaluationSplit }> = [];
for (const [filename, split] of [
  ["agent-evaluation.development.json", "development"],
  ["agent-evaluation.holdout.json", "local-holdout"],
] as const) {
  const file = path.join(base, "..", "tests", "fixtures", filename);
  const data = JSON.parse(await fs.readFile(file, "utf8")) as Fixture[];
  fixtures.push(...data.map((item) => ({ ...item, split })));
}

async function recoveryFixture(): Promise<boolean> {
  const tasks: TaskRecord[] = [];
  const store = {
    async createTask(input: { conversationId: string; description: string; status: "paused"; assignedAgent: string; metadata: Record<string, unknown> }): Promise<TaskRecord> {
      const now = new Date().toISOString();
      const task: TaskRecord = { ...input, taskId: "test-fixture-task", priority: 5, createdAt: now, updatedAt: now, retryCount: 0 };
      tasks.push(task);
      return task;
    },
    async loadTasks() { return tasks.map((task) => structuredClone(task)); },
    async updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null> {
      const target = tasks.find((task) => task.taskId === id);
      if (!target) return null;
      Object.assign(target, structuredClone(patch));
      return structuredClone(target);
    },
  };
  let toolCalls = 0;
  const engine = new BrowserWorkflowEngine(store, async (_, url) => ({ steps: [{ action: "navigate", url }] }), async () => { toolCalls++; return { ok: true }; });
  const task = await engine.prepare("Inspect a public page", "https://example.com/start");
  await store.updateTask(task.taskId, { status: "running", checkpoint: { currentIndex: 0, inFlightIndex: 0, completed: [] } });
  await engine.recover();
  const recovered = await engine.get(task.taskId);
  let refused = false;
  try { await engine.start(task.taskId); } catch { refused = true; }
  return recovered.status === "paused" && recovered.checkpoint?.uncertainStepIndex === 0 && refused && toolCalls === 0;
}

function evaluateFixture(fixture: Fixture): boolean | Promise<boolean> {
  switch (fixture.kind) {
    case "plan": {
      let allowed = false;
      try { validateBrowserPlan(fixture.plan, fixture.startUrl || ""); allowed = true; } catch { /* policy rejection */ }
      return allowed === fixture.expectedAllowed;
    }
    case "approval": {
      const registry = new ToolRegistry();
      registry.register({ name: "browserWorkflowWrite", owner: "desktop-agent",
        metadata: { riskLevel: "EXTERNAL_SIDE_EFFECT", requiresConfirmation: true } });
      return new ToolPolicyEngine().evaluate("browserWorkflowWrite", fixture.toolArgs || {}, registry).decision === fixture.expectedDecision;
    }
    case "memory": {
      const now = new Date().toISOString();
      const records = (fixture.memories || []).map((item) => ({ ...item, createdAt: now, updatedAt: now })) as StoredMemory[];
      const actual = retrieveApprovedMemories(records, fixture.query || "").map((memory) => memory.id);
      return JSON.stringify(actual) === JSON.stringify(fixture.expectedIds);
    }
    case "verification": return browserPostconditionObserved(fixture.observation || { ok: false }, "example.com") === fixture.expectedVerified;
    case "recovery": return recoveryFixture().then((uncertain) => uncertain === fixture.expectedUncertain);
  }
}

const cases: EvaluationCase[] = fixtures.map((fixture) => ({
  id: fixture.id, split: fixture.split, category: fixture.category, run: () => evaluateFixture(fixture),
}));
const report = await runAgentEvaluation(cases);
const file = dataFile("evaluation/agent-evaluation.json");
await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = `${file}.${process.pid}.tmp`;
try {
  await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
} finally { await fs.rm(temporary, { force: true }); }
console.log(`Deterministic agent fixtures: ${report.summary.passed}/${report.summary.total} passed (development ${report.summary.bySplit.development.passed}/${report.summary.bySplit.development.total}; local holdout ${report.summary.bySplit["local-holdout"].passed}/${report.summary.bySplit["local-holdout"].total}).`);
console.log(`95% Wilson interval for this SMALL fixture set: ${report.summary.passRateWilson95.map((value) => value.toFixed(3)).join("–")}. Not a live-model or real-desktop success rate.`);
console.log(`Report: ${file}`);
if (report.summary.passed !== report.summary.total) process.exitCode = 1;
