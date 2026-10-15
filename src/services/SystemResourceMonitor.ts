import crypto from "node:crypto";

export interface SystemProcessResource {
  pid: number;
  name: string;
  createTime?: number;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes?: number;
  protected: boolean;
  highUsage: boolean;
}

export interface SystemResourceSnapshot {
  available: true;
  updatedAt: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryUsed?: string;
  memoryTotal?: string;
  disk: { available: boolean; percent: number | null; used?: string; total?: string; mountpoint?: string };
  battery: { available: boolean; percent: number | null; plugged: boolean | null; secondsLeft?: number | null };
  processes: SystemProcessResource[];
}

export type SystemResourceAlertKind = "cpu_high" | "memory_high" | "disk_high" | "battery_low" | "process_high";
export interface SystemResourceAlert {
  id: string;
  createdAt: number;
  severity: "WARNING" | "CRITICAL";
  kind: SystemResourceAlertKind;
  message: string;
  process?: { pid: number; name: string };
}

export interface SystemResourceMonitorConfig {
  cpuHighPercent: number;
  memoryHighPercent: number;
  diskHighPercent: number;
  processCpuHighPercent: number;
  processMemoryHighPercent: number;
  batteryLowPercent: number;
  confirmationSamples: number;
}

const DEFAULT_CONFIG: SystemResourceMonitorConfig = {
  cpuHighPercent: 85,
  memoryHighPercent: 92,
  diskHighPercent: 92,
  processCpuHighPercent: 60,
  processMemoryHighPercent: 20,
  batteryLowPercent: 20,
  confirmationSamples: 2,
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function finitePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function cleanName(value: unknown): string {
  return String(value || "Unknown process").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || "Unknown process";
}

export class SystemResourceMonitor {
  private readonly config: SystemResourceMonitorConfig;
  private readonly highCounts = new Map<string, number>();
  private readonly activeGlobalAlerts = new Set<string>();
  private readonly processCounts = new Map<number, { count: number; recoveryCount: number; active: boolean; name: string }>();
  private batteryAlertActive = false;

  constructor(config: Partial<SystemResourceMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(input: unknown, now = Date.now()): { snapshot: SystemResourceSnapshot; alerts: SystemResourceAlert[] } {
    const source = record(input);
    const cpu = record(source.cpu);
    const ram = record(source.ram || source.memory);
    const diskSource = record(source.disk);
    const batterySource = record(source.battery);
    const cpuPercent = finitePercent(cpu.percent ?? source.cpu_percent ?? source.cpuPercent);
    const memoryPercent = finitePercent(ram.percent ?? source.memory_percent ?? source.memoryPercent);
    const diskPercent = finitePercent(diskSource.percent);
    const rawBatteryPercent = batterySource.percent ?? batterySource.percent_remaining;
    const batteryAvailable = batterySource.available === true || (rawBatteryPercent !== null && rawBatteryPercent !== undefined && Number.isFinite(Number(rawBatteryPercent)));
    const batteryPercent = batteryAvailable ? finitePercent(rawBatteryPercent) : null;
    const pluggedValue = batterySource.power_plugged ?? batterySource.plugged;
    const rawSecondsLeft = batterySource.secs_left ?? batterySource.secondsLeft;
    const secondsLeft = rawSecondsLeft !== null && rawSecondsLeft !== undefined && Number.isFinite(Number(rawSecondsLeft))
      ? Number(rawSecondsLeft)
      : null;
    const plugged = typeof pluggedValue === "boolean" ? pluggedValue : null;
    const rawProcesses = Array.isArray(source.processes) ? source.processes : Array.isArray(source.top_processes) ? source.top_processes : [];
    const processes = rawProcesses
      .map((value: unknown) => {
        const process = record(value);
        const pid = Number(process.pid);
        const processCpu = finitePercent(process.cpu_percent ?? process.cpuPercent) ?? 0;
        const processMemory = finitePercent(process.memory_percent ?? process.memoryPercent) ?? 0;
        const rawCreateTime = process.create_time ?? process.createTime;
        const createTime = rawCreateTime !== null && rawCreateTime !== undefined && Number.isFinite(Number(rawCreateTime)) ? Number(rawCreateTime) : undefined;
        return {
          pid,
          name: cleanName(process.name),
          createTime,
          cpuPercent: processCpu,
          memoryPercent: processMemory,
          memoryBytes: Number.isFinite(Number(process.memory_bytes ?? process.memoryBytes)) ? Number(process.memory_bytes ?? process.memoryBytes) : undefined,
          protected: process.protected === true,
          highUsage: processCpu >= this.config.processCpuHighPercent || processMemory >= this.config.processMemoryHighPercent,
        } satisfies SystemProcessResource;
      })
      .filter((process: SystemProcessResource) => Number.isInteger(process.pid) && process.pid > 0)
      .sort((left: SystemProcessResource, right: SystemProcessResource) => Math.max(right.cpuPercent, right.memoryPercent) - Math.max(left.cpuPercent, left.memoryPercent))
      .slice(0, 20);

    const snapshot: SystemResourceSnapshot = {
      available: true,
      updatedAt: new Date(now).toISOString(),
      cpuPercent,
      memoryPercent,
      memoryUsed: typeof ram.used === "string" ? ram.used.slice(0, 40) : undefined,
      memoryTotal: typeof ram.total === "string" ? ram.total.slice(0, 40) : undefined,
      disk: {
        available: diskSource.available === true || diskPercent !== null,
        percent: diskPercent,
        used: typeof diskSource.used === "string" ? diskSource.used.slice(0, 40) : undefined,
        total: typeof diskSource.total === "string" ? diskSource.total.slice(0, 40) : undefined,
        mountpoint: typeof diskSource.mountpoint === "string" ? diskSource.mountpoint.slice(0, 120) : undefined,
      },
      battery: {
        available: batteryAvailable,
        percent: batteryPercent,
        plugged,
        secondsLeft,
      },
      processes,
    };

    const alerts: SystemResourceAlert[] = [];
    this.checkGlobalThreshold("cpu_high", cpuPercent, this.config.cpuHighPercent, this.config.cpuHighPercent - 7, this.config.confirmationSamples, now, alerts);
    this.checkGlobalThreshold("memory_high", memoryPercent, this.config.memoryHighPercent, this.config.memoryHighPercent - 4, this.config.confirmationSamples, now, alerts);
    this.checkGlobalThreshold("disk_high", diskPercent, this.config.diskHighPercent, this.config.diskHighPercent - 4, this.config.confirmationSamples, now, alerts);

    if (batteryPercent !== null && plugged !== true && batteryPercent <= this.config.batteryLowPercent && !this.batteryAlertActive) {
      this.batteryAlertActive = true;
      alerts.push(this.makeAlert("battery_low", batteryPercent <= 10 ? "CRITICAL" : "WARNING", `Battery is low at ${batteryPercent}%. Connect the charger soon.`, now));
    } else if ((batteryPercent !== null && batteryPercent >= this.config.batteryLowPercent + 5) || plugged === true) {
      this.batteryAlertActive = false;
    }

    this.checkProcessThresholds(processes, now, alerts);
    return { snapshot, alerts };
  }

  private checkGlobalThreshold(
    kind: "cpu_high" | "memory_high" | "disk_high",
    value: number | null,
    threshold: number,
    recoveryThreshold: number,
    requiredSamples: number,
    now: number,
    alerts: SystemResourceAlert[],
  ): void {
    if (value === null) return;
    const count = value >= threshold ? (this.highCounts.get(kind) || 0) + 1 : 0;
    this.highCounts.set(kind, count);
    if (count >= Math.max(1, requiredSamples) && !this.activeGlobalAlerts.has(kind)) {
      this.activeGlobalAlerts.add(kind);
      const label = kind === "cpu_high" ? "CPU" : kind === "memory_high" ? "Memory" : "Disk";
      const severity = value >= (kind === "cpu_high" ? 95 : 97) ? "CRITICAL" : "WARNING";
      alerts.push(this.makeAlert(kind, severity, `${label} usage is high at ${value}%.`, now));
    }
    if (value < recoveryThreshold) this.activeGlobalAlerts.delete(kind);
  }

  private checkProcessThresholds(processes: SystemProcessResource[], now: number, alerts: SystemResourceAlert[]): void {
    const seen = new Set<number>();
    for (const process of processes) {
      seen.add(process.pid);
      const state = this.processCounts.get(process.pid) || { count: 0, recoveryCount: 0, active: false, name: process.name };
      state.name = process.name;
      if (process.highUsage) {
        state.count += 1;
        state.recoveryCount = 0;
        if (state.count >= Math.max(1, this.config.confirmationSamples) && !state.active) {
          state.active = true;
          const use = process.cpuPercent >= this.config.processCpuHighPercent
            ? `CPU ${process.cpuPercent}%`
            : `memory ${process.memoryPercent}%`;
          alerts.push(this.makeAlert("process_high", "WARNING", `${process.name} (PID ${process.pid}) has sustained high resource use: ${use}. Review it before closing; unsaved work may be lost.`, now, { pid: process.pid, name: process.name }));
        }
      } else {
        state.count = 0;
        state.recoveryCount += 1;
        if (state.recoveryCount >= 2) state.active = false;
      }
      this.processCounts.set(process.pid, state);
    }
    for (const pid of this.processCounts.keys()) {
      if (!seen.has(pid)) this.processCounts.delete(pid);
    }
  }

  private makeAlert(
    kind: SystemResourceAlertKind,
    severity: "WARNING" | "CRITICAL",
    message: string,
    now: number,
    process?: { pid: number; name: string },
  ): SystemResourceAlert {
    return { id: crypto.randomUUID(), createdAt: now, severity, kind, message, process };
  }
}
