import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCalendarEventInput {
  title: unknown;
  startsAt: unknown;
  endsAt: unknown;
  notes?: unknown;
}

function cleanText(value: unknown, maxLength: number): string {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeDate(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`${field} must be a valid ISO date/time.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO date/time.`);
  }
  return parsed.toISOString();
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsDate(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let byteLength = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && byteLength + characterBytes > 75) {
      parts.push(current);
      current = ` ${character}`;
      byteLength = 1 + characterBytes;
    } else {
      current += character;
      byteLength += characterBytes;
    }
  }
  if (current) parts.push(current);
  return parts.join("\r\n");
}

export class LocalCalendarService {
  constructor(private readonly storagePath: string) {}

  private read(): CalendarEvent[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter((event): event is CalendarEvent =>
        event && typeof event === "object"
        && typeof event.id === "string"
        && typeof event.title === "string"
        && Number.isFinite(new Date(event.startsAt).getTime())
        && Number.isFinite(new Date(event.endsAt).getTime()),
      ).map((event) => {
        const startsAt = new Date(event.startsAt).toISOString();
        const endsAt = new Date(event.endsAt).toISOString();
        const created = typeof event.createdAt === "string" ? new Date(event.createdAt) : null;
        const updated = typeof event.updatedAt === "string" ? new Date(event.updatedAt) : null;
        return {
          id: event.id.slice(0, 80),
          title: cleanText(event.title, 160),
          startsAt,
          endsAt,
          notes: cleanText(event.notes, 2000),
          createdAt: created && Number.isFinite(created.getTime()) ? created.toISOString() : startsAt,
          updatedAt: updated && Number.isFinite(updated.getTime()) ? updated.toISOString() : startsAt,
        };
      }).filter((event) => event.title && Date.parse(event.endsAt) > Date.parse(event.startsAt));
    } catch {
      return [];
    }
  }

  private write(events: CalendarEvent[]): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(events, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.storagePath);
    try { fs.chmodSync(this.storagePath, 0o600); } catch { /* best-effort on platforms with ACLs */ }
  }

  list(options: { from?: string; to?: string } = {}): CalendarEvent[] {
    const from = options.from ? Date.parse(normalizeDate(options.from, "from")) : Number.NEGATIVE_INFINITY;
    const to = options.to ? Date.parse(normalizeDate(options.to, "to")) : Number.POSITIVE_INFINITY;
    if (to < from) throw new Error("to must be after from.");
    return this.read()
      .filter((event) => Date.parse(event.endsAt) >= from && Date.parse(event.startsAt) <= to)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  create(input: CreateCalendarEventInput): CalendarEvent {
    const title = cleanText(input.title, 160);
    if (!title) throw new Error("Event title is required.");

    const startsAt = normalizeDate(input.startsAt, "startsAt");
    const endsAt = normalizeDate(input.endsAt, "endsAt");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error("endsAt must be later than startsAt.");
    }

    const events = this.read();
    if (events.length >= 10_000) throw new Error("The local calendar is full.");
    const now = new Date().toISOString();
    const event: CalendarEvent = {
      id: crypto.randomUUID(),
      title,
      startsAt,
      endsAt,
      notes: cleanText(input.notes, 2000),
      createdAt: now,
      updatedAt: now,
    };
    events.push(event);
    this.write(events);
    return event;
  }

  delete(id: unknown): boolean {
    if (typeof id !== "string" || id.length < 1 || id.length > 80) return false;
    const events = this.read();
    const remaining = events.filter((event) => event.id !== id);
    if (remaining.length === events.length) return false;
    this.write(remaining);
    return true;
  }

  toIcs(): string {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SARA//Local Calendar//EN", "CALSCALE:GREGORIAN"];
    for (const event of this.list()) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${escapeIcs(event.id)}@sara.local`,
        `DTSTAMP:${icsDate(event.createdAt || event.startsAt)}`,
        `DTSTART:${icsDate(event.startsAt)}`,
        `DTEND:${icsDate(event.endsAt)}`,
        `SUMMARY:${escapeIcs(event.title)}`,
      );
      if (event.notes) lines.push(`DESCRIPTION:${escapeIcs(event.notes)}`);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR", "");
    return lines.map(foldIcsLine).join("\r\n");
  }
}
