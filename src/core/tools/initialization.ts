/**
 * Tool execution initialization for Phase 3.
 * Sets up the verification registry and execution orchestrator.
 */

import { ExecutionOrchestrator } from "./execution/executionOrchestrator";
import { ToolRouter } from "./toolRouter";
import { VerificationRegistry } from "./verification/verificationRegistry";
import { FilesystemVerifier } from "./verification/filesystemVerifier";
import { WindowVerifier } from "./verification/windowVerifier";
import { ScreenVerifier } from "./verification/screenVerifier";

let orchestrator: ExecutionOrchestrator | null = null;

/**
 * Initialize the tool execution system with verification.
 * Call this once during server startup.
 */
export function initializeToolExecution(
  toolRouter: ToolRouter,
  desktopAgentUrl: string = "http://127.0.0.1:8765",
): ExecutionOrchestrator {
  if (orchestrator) {
    return orchestrator;
  }

  // Create verification registry
  const verificationRegistry = new VerificationRegistry();

  // Register filesystem verifier
  const fsVerifier = new FilesystemVerifier();
  verificationRegistry.registerVerifier("filesystem", fsVerifier);
  for (const tool of ["copyFile", "duplicateFile", "moveFile", "deleteFile", "createFile", "createFolder", "renameFile", "writeFile"]) {
    verificationRegistry.mapToolToVerifier(tool, ["filesystem"]);
  }

  // Register window verifier
  const windowVerifier = new WindowVerifier(desktopAgentUrl);
  verificationRegistry.registerVerifier("window", windowVerifier);
  verificationRegistry.mapToolToVerifier("openApplication", ["window"]);
  verificationRegistry.mapToolToVerifier("closeApplication", ["window"]);
  verificationRegistry.mapToolToVerifier("closeWindow", ["window"]);
  verificationRegistry.mapToolToVerifier("focusWindow", ["window"]);
  verificationRegistry.mapToolToVerifier("minimizeWindow", ["window"]);
  verificationRegistry.mapToolToVerifier("maximizeWindow", ["window"]);
  verificationRegistry.mapToolToVerifier("showApplication", ["window"]);
  verificationRegistry.mapToolToVerifier("switchApplication", ["window"]);

  // Register screen verifier
  const screenVerifier = new ScreenVerifier(desktopAgentUrl);
  verificationRegistry.registerVerifier("screen", screenVerifier);
  verificationRegistry.mapToolToVerifier("captureScreen", ["screen"]);
  verificationRegistry.mapToolToVerifier("takeScreenshot", ["screen"]);
  verificationRegistry.mapToolToVerifier("screenCapture", ["screen"]);
  verificationRegistry.mapToolToVerifier("desktopBrowserOpen", ["screen"]);
  verificationRegistry.mapToolToVerifier("desktopBrowserSearch", ["screen"]);
  verificationRegistry.mapToolToVerifier("youtube_play", ["screen"]);
  verificationRegistry.mapToolToVerifier("youtube_resume", ["screen"]);
  verificationRegistry.mapToolToVerifier("youtube_pause", ["screen"]);

  // App automation emits explicit, task-level ok/verified fields from its
  // action-specific verifier. Require both before treating the tool call as
  // verified; launching or focusing an app alone is not enough for auto-close.
  verificationRegistry.registerVerifier("application", {
    canVerify: (tool) => ["saraAppExecuteGoal", "saraVoiceExecuteCommand", "closeLaunchedApplications"].includes(tool),
    verify: async (_tool, _args, executionResult) => {
      const outer = executionResult && typeof executionResult === "object"
        ? executionResult as Record<string, unknown>
        : {};
      const payload = outer.data && typeof outer.data === "object"
        ? outer.data as Record<string, unknown>
        : outer;
      const actionOk = payload.ok === true;
      const actionVerified = payload.verified === true;
      const verified = actionOk && actionVerified;
      return {
        verified,
        method: "application",
        checks: [
          { name: "application_action_returned_ok", passed: actionOk },
          { name: "application_action_explicitly_verified", passed: actionVerified },
        ],
        details: verified
          ? "The application suite reported an explicitly verified successful action."
          : "The application suite did not report both ok:true and verified:true for the requested action.",
        confidence: verified ? 1 : 0,
      };
    },
  });
  verificationRegistry.mapToolToVerifier("saraAppExecuteGoal", ["application"]);
  verificationRegistry.mapToolToVerifier("saraVoiceExecuteCommand", ["application"]);
  verificationRegistry.mapToolToVerifier("closeLaunchedApplications", ["application"]);

  verificationRegistry.registerVerifier("safety", {
    canVerify: (tool) => tool === "saraAgentEmergencyStop",
    verify: async (_tool, _args, executionResult) => {
      const outer = executionResult && typeof executionResult === "object"
        ? executionResult as Record<string, unknown>
        : {};
      const payload = outer.data && typeof outer.data === "object"
        ? outer.data as Record<string, unknown>
        : outer;
      const accepted = payload.ok === true && payload.status === "stop_requested";
      return {
        verified: accepted,
        method: "safety",
        checks: [{
          name: "emergency_stop_request_acknowledged",
          passed: accepted,
          reason: accepted ? undefined : "The coordinator did not acknowledge the stop request.",
        }],
        details: accepted
          ? "The coordinator accepted the stop request. An already-running one-shot action may still finish."
          : "The coordinator did not acknowledge the stop request.",
        confidence: accepted ? 1 : 0,
      };
    },
  });
  verificationRegistry.mapToolToVerifier("saraAgentEmergencyStop", ["safety"]);

  // Create execution orchestrator
  orchestrator = new ExecutionOrchestrator(toolRouter, verificationRegistry);

  console.log("[Phase 3] Tool execution system initialized with verification");

  return orchestrator;
}

/**
 * Get the global orchestrator instance.
 * Returns null if not yet initialized.
 */
export function getExecutionOrchestrator(): ExecutionOrchestrator | null {
  return orchestrator;
}
