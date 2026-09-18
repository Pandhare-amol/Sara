import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataFile } from "../../server_paths";
import { EventBus } from "../core/events/EventBus";

export interface DigitalWorldApplication {
  name: string;
  processId?: number;
  windows?: string[];
  focused?: boolean;
}

export interface DigitalWorldBrowserTab {
  title?: string;
  url?: string;
  active?: boolean;
  browser?: string;
}

export interface DigitalWorldAttentionItem {
  id: string;
  title: string;
  reason: string;
  priority: "low" | "medium" | "high";
  createdAt: string;
  resolved?: boolean;
}

export interface DigitalWorldObservation {
  id: string;
  source: string;
  kind: "screen" | "application" | "browser" | "file" | "task" | "user" | "system";
  summary: string;
  details?: Record<string, unknown>;
  observedAt: string;
}

export interface DigitalWorldContextSnapshot {
  version: 1;
  observedAt: string;
  activeApplication?: string;
  activeWindow?: string;
  activeProject?: string;
  applications: DigitalWorldApplication[];
  browserTabs: DigitalWorldBrowserTab[];
  unfinishedWork: string[];
  attentionItems: DigitalWorldAttentionItem[];
  recentObservations: DigitalWorldObservation[];
}

export type DigitalWorldContextUpdate = Partial<Omit<DigitalWorldContextSnapshot, "version" | "observedAt" | "recentObservations">> & {
  observedAt?: string;
};

const DEFAULT_SNAPSHOT: DigitalWorldContextSnapshot = {
  version: 1,
  observedAt: new Date(0).toISOString(),
  applications: [],
  browserTabs: [],
  unfinishedWork: [],
  attentionItems: [],
  recentObservations: [],
};

export class DigitalWorldContextStore {
  private snapshot: DigitalWorldContextSnapshot = { ...DEFAULT_SNAPSHOT };
  private readonly filePath: string;

  constructor(filePath: string = dataFile("digital-world-context.json")) {
    this.filePath = filePath;
    this.load();
  }

  getSnapshot(): DigitalWorldContextSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as DigitalWorldContextSnapshot;
  }

  update(update: DigitalWorldContextUpdate, observation?: Omit<DigitalWorldObservation, "id" | "observedAt">): DigitalWorldContextSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      version: 1,
      observedAt: update.observedAt || new Date().toISOString(),
      applications: update.applications ? [...update.applications] : this.snapshot.applications,
      browserTabs: update.browserTabs ? [...update.browserTabs] : this.snapshot.browserTabs,
      unfinishedWork: update.unfinishedWork ? [...update.unfinishedWork] : this.snapshot.unfinishedWork,
      attentionItems: update.attentionItems ? [...update.attentionItems] : this.snapshot.attentionItems,
    };

    if (observation) this.recordObservation(observation, false);
    this.persist();
    const result = this.getSnapshot();
    EventBus.instance.emitEvent("digitalWorldContextUpdated", result);
    return result;
  }

  recordObservation(input: Omit<DigitalWorldObservation, "id" | "observedAt">, persist = true): DigitalWorldObservation {
    const observation: DigitalWorldObservation = {
      ...input,
      id: `observation-${crypto.randomUUID()}`,
      observedAt: new Date().toISOString(),
    };
    this.snapshot.recentObservations = [...this.snapshot.recentObservations, observation].slice(-100);
    if (persist) this.persist();
    EventBus.instance.emitEvent("digitalWorldObservation", observation);
    return { ...observation };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DigitalWorldContextSnapshot>;
      this.snapshot = {
        ...DEFAULT_SNAPSHOT,
        ...parsed,
        applications: parsed.applications || [],
        browserTabs: parsed.browserTabs || [],
        unfinishedWork: parsed.unfinishedWork || [],
        attentionItems: parsed.attentionItems || [],
        recentObservations: (parsed.recentObservations || []).slice(-100),
      };
    } catch {
      this.snapshot = { ...DEFAULT_SNAPSHOT };
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), "utf8");
    } catch (error) {
      console.error("[DigitalWorldContext] Failed to persist snapshot", error);
    }
  }
}

let store: DigitalWorldContextStore | undefined;
export function getDigitalWorldContext(): DigitalWorldContextStore {
  store ||= new DigitalWorldContextStore();
  return store;
}