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
  verificationRegistry.mapToolToVerifier("copyFile", ["filesystem"]);
  verificationRegistry.mapToolToVerifier("moveFile", ["filesystem"]);
  verificationRegistry.mapToolToVerifier("deleteFile", ["filesystem"]);
  verificationRegistry.mapToolToVerifier("createFolder", ["filesystem"]);
  verificationRegistry.mapToolToVerifier("renameFile", ["filesystem"]);
  verificationRegistry.mapToolToVerifier("writeFile", ["filesystem"]);

  // Register window verifier
  const windowVerifier = new WindowVerifier(desktopAgentUrl);
  verificationRegistry.registerVerifier("window", windowVerifier);
  verificationRegistry.mapToolToVerifier("openApplication", ["window"]);
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
  verificationRegistry.mapToolToVerifier("searchYouTube", ["screen"]);
  verificationRegistry.mapToolToVerifier("youtube_search", ["screen"]);
    verificationRegistry.mapToolToVerifier("youtube_play", ["screen"]);
    verificationRegistry.mapToolToVerifier("youtube_resume", ["screen"]);
    verificationRegistry.mapToolToVerifier("youtube_pause", ["screen"]);
  verificationRegistry.mapToolToVerifier("openWebsite", ["screen"]);

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
