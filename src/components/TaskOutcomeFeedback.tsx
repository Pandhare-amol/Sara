import { useEffect, useState } from "react";
import { Check, CircleAlert, X } from "lucide-react";
import { motion } from "motion/react";

export type TaskFeedbackRating = "accurate" | "partially_accurate" | "inaccurate";

interface TaskOutcomeFeedbackProps {
  taskId: string;
  onDismiss: () => void;
  onSubmit: (taskId: string, feedback: { rating: TaskFeedbackRating; note?: string }) => Promise<void>;
}

const RATING_OPTIONS: Array<{ value: TaskFeedbackRating; label: string }> = [
  { value: "accurate", label: "Accurate" },
  { value: "partially_accurate", label: "Partly" },
  { value: "inaccurate", label: "Not accurate" },
];

export function TaskOutcomeFeedback({ taskId, onDismiss, onSubmit }: TaskOutcomeFeedbackProps) {
  const [rating, setRating] = useState<TaskFeedbackRating | null>(null);
  const [note, setNote] = useState("");
  const [consentToLearn, setConsentToLearn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRating(null);
    setNote("");
    setConsentToLearn(false);
    setSubmitting(false);
    setError(null);
  }, [taskId]);

  const submit = async () => {
    if (!rating || !consentToLearn || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(taskId, { rating, ...(note.trim() ? { note: note.trim() } : {}) });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Feedback could not be saved.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.section
      role="region"
      aria-label="Optional task outcome feedback"
      aria-labelledby="task-outcome-feedback-title"
      aria-describedby="task-outcome-feedback-description"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      className="fixed bottom-5 right-5 z-[110] w-[min(24rem,calc(100vw-2.5rem))] rounded-2xl border border-cyan-400/25 bg-[#070811]/95 p-4 text-white shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-cyan-300">Verified task outcome</p>
          <h3 id="task-outcome-feedback-title" className="mt-1 text-sm font-semibold">Was the result accurate?</h3>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss feedback request" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
          <X size={15} />
        </button>
      </div>

      <p id="task-outcome-feedback-description" className="mt-2 text-[10px] leading-relaxed text-slate-400">
        Optional feedback is saved locally for future evaluation. It does not retrain the model, change permissions, or promote skills.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1.5" role="group" aria-label="Rate task outcome accuracy">
        {RATING_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={rating === option.value}
            onClick={() => setRating(option.value)}
            className={`rounded-lg border px-2 py-2 text-[10px] font-medium transition ${rating === option.value
              ? "border-cyan-300/60 bg-cyan-400/15 text-cyan-100"
              : "border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08]"}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label htmlFor="task-outcome-feedback-note" className="mt-3 block text-[10px] text-slate-400">
        Optional correction <span className="text-slate-600">(do not include credentials)</span>
      </label>
      <textarea
        id="task-outcome-feedback-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="What should SARA have done differently?"
        className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/40"
      />

      <label className="mt-3 flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-slate-300">
        <input
          type="checkbox"
          checked={consentToLearn}
          onChange={(event) => setConsentToLearn(event.target.checked)}
          className="mt-0.5 accent-cyan-400"
        />
        <span>I consent to store this feedback locally for future learning evaluation.</span>
      </label>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[10px] text-rose-200">
          <CircleAlert size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onDismiss} className="rounded-lg px-3 py-1.5 text-[10px] text-slate-400 hover:bg-white/5 hover:text-white">
          Skip
        </button>
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={!rating || !consentToLearn || submitting}
          className="flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-1.5 text-[10px] font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={12} /> {submitting ? "Saving..." : "Save feedback"}
        </button>
      </div>
    </motion.section>
  );
}
