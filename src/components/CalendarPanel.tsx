import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CalendarDays, Download, Plus, RefreshCw, Trash2, X } from "lucide-react";

interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes: string;
}

function localDateTimeValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function initialTimes() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { startsAt: localDateTimeValue(start), endsAt: localDateTimeValue(end) };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function CalendarPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [times, setTimes] = useState(initialTimes);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/calendar/events", { headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || !Array.isArray(body.events)) {
        throw new Error(body?.error || "Could not load the local calendar.");
      }
      setEvents(body.events);
    } catch (cause: any) {
      setError(cause?.message || "Could not load the local calendar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void loadEvents();
  }, [isOpen, loadEvents]);

  const sortedEvents = useMemo(() => [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [events]);

  const createEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title,
          startsAt: new Date(times.startsAt).toISOString(),
          endsAt: new Date(times.endsAt).toISOString(),
          notes,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) throw new Error(body?.error || "Could not save the event.");
      setEvents((current) => [...current, body.event]);
      setTitle("");
      setNotes("");
      setTimes(initialTimes());
    } catch (cause: any) {
      setError(cause?.message || "Could not save the event.");
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) throw new Error(body?.error || "Could not delete the event.");
      setEvents((current) => current.filter((event) => event.id !== id));
    } catch (cause: any) {
      setError(cause?.message || "Could not delete the event.");
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.button
            type="button"
            aria-label="Close calendar"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 cursor-default bg-black/60 backdrop-blur-sm"
          />
          <motion.aside
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            role="dialog" aria-modal="true" aria-labelledby="sara-calendar-title"
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-cyan-300/15 bg-[#070910]/95 shadow-2xl backdrop-blur-2xl"
          >
            <header className="flex items-center justify-between border-b border-white/10 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-2 text-cyan-200"><CalendarDays size={19} /></div>
                <div>
                  <h2 id="sara-calendar-title" className="text-sm font-semibold tracking-[0.18em] text-white">LOCAL CALENDAR</h2>
                  <p className="mt-1 text-xs text-slate-400">Stored privately in this SARA installation</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a href="/api/calendar/export.ics" download="sara-calendar.ics" title="Export calendar as an ICS file" className="rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white"><Download size={16} /></a>
                <button type="button" onClick={onClose} aria-label="Close calendar" className="rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white"><X size={18} /></button>
              </div>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              <div className="rounded-xl border border-amber-200/15 bg-amber-100/5 px-4 py-3 text-xs leading-relaxed text-amber-100/75">
                This is an offline SARA calendar, not a Google or Outlook sync. Export an ICS file to import events into another calendar.
              </div>

              <form onSubmit={createEvent} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-cyan-200"><Plus size={14} /> Add an event</div>
                <label className="block text-xs text-slate-300">
                  Title
                  <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50" placeholder="Project review" />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-xs text-slate-300">Starts
                    <input type="datetime-local" value={times.startsAt} onChange={(event) => setTimes((current) => ({ ...current, startsAt: event.target.value }))} required className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white outline-none focus:border-cyan-300/50" />
                  </label>
                  <label className="block text-xs text-slate-300">Ends
                    <input type="datetime-local" value={times.endsAt} onChange={(event) => setTimes((current) => ({ ...current, endsAt: event.target.value }))} required className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white outline-none focus:border-cyan-300/50" />
                  </label>
                </div>
                <label className="block text-xs text-slate-300">
                  Notes <span className="text-slate-500">(optional)</span>
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={2} className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50" placeholder="Details or a reminder" />
                </label>
                <button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400/15 px-4 py-2.5 text-xs font-semibold tracking-widest text-cyan-100 transition hover:bg-cyan-400/25 disabled:opacity-50">{saving ? "SAVING…" : "SAVE EVENT"}</button>
              </form>

              <section aria-label="Upcoming and saved events">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-300">Events <span className="text-slate-500">({events.length})</span></h3>
                  <button type="button" onClick={() => void loadEvents()} disabled={loading} title="Refresh events" className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-50"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
                </div>
                {error && <div role="alert" className="mb-3 rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-xs text-rose-200">{error}</div>}
                {loading ? <p className="py-8 text-center text-sm text-slate-500">Loading events…</p> : sortedEvents.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">No events yet. Add one above, or ask Sara to schedule it.</div>
                ) : (
                  <ul className="space-y-2">
                    {sortedEvents.map((event) => (
                      <li key={event.id} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4">
                        <div className="min-w-0 flex-1">
                          <h4 className="truncate text-sm font-medium text-white">{event.title}</h4>
                          <p className="mt-1 text-xs text-cyan-100/80">{formatDate(event.startsAt)} — {formatDate(event.endsAt)}</p>
                          {event.notes && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-400">{event.notes}</p>}
                        </div>
                        <button type="button" onClick={() => void deleteEvent(event.id)} aria-label={`Delete ${event.title}`} title="Delete event" className="self-start rounded-lg p-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-200"><Trash2 size={15} /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
