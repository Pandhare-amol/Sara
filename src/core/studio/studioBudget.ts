import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Conservative attempt reservations; charges may differ and failed requests may bill. */
export class StudioBudget {
  private readonly days: Record<string, number>;
  constructor(private readonly file: string, private readonly dailyLimitUsd: number) {
    if (!Number.isFinite(dailyLimitUsd) || dailyLimitUsd <= 0 || dailyLimitUsd > 100) throw new Error("Invalid studio daily budget.");
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Studio budget cannot be a symlink.");
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { schema: 1; days: Record<string, number> };
      if (saved.schema !== 1 || !saved.days || typeof saved.days !== "object" ||
          Object.values(saved.days).some((amount) => !Number.isFinite(amount) || amount < 0)) throw new Error("Studio budget ledger needs review.");
      this.days = saved.days;
    } else this.days = {};
  }
  snapshot(now = new Date()) { const day = now.toISOString().slice(0, 10);
    return { day, estimatedReservedUsd: this.days[day] || 0, dailyLimitUsd: this.dailyLimitUsd,
      note: "Estimates are conservative request reservations, not actual invoices; failed calls may still be charged." }; }
  reserve(amount: number, now = new Date()) {
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10) throw new Error("Unknown or unsafe media cost estimate.");
    const day = now.toISOString().slice(0, 10), next = (this.days[day] || 0) + amount;
    if (next > this.dailyLimitUsd + 1e-9) throw new Error("Daily media generation budget exhausted.");
    const updated = { ...this.days, [day]: next };
    const recent = Object.fromEntries(Object.entries(updated).filter(([date]) => date >= new Date(now.getTime() - 31 * 86400_000).toISOString().slice(0, 10)));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error("Studio budget cannot be a symlink.");
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify({ schema: 1, days: recent }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, this.file); this.days[day] = next;
      for (const key of Object.keys(this.days)) if (!(key in recent)) delete this.days[key];
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
}
