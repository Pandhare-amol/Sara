import { ToolRegistry } from "./toolRegistry";
import { normalizeToolExecutionResult } from "./toolExecutor";

describe("SARA tool contract compatibility", () => {
  it("derives conservative metadata for runtime tools", () => {
    const registry = new ToolRegistry();
    registry.registerRuntimeTools(["readFile", "copyFile", "whatsapp_send", "executePowerAction"]);

    expect(registry.getMetadata("readFile")?.riskLevel).toBe("READ_ONLY");
    expect(registry.getMetadata("copyFile")?.riskLevel).toBe("REVERSIBLE_WRITE");
    expect(registry.getMetadata("whatsapp_send")?.riskLevel).toBe("EXTERNAL_SIDE_EFFECT");
    expect(registry.getMetadata("executePowerAction")?.requiresConfirmation).toBe(true);
    expect(registry.getMetadata("whatsapp_send")?.supportsRetry).toBe(false);
  });

  it("preserves legacy results while adding stable failure fields", () => {
    const result = normalizeToolExecutionResult("readFile", { result: "missing", ok: false, error_code: "FILE_NOT_FOUND" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAILED");
    expect(result.error_code).toBe("FILE_NOT_FOUND");
    expect(result.data).toBeDefined();
    expect(result.tool).toBe("readFile");
  });
});