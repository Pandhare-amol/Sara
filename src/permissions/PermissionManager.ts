// src/permissions/PermissionManager.ts
import { EventBus } from "../core/events/EventBus";

/**
 * Simple permission manager used by ToolRouter.
 * In a real system this would consult a policy DB, user roles, etc.
 * For now it grants permission to all users except when a special
 * "blocked" flag is present in the request args.
 */
export class PermissionManager {
  private static _instance: PermissionManager | null = null;
  private eventBus = EventBus.instance;

  private constructor() {}

  public static get instance(): PermissionManager {
    if (!PermissionManager._instance) {
      PermissionManager._instance = new PermissionManager();
    }
    return PermissionManager._instance;
  }

  /**
   * Request permission for a tool execution.
   * @param toolName name of the tool being invoked
   * @param context optional context, currently expects { userId?: string, blocked?: boolean }
   * @returns { granted: boolean, reason?: string }
   */
  async requestPermission(
    toolName: string,
    context: { userId?: string; blocked?: boolean } = {}
  ): Promise<{ granted: boolean; reason?: string }> {
    // Emit an event – listeners could implement UI prompts, audits, etc.
    this.eventBus.emitEvent("permissionRequested", { toolName, context });

    // Simple policy: if caller explicitly sets blocked, deny.
    if (context.blocked) {
      return { granted: false, reason: "blocked by request" };
    }
    // Otherwise allow – future work could check user roles.
    return { granted: true };
  }
}
