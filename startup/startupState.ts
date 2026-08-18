export type ServiceState =
  | "STOPPED"
  | "STARTING"
  | "HEALTHY"
  | "DEGRADED"
  | "RECOVERING"
  | "FAILED"
  | "FOREIGN_SERVICE"
  | "ADOPTED"
  | "NOT_RUNNING"
  | "STALE"
  | "UNKNOWN";

export interface ComponentStatus {
  name: "supervisor" | "backend" | "desktop_agent" | "frontend";
  state: ServiceState;
  healthy: boolean;
  pid?: number;
  reason?: string;
  adopted?: boolean;
}

export interface ManagedServiceState {
  name: string;
  state: ServiceState;
  pid?: number;
  port: number;
  startedBySupervisor: boolean;
  adopted: boolean;
  restartCount: number;
  lastHealthCheck?: string;
  lastError?: string;
}

export interface StartupSnapshot {
  supervisor: ComponentStatus;
  backend: ComponentStatus;
  desktop_agent: ComponentStatus;
  frontend?: ComponentStatus;
}

export function overallServiceState(snapshot: StartupSnapshot): ServiceState {
  const components = [snapshot.supervisor, snapshot.backend, snapshot.desktop_agent, snapshot.frontend].filter(Boolean) as ComponentStatus[];
  if (components.length === 0) return "UNKNOWN";
  if (components.every((c) => c.state === "NOT_RUNNING" || c.state === "STOPPED")) return "STOPPED";
  if (components.some((c) => c.state === "FAILED" || c.state === "STALE" || c.state === "FOREIGN_SERVICE")) return "DEGRADED";
  if (components.some((c) => c.state === "RECOVERING")) return "RECOVERING";
  if (components.every((c) => c.healthy || c.state === "ADOPTED" || c.state === "HEALTHY")) return "HEALTHY";
  if (components.some((c) => c.state === "STARTING")) return "STARTING";
  if (components.some((c) => c.state === "DEGRADED")) return "DEGRADED";
  if (components.some((c) => c.healthy) && components.some((c) => !c.healthy)) return "DEGRADED";
  return "UNKNOWN";
}

export function formatStartupSummary(snapshot: StartupSnapshot): string {
  const overall = overallServiceState(snapshot);
  return [
    `supervisor:${snapshot.supervisor.state}`,
    `backend:${snapshot.backend.state}`,
    `desktop_agent:${snapshot.desktop_agent.state}`,
    snapshot.frontend ? `frontend:${snapshot.frontend.state}` : null,
    `overall:${overall}`,
  ].filter(Boolean).join(" ");
}
