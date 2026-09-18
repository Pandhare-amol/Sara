import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ToolRouter } from "../tools/toolRouter";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { callDesktopAgent } from "../../../desktop_agent_bridge";
import { updateTask, saveTaskCheckpoint } from "../../../server_state";
import { getExecutionOrchestrator } from "../tools/initialization";

export interface GraphState {
  taskId: string;
  goal: string;
  plan: any[];
  currentStepIndex: number;
  results: any[];
  status: "planning" | "executing" | "verifying" | "replanning" | "completed" | "failed" | "awaiting_approval";
  error?: string;
  consecutiveFailures: number;
}

export class AgentGraph {
  private ai: GoogleGenAI;
  private graph: any;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || 'MY_GEMINI_API_KEY';
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'sara-langgraph' } } });
    this.graph = this.buildGraph();
  }

  private buildGraph() {
    const builder: any = new StateGraph<GraphState>({
      channels: {
        taskId: null as any,
        goal: null as any,
        plan: null as any,
        currentStepIndex: null as any,
        results: null as any,
        status: null as any,
        error: null as any,
        consecutiveFailures: null as any,
      }
    });

    builder.addNode("plan", this.planNode.bind(this));
    builder.addNode("execute", this.executeNode.bind(this));
    builder.addNode("verify", this.verifyNode.bind(this));
    builder.addNode("replan", this.replanNode.bind(this));

    builder.addEdge(START, "plan");
    
    // Routing logic
    builder.addConditionalEdges("plan", (state: GraphState) => {
      if (state.status === "failed") return END;
      if (state.plan.length === 0) return "completed";
      return "execute";
    }, {
      "execute": "execute",
      "completed": END,
      "failed": END
    });

    builder.addConditionalEdges("execute", (state: GraphState) => {
      if (state.status === "awaiting_approval") return END; // pause
      if (state.status === "failed") return "replan";
      return "verify";
    }, {
      "verify": "verify",
      "replan": "replan",
      "awaiting_approval": END
    });

    builder.addConditionalEdges("verify", (state: GraphState) => {
      if (state.status === "failed") return "replan";
      if (state.currentStepIndex >= state.plan.length) return "completed";
      return "execute"; // next step
    }, {
      "execute": "execute",
      "replan": "replan",
      "completed": END
    });

    builder.addConditionalEdges("replan", (state: GraphState) => {
      if (state.status === "failed") return END;
      return "execute"; // retry or continue
    }, {
      "execute": "execute",
      "failed": END
    });

    const memory = new MemorySaver();
    return builder.compile({ checkpointer: memory });
  }

  private async planNode(state: GraphState): Promise<Partial<GraphState>> {
    console.log(`[LangGraph] Planning for: ${state.goal}`);
    if (state.plan && state.plan.length > 0) return { status: "executing" };

    try {
      const prompt = `You are a LangGraph Orchestrator for SARA. Break down the user's goal into a JSON array of specific tool calls.
Available generic tools: 'os.shell', 'browser.navigate', 'browser.click', 'browser.type', 'mouse.click', 'keyboard.type', 'system.search'.
User Goal: ${state.goal}

Respond with a JSON array of objects. Each object must have: 'tool' (string) and 'args' (object).`;

      const schema: Schema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            tool: { type: Type.STRING },
            args: { type: Type.OBJECT }
          },
          required: ['tool', 'args']
        }
      };

      const response = await this.ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      });

      const plan = JSON.parse(response.text?.trim() || "[]");
      return { plan, status: "executing", currentStepIndex: 0, results: [], consecutiveFailures: 0 };
    } catch (e: any) {
      return { status: "failed", error: "Planning failed: " + e.message };
    }
  }

  private async executeNode(state: GraphState): Promise<Partial<GraphState>> {
    console.log(`[LangGraph] Executing step ${state.currentStepIndex}`);
    const step = state.plan[state.currentStepIndex];
    if (!step) return { status: "completed" };

    try {
      // Use the actual execution orchestrator for Phase 1 shared contracts!
      const orchestrator = getExecutionOrchestrator();
      const res = await orchestrator.executeWithVerification(step.tool, step.args);

      if (res.executionError?.code === "ISOLATION_CONFIRMATION_REQUIRED") {
        return { status: "awaiting_approval" };
      }

      const newResults = [...(state.results || []), { step, result: res }];
      if (!res.success) {
        return {
          status: "failed",
          results: newResults,
          consecutiveFailures: (state.consecutiveFailures || 0) + 1,
          error: res.executionError?.message || res.message,
        };
      }

      return { status: "verifying", results: newResults, consecutiveFailures: 0 };
    } catch (e: any) {
      return { status: "failed", error: e.message, consecutiveFailures: (state.consecutiveFailures || 0) + 1 };
    }
  }

  private async verifyNode(state: GraphState): Promise<Partial<GraphState>> {
    console.log(`[LangGraph] Verifying step ${state.currentStepIndex}`);
    // The execution orchestrator already handles verification.
    // If we reach here, it implies the step passed.
    return { status: "executing", currentStepIndex: (state.currentStepIndex || 0) + 1 };
  }

  private async replanNode(state: GraphState): Promise<Partial<GraphState>> {
    console.log(`[LangGraph] Replanning after failure...`);
    if ((state.consecutiveFailures || 0) >= 3) {
      return { status: "failed", error: "Too many consecutive failures. Aborting." };
    }
    // simple replan: retry the same step for now
    return { status: "executing", error: undefined };
  }

  public async run(taskId: string, goal: string) {
    const config = { configurable: { thread_id: taskId } };
    const initialState: GraphState = {
      taskId,
      goal,
      plan: [],
      currentStepIndex: 0,
      results: [],
      status: "planning",
      consecutiveFailures: 0
    };

    const stream = await this.graph.stream(initialState, config);
    let finalState = initialState;

    for await (const chunk of stream) {
      const nodeName = Object.keys(chunk)[0];
      const updates = chunk[nodeName];
      finalState = { ...finalState, ...updates };
      
      // Update SQLite DB as the graph progresses
      await updateTask(taskId, {
        status: finalState.status === "failed" ? "failed" : finalState.status === "completed" ? "completed" : "running",
        error: finalState.error
      });
      await saveTaskCheckpoint(taskId, {
        task_progress: finalState.currentStepIndex,
        completed_steps: finalState.results,
        current_goal: goal,
        state_dump: finalState
      });
    }

    return finalState;
  }
}
