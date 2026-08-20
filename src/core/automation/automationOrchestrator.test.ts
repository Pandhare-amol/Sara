import { AutomationOrchestrator } from "./automationOrchestrator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AutomationOrchestrator", () => {
  it("submits without waiting for the executor", () => {
    const gate = deferred<string>();
    const orchestrator = new AutomationOrchestrator(async () => gate.promise);
    const task = orchestrator.submit({ tool: "youtube_play", args: { query: "Python lectures" } });

    expect(task.status).toBe("QUEUED");
    expect(orchestrator.getTask(task.task_id)?.status).toBe("QUEUED");
    gate.resolve("playing");
  });

  it("serializes browser tasks while allowing independent work to start", async () => {
    const first = deferred<string>();
    const calls: string[] = [];
    const orchestrator = new AutomationOrchestrator(async (tool) => {
      calls.push(tool);
      if (tool === "youtube_play") return first.promise;
      return "weather";
    });

    const video = orchestrator.submit({ tool: "youtube_play", args: {} });
    orchestrator.submit({ tool: "systemInfo", args: {}, priority: "HIGH" });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["youtube_play", "systemInfo"]);
    first.resolve("done");
    await Promise.resolve();
    expect(orchestrator.getTask(video.task_id)?.status).toBe("COMPLETED");
  });

  it("cancels queued tasks before execution", async () => {
    const gate = deferred<string>();
    const calls: string[] = [];
    const orchestrator = new AutomationOrchestrator(async () => {
      calls.push("running");
      return gate.promise;
    });
    const running = orchestrator.submit({ tool: "youtube_play", args: {} });
    const queued = orchestrator.submit({ tool: "youtube_pause", args: {} });
    await Promise.resolve();

    expect(orchestrator.cancelTask(queued.task_id)).toBe(true);
    expect(orchestrator.getTask(queued.task_id)?.status).toBe("CANCELLED");
    expect(calls.length).toBe(1);
    gate.resolve("done");
    await Promise.resolve();
    expect(orchestrator.getTask(running.task_id)?.status).toBe("COMPLETED");
  });
});