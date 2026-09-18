import {
  deleteRelationshipRecord,
  loadRelationshipRecords,
  upsertRelationshipRecord,
  type PersistedRelationshipRecord,
} from "../../server_memory";

export type RelationshipStatus = "CONFIRMED" | "INFERRED" | "UNCERTAIN" | "HISTORICAL";
export type RelationshipContext = "PERSONAL" | "PROFESSIONAL" | "GENERAL";

export interface RelationshipLink {
  type: string;
  context: RelationshipContext;
  status: RelationshipStatus;
  strength: number;
  confidence: number;
  source: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: RelationshipStatus; changedAt: string; reason: string }>;
}

export interface PersonRecord extends PersistedRelationshipRecord {
  personId: string;
  name: string;
  aliases: string[];
  relationships: RelationshipLink[];
  preferences: string[];
  importantFacts: string[];
  communicationStyle?: string;
  boundaries: string[];
  interactionHistory: string[];
  lastInteraction?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipTurnContext {
  person?: string;
  personId?: string;
  relationship?: string;
  relationships?: string[];
  context: RelationshipContext;
  confidence: number;
  communicationStyle: string;
  boundaries: string[];
  relevantFacts: string[];
  clarificationQuestion?: string;
}

const PROFESSIONAL_TERMS = /\b(company|business|equity|client|customer|manager|employee|work|office|project|proposal|contract|salary|meeting|revenue|ลงทุน|professional)\b/i;
const PERSONAL_TERMS = /\b(forgive|argument|family|love|feel|feelings|relationship|home|personal|worry|worried|hurt|miss)\b/i;
const NO_STORE = /\b(?:don't|do not|never)\s+(?:remember|store|save|keep)\b/i;

function now(): string {
  return new Date().toISOString();
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} .'-]/gu, "").trim();
}

function personIdFor(name: string): string {
  return `person_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

function normalizeRelationship(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function inferContext(text: string): RelationshipContext {
  if (PROFESSIONAL_TERMS.test(text) && !PERSONAL_TERMS.test(text)) return "PROFESSIONAL";
  if (PERSONAL_TERMS.test(text)) return "PERSONAL";
  return "GENERAL";
}

function contextForRelationship(type: string, text: string): RelationshipContext {
  if (/BUSINESS|PARTNER|COLLEAGUE|CLIENT|CUSTOMER|MANAGER|EMPLOYEE|MENTOR|TEACHER|DOCTOR/.test(type)) return "PROFESSIONAL";
  if (/MOTHER|FATHER|PARENT|BROTHER|SISTER|SIBLING|CHILD|SPOUSE|FAMILY|FRIEND|RELATIVE|NEIGHBOR/.test(type)) return "PERSONAL";
  return inferContext(text) === "PROFESSIONAL" ? "PROFESSIONAL" : "PERSONAL";
}

function styleFor(type: string, context: RelationshipContext): string {
  if (context === "PROFESSIONAL" || /CLIENT|CUSTOMER|MANAGER|EMPLOYEE|BUSINESS|COLLEAGUE/.test(type)) return "DIRECT_STRATEGIC";
  if (/MOTHER|FATHER|PARENT|DOCTOR|MENTOR|TEACHER/.test(type)) return "WARM_RESPECTFUL";
  if (/FRIEND|SIBLING|BROTHER|SISTER|PARTNER|SPOUSE/.test(type)) return context === "PERSONAL" ? "CASUAL_WARM" : "BALANCED";
  return "CALM_NEUTRAL";
}

function createPerson(name: string): PersonRecord {
  const timestamp = now();
  return {
    personId: personIdFor(name),
    name,
    aliases: [],
    relationships: [],
    preferences: [],
    importantFacts: [],
    boundaries: [],
    interactionHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class RelationshipContextManager {
  private records = new Map<string, PersonRecord>();
  private initialized: Promise<void> | null = null;

  private async ensureLoaded(): Promise<void> {
    if (!this.initialized) {
      this.initialized = loadRelationshipRecords().then((records) => {
        records.forEach((record) => this.records.set(record.personId, record as PersonRecord));
      }).catch(() => {});
    }
    await this.initialized;
  }

  async list(): Promise<PersonRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.records.values());
  }

  async getById(personId: string): Promise<PersonRecord | null> {
    await this.ensureLoaded();
    return this.records.get(personId) || null;
  }

  async rememberRelationship(input: {
    name: string;
    relationshipType: string;
    context?: RelationshipContext;
    confidence?: number;
    status?: RelationshipStatus;
    source?: string;
    strength?: number;
    alias?: string;
  }): Promise<PersonRecord> {
    await this.ensureLoaded();
    const name = normalizeName(input.name);
    if (!name) throw new Error("RELATIONSHIP_NOT_FOUND");
    const person = this.records.get(personIdFor(name)) || createPerson(name);
    const timestamp = now();
    const type = normalizeRelationship(input.relationshipType);
    const context = input.context || "GENERAL";
    const existing = person.relationships.find((item) => item.type === type && item.context === context && item.active);
    const link: RelationshipLink = existing || {
      type,
      context,
      status: input.status || "CONFIRMED",
      strength: input.strength ?? 0.5,
      confidence: input.confidence ?? 0.7,
      source: input.source || "user_statement",
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      history: [],
    };
    link.status = input.status || link.status;
    link.confidence = Math.max(link.confidence, input.confidence ?? link.confidence);
    link.strength = input.strength ?? link.strength;
    link.source = input.source || link.source;
    link.updatedAt = timestamp;
    link.active = true;
    if (!existing) person.relationships.push(link);
    if (input.alias && !person.aliases.includes(input.alias)) person.aliases.push(input.alias);
    person.updatedAt = timestamp;
    this.records.set(person.personId, person);
    await upsertRelationshipRecord(person);
    return person;
  }

  async learnFromTurn(text: string): Promise<{ changed: boolean; person?: PersonRecord; correction?: boolean }> {
    if (!text) return { changed: false };
    const explicit = text.match(/\b([A-Z][\p{L}\p{N}'-]{1,30})\s+is\s+(?:my|our)\s+([a-z][\p{L}\p{N}' -]{2,30})/u)
      || text.match(/\bmy\s+([a-z][\p{L}\p{N}' -]{2,30})\s+is\s+([A-Z][\p{L}\p{N}'-]{1,30})\b/u);
    const correction = text.match(/\b([A-Z][\p{L}\p{N}'-]{1,30})\s+(?:isn't|is not)\s+my\s+([a-z][\p{L}\p{N}' -]{2,30})/iu)
      || text.match(/\b(?:don't|do not|never)\s+(?:remember|store|save|keep)\s+(?:that\s+)?([A-Z][\p{L}\p{N}'-]{1,30})\s+is\s+my\s+([a-z][\p{L}\p{N}' -]{2,30})/iu);
    if (correction) {
      const name = normalizeName(correction[1]);
      const person = await this.getById(personIdFor(name));
      if (!person) return { changed: false };
      const type = normalizeRelationship(correction[2]);
      const timestamp = now();
      person.relationships = person.relationships.map((link) => link.type === type && link.active
        ? { ...link, active: false, status: "HISTORICAL", updatedAt: timestamp, history: [...link.history, { status: "HISTORICAL", changedAt: timestamp, reason: "User correction" }] }
        : link);
      person.updatedAt = timestamp;
      await upsertRelationshipRecord(person);
      return { changed: true, person, correction: true };
    }
    if (NO_STORE.test(text)) return { changed: false };
    const inferredCollaboration = text.match(/\b([A-Z][\p{L}\p{N}'-]{1,30})\s+is\s+(?:also\s+)?(?:helping|working|collaborating)\b.*\b(company|business|project)\b/iu);
    if (inferredCollaboration) {
      const person = await this.rememberRelationship({
        name: normalizeName(inferredCollaboration[1]),
        relationshipType: "BUSINESS_COLLABORATOR",
        context: "PROFESSIONAL",
        confidence: 0.57,
        status: "INFERRED",
        source: "conversation_inference",
        strength: 0.5,
      });
      return { changed: true, person };
    }
    if (!explicit) return { changed: false };
    const first = normalizeName(explicit[1]);
    const second = normalizeName(explicit[2]);
    const isNameFirst = /^[A-Z]/u.test(explicit[1]);
    const name = isNameFirst ? first : second;
    const relationshipText = isNameFirst ? second : first;
    const relationshipTypes = relationshipText
      .split(/\s+(?:and|&|,)\s+/i)
      .map((value) => value.replace(/^my\s+/i, "").trim())
      .filter(Boolean);
    let person = createPerson(name);
    for (const relationship of relationshipTypes) {
      person = await this.rememberRelationship({
        name,
        relationshipType: relationship,
        context: contextForRelationship(normalizeRelationship(relationship), text),
        confidence: 0.99,
        status: "CONFIRMED",
        source: "explicit_user_statement",
        strength: 0.5,
      });
    }
    return { changed: true, person };
  }

  async resolveTurnContext(text: string): Promise<RelationshipTurnContext | null> {
    await this.ensureLoaded();
    const lowered = text.toLowerCase();
    const person = Array.from(this.records.values()).find((candidate) => [candidate.name, ...candidate.aliases].some((name) => lowered.includes(name.toLowerCase())));
    if (!person) return null;
    const context = inferContext(text);
    const active = person.relationships.filter((link) => link.active);
    const contextual = active.filter((link) => context === "GENERAL" || link.context === context || link.context === "GENERAL");
    const selected = contextual.sort((a, b) => b.confidence - a.confidence)[0];
    const relationshipNames = contextual.map((link) => link.type);
    const clarificationQuestion = selected && selected.confidence < 0.7
      ? `You mentioned ${person.name}. Should I treat this as a ${selected.type.toLowerCase().replace(/_/g, " ")} relationship?`
      : undefined;
    person.lastInteraction = now();
    person.interactionHistory = [...person.interactionHistory.slice(-19), text.slice(0, 240)];
    person.updatedAt = now();
    void upsertRelationshipRecord(person);
    return {
      person: person.name,
      personId: person.personId,
      relationship: selected?.type,
      relationships: relationshipNames,
      context,
      confidence: selected?.confidence ?? 0.4,
      communicationStyle: selected ? styleFor(selected.type, context) : "CALM_NEUTRAL",
      boundaries: person.boundaries,
      relevantFacts: person.importantFacts.slice(0, 5),
      clarificationQuestion,
    };
  }

  async removePerson(personId: string): Promise<boolean> {
    await this.ensureLoaded();
    this.records.delete(personId);
    return deleteRelationshipRecord(personId);
  }
}

let manager: RelationshipContextManager | null = null;
export function getRelationshipContextManager(): RelationshipContextManager {
  if (!manager) manager = new RelationshipContextManager();
  return manager;
}
