import { callDesktopAgent } from "../../../desktop_agent_bridge";
import { ToolRouter } from "./toolRouter";

export function registerMouseTools(router: ToolRouter) {
  router.registry.register({
    name: "mouse.move",
    owner: "node",
    category: "MOUSE",
    metadata: {
      description: "Move the mouse cursor to absolute coordinates x, y.",
      riskLevel: "REVERSIBLE_WRITE",
      supportsRetry: true,
    }
  });

  router.registry.register({
    name: "mouse.moveRelative",
    owner: "node",
    category: "MOUSE",
    metadata: {
      description: "Move the mouse cursor relative to its current position by xOffset, yOffset.",
      riskLevel: "REVERSIBLE_WRITE",
      supportsRetry: true,
    }
  });

  router.registry.register({
    name: "mouse.click",
    owner: "node",
    category: "MOUSE",
    metadata: {
      description: "Click the mouse at the current position. Specify 'left', 'right', or 'middle'.",
      riskLevel: "REVERSIBLE_WRITE",
      supportsRetry: true,
    }
  });

  router.registry.register({
    name: "mouse.drag",
    owner: "node",
    category: "MOUSE",
    metadata: {
      description: "Drag the mouse cursor to absolute coordinates.",
      riskLevel: "REVERSIBLE_WRITE",
      supportsRetry: true,
    }
  });

  router.registry.register({
    name: "mouse.position",
    owner: "node",
    category: "MOUSE",
    metadata: {
      description: "Get the current absolute position (x, y) of the mouse cursor.",
      riskLevel: "READ_ONLY",
      supportsRetry: true,
    }
  });
}

export async function executeMouseTool(tool: string, args: Record<string, any>): Promise<{ok: boolean, result?: any, error?: string}> {
  try {
    switch (tool) {
      case "mouse.move":
        return await callDesktopAgent("mouseMove", args);
      case "mouse.moveRelative":
        return await callDesktopAgent("mouseMoveRelative", { dx: args.xOffset, dy: args.yOffset, duration: args.duration });
      case "mouse.click":
        return await callDesktopAgent("mouseClick", args);
      case "mouse.drag":
        return await callDesktopAgent("mouseDrag", args);
      case "mouse.position":
        return await callDesktopAgent("mousePosition", {});
      default:
        return { ok: false, error: "Unknown mouse tool" };
    }
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}
