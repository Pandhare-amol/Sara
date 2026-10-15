import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalCalendarService } from "../../src/services/LocalCalendarService";

test("local calendar persists, filters, deletes, and exports calendar-safe ICS", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-calendar-test-"));
  const calendar = new LocalCalendarService(path.join(directory, "calendar-events.json"));
  try {
    const event = calendar.create({
      title: "Planning, review; launch",
      startsAt: "2026-10-15T09:00:00+05:30",
      endsAt: "2026-10-15T10:00:00+05:30",
      notes: "First line\nSecond line",
    });

    assert.equal(event.title, "Planning, review; launch");
    assert.equal(calendar.list().length, 1);
    assert.equal(calendar.list({ from: "2026-10-15T03:45:00Z", to: "2026-10-15T04:45:00Z" }).length, 1);
    assert.equal(calendar.list({ from: "2026-10-16T00:00:00Z" }).length, 0);

    const ics = calendar.toIcs();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Planning\\, review\\; launch/);
    assert.match(ics, /DESCRIPTION:First line\\nSecond line/);
    assert.match(ics, /DTSTART:20261015T033000Z/);

    assert.equal(calendar.delete(event.id), true);
    assert.equal(calendar.delete(event.id), false);
    assert.equal(calendar.list().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local calendar folds long UTF-8 ICS lines and repairs malformed stored metadata dates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-calendar-ics-fold-"));
  const file = path.join(directory, "calendar-events.json");
  const calendar = new LocalCalendarService(file);
  try {
    const event = calendar.create({
      title: "Calendar export boundary test",
      startsAt: "2026-10-16T09:00:00Z",
      endsAt: "2026-10-16T10:00:00Z",
      notes: "é".repeat(120),
    });
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored[0].createdAt = "invalid";
    stored[0].updatedAt = null;
    fs.writeFileSync(file, JSON.stringify(stored));

    const repaired = calendar.list()[0];
    assert.equal(repaired.id, event.id);
    assert.equal(repaired.createdAt, event.startsAt);
    assert.equal(repaired.updatedAt, event.startsAt);

    const lines = calendar.toIcs().split("\r\n");
    assert.ok(lines.every((line) => Buffer.byteLength(line, "utf8") <= 75));
    assert.ok(lines.some((line) => line.startsWith(" ")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local calendar rejects invalid and reversed event times", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sara-calendar-invalid-"));
  const calendar = new LocalCalendarService(path.join(directory, "calendar-events.json"));
  try {
    assert.throws(() => calendar.create({ title: "", startsAt: "2026-10-15T10:00:00Z", endsAt: "2026-10-15T11:00:00Z" }), /title/i);
    assert.throws(() => calendar.create({ title: "Invalid", startsAt: "not-a-date", endsAt: "2026-10-15T11:00:00Z" }), /startsAt/i);
    assert.throws(() => calendar.create({ title: "Reversed", startsAt: "2026-10-15T11:00:00Z", endsAt: "2026-10-15T10:00:00Z" }), /later/);
    assert.throws(() => calendar.list({ from: "2026-10-16T00:00:00Z", to: "2026-10-15T00:00:00Z" }), /after/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
