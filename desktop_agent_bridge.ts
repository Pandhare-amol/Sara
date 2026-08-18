import { appendToolCall, newToolCallId, newSessionId } from './server_state';

/**
 * Thin wrapper for calling desktop agent from the TaskManager.
 * Keeps the same callDesktopAgent signature used in server_full.ts.
 * This file intentionally does not auto-spawn the agent; it proxies
 * to the existing callDesktopAgent implementation in server_full.ts
 * by re-import pattern (server_task_manager will accept an injected call).
 */

export type AgentResult = { ok: boolean; result?: unknown; error?: string };

// Placeholder bridge: actual callDesktopAgent is provided by server_full at runtime.
// This function will be replaced by assignment when TaskManager is initialized.
export let callDesktopAgent: (tool: string, args: Record<string, unknown>) => Promise<AgentResult> = async () => {
  return { ok: false, error: 'desktop agent bridge not initialized' };
};

// Setter to allow runtime injection without assigning to the imported
// module namespace object (which is read-only). Use this from `server_full.ts`.
export function setCallDesktopAgent(fn: (tool: string, args: Record<string, unknown>) => Promise<AgentResult>) {
  callDesktopAgent = fn;
}

export async function logToolCall(conversationId: string, toolName: string, args: Record<string, unknown>, result: unknown, error?: string, taskId?: string) {
  try {
    await appendToolCall({ id: newToolCallId(), sessionId: newSessionId(), conversationId, toolName, args, result, error, taskId, timestamp: new Date().toISOString() });
  } catch (e) {
    // best-effort
    console.error('[TaskManager] Failed to append tool call', e);
  }
}
