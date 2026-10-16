import React, { useState } from "react";
import { Memory, MemoryCategory } from "../lib/memoryTypes";
import { 
  Brain, 
  X, 
  Trash2,
  Pencil,
  Plus, 
  User, 
  Heart, 
  Target, 
  Briefcase, 
  Users, 
  Flame, 
  Sparkles,
  RefreshCw,
  CircleAlert,
  Download,
  Save,
  Check
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { serializeMemoryExport } from "../services/memoryExport";

interface MemoryDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  memories: Memory[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAddMemory: (category: MemoryCategory, text: string, expiresAt?: string) => Promise<void>;
  onUpdateMemory: (id: string, category: MemoryCategory, text: string, expiresAt?: string) => Promise<void>;
  onConfirmMemory: (id: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  themeColor: string;
}

export function MemoryDashboard({
  isOpen,
  onClose,
  memories,
  loading = false,
  error = null,
  onRetry,
  onAddMemory,
  onUpdateMemory,
  onConfirmMemory,
  onDeleteMemory,
  themeColor
}: MemoryDashboardProps) {
  const [activeTab, setActiveTab] = useState<MemoryCategory | "all">("all");
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("identity");
  const [isAdding, setIsAdding] = useState(false);
  const [newExpiry, setNewExpiry] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");
  const [editedCategory, setEditedCategory] = useState<MemoryCategory>("identity");
  const [editedExpiry, setEditedExpiry] = useState("");
  const [savingMemoryId, setSavingMemoryId] = useState<string | null>(null);
  const [confirmingMemoryId, setConfirmingMemoryId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Category Configuration
  const categoryConfig: Record<MemoryCategory, { label: string; icon: any; color: string; bg: string }> = {
    identity: { 
      label: "Identity Core", 
      icon: User, 
      color: "text-amber-400 border-amber-500/25", 
      bg: "bg-amber-500/5 hover:bg-amber-500/10" 
    },
    preference: { 
      label: "Preferences", 
      icon: Heart, 
      color: "text-pink-400 border-pink-500/25", 
      bg: "bg-pink-500/5 hover:bg-pink-500/10" 
    },
    goal: { 
      label: "Life Goals", 
      icon: Target, 
      color: "text-emerald-400 border-emerald-500/25", 
      bg: "bg-emerald-500/5 hover:bg-emerald-500/10" 
    },
    project: { 
      label: "Active Projects", 
      icon: Briefcase, 
      color: "text-cyan-400 border-cyan-500/25", 
      bg: "bg-cyan-500/5 hover:bg-cyan-500/10" 
    },
    relationship: { 
      label: "Relationships", 
      icon: Users, 
      color: "text-purple-400 border-purple-500/25", 
      bg: "bg-purple-500/5 hover:bg-purple-500/10" 
    },
    emotional: { 
      label: "Milestones", 
      icon: Flame, 
      color: "text-red-400 border-red-500/25", 
      bg: "bg-red-500/5 hover:bg-red-500/10" 
    },
    behavior: { 
      label: "Behaviors & Habits", 
      icon: Brain, 
      color: "text-indigo-400 border-indigo-500/25", 
      bg: "bg-indigo-500/5 hover:bg-indigo-500/10" 
    },
    decision: {
      label: "Decisions",
      icon: Target,
      color: "text-orange-400 border-orange-500/25",
      bg: "bg-orange-500/5 hover:bg-orange-500/10"
    },
    question: {
      label: "Open Questions",
      icon: Sparkles,
      color: "text-sky-400 border-sky-500/25",
      bg: "bg-sky-500/5 hover:bg-sky-500/10"
    },
  };

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const safeMemories = (Array.isArray(memories) ? memories : []).filter((memory): memory is Memory => Boolean(memory && typeof memory === "object"));
  const filteredMemories = activeTab === "all"
    ? safeMemories
    : safeMemories.filter(m => m.category === activeTab);

  const expiryIso = (date: string) => date ? new Date(`${date}T23:59:59`).toISOString() : undefined;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The memory operation failed.";

  const beginEditing = (memory: Memory) => {
    setActionError(null);
    setConfirmDeleteId(null);
    setEditingMemoryId(memory.id);
    setEditedText(String(memory.text || ""));
    setEditedCategory(memory.category);
    setEditedExpiry(memory.expiresAt?.slice(0, 10) || "");
  };
  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;
    setFormError(null);
    setSubmitting(true);
    setActionError(null);
    try {
      await onAddMemory(newCategory, newText.trim(), expiryIso(newExpiry));
      setNewText("");
      setNewExpiry("");
      setIsAdding(false);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCorrection = async (id: string) => {
    setSavingMemoryId(id);
    setActionError(null);
    try {
      await onUpdateMemory(id, editedCategory, editedText.trim(), expiryIso(editedExpiry));
      setEditingMemoryId(null);
      setConfirmDeleteId(null);
    } catch (error) {
      console.error(error);
      setActionError(errorMessage(error));
    } finally {
      setSavingMemoryId(null);
    }
  };

  const handleConfirmMemory = async (id: string) => {
    setConfirmingMemoryId(id);
    setActionError(null);
    try {
      await onConfirmMemory(id);
    } catch (error) {
      console.error(error);
      setActionError(errorMessage(error));
    } finally {
      setConfirmingMemoryId(null);
    }
  };

  const handleConfirmedDelete = async (id: string) => {
    setDeletingMemoryId(id);
    setActionError(null);
    try {
      await onDeleteMemory(id);
      setConfirmDeleteId(null);
      if (editingMemoryId === id) setEditingMemoryId(null);
    } catch (error) {
      console.error(error);
      setActionError(errorMessage(error));
    } finally {
      setDeletingMemoryId(null);
    }
  };

  const handleExport = () => {
    setActionError(null);
    try {
      const blob = new Blob([serializeMemoryExport(safeMemories)], { type: "application/json;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `sara-personal-memories-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      console.error("Memory export failed:", error);
      setActionError("Unable to export memories in this browser.");
    }
  };

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return "Durable Record";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "Durable Record";
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Brain size={22} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    Sara Memory Core
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    Persistent recollect files ({memories.length})
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close Recall"
                className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Quick stats & action row */}
            <div className="px-6 py-4 bg-white/5 border-b border-white/5 flex items-center justify-between gap-2.5">
              <span className="text-[10px] text-slate-400 font-mono">
                Only memories you explicitly save or approve are used in chat. Older inferred entries need review.
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={loading || safeMemories.length === 0}
                  title="Download a JSON copy. The file contains personal memory text; store it securely."
                  aria-label="Export personal memories as JSON"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <Download size={12} />
                  <span>EXPORT</span>
                </button>
                {!isAdding && (
                  <button
                    type="button"
                    onClick={() => { setActionError(null); setIsAdding(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-xs font-mono tracking-wider text-cyan-300 transition shrink-0 cursor-pointer"
                  >
                    <Plus size={12} />
                    <span>MANUAL SEED</span>
                  </button>
                )}
              </div>
            </div>
            {actionError && (
              <div role="alert" className="mx-6 mt-3 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs font-mono text-rose-200">
                {actionError}
              </div>
            )}

            {/* Manual entry card drawer inside dashboard */}
            <AnimatePresence>
              {isAdding && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-white/15 bg-[#080812]"
                >
                  <form onSubmit={handleManualAdd} className="p-5 space-y-4">
                    <div>
                      <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                        Memory Archetype Category
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                          const Icon = categoryConfig[cat].icon;
                          const active = newCategory === cat;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setNewCategory(cat)}
                              className={`flex items-center gap-2 p-1.5 rounded-lg border text-xs tracking-wide transition cursor-pointer ${
                                active 
                                  ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                                  : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                              }`}
                            >
                              <Icon size={12} />
                              <span className="truncate">{categoryConfig[cat].label.split(" ")[0]}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                        Recollection Statement (3rd Person declarative)
                      </label>
                      <textarea
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        placeholder="e.g. The user's startup is called Sara, a voice AI platform."
                        maxLength={1000}
                        required
                        className="w-full h-18 text-xs p-3 rounded-lg border border-white/10 bg-black/40 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 resize-none font-sans"
                      />
                    </div>

                    <label className="block text-xs text-slate-300">
                      Expires on (optional)
                      <input type="date" value={newExpiry} min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setNewExpiry(e.target.value)}
                        className="block mt-1 p-2 rounded-lg bg-black/40 border border-white/10 text-white" />
                    </label>
                    {formError && <p role="alert" className="text-xs text-red-300">{formError}</p>}
                    <div className="flex gap-2.5 justify-end">
                      <button
                        type="button"
                        onClick={() => { setIsAdding(false); setFormError(null); }}
                        className="px-3.5 py-1.5 rounded-lg border border-white/5 text-xs font-mono tracking-wide text-slate-400 hover:text-white transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs uppercase font-mono tracking-widest transition disabled:opacity-50 cursor-pointer"
                      >
                        {submitting ? "Saving..." : "Commit Memory"}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            {/* TAB SELECTOR SCROLLER */}
            <div className="px-6 py-4 flex gap-1.5 overflow-x-auto no-scrollbar border-b border-light border-white/10 shrink-0">
              <button
                onClick={() => setActiveTab("all")}
                className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition cursor-pointer shrink-0 ${
                  activeTab === "all"
                    ? "border-white bg-white text-slate-950 font-bold"
                    : "border-white/5 bg-white/5 text-slate-400 hover:border-white/15"
                }`}
              >
                All Memories
              </button>
              {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                const config = categoryConfig[cat];
                const active = activeTab === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveTab(cat)}
                    className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition shrink-0 cursor-pointer ${
                      active
                        ? "border-white bg-white text-slate-950 font-bold"
                        : "border-white/5 bg-white/5 text-slate-400 hover:border-white/15"
                    }`}
                  >
                    {config.label.split(" ")[0]}
                  </button>
                );
              })}
            </div>

            {/* RECOLLECTION ITEMS CARDS CONTAINER */}
            <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-3.5" role="region" aria-label="Recalled memories">
              <AnimatePresence initial={false}>
                {loading ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex items-center justify-center p-8 text-center text-slate-400">
                    <div className="space-y-3">
                      <RefreshCw size={24} className="mx-auto animate-spin text-cyan-400" />
                      <p className="text-sm font-mono">Loading your memories...</p>
                    </div>
                  </motion.div>
                ) : error ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-400">
                    <CircleAlert size={28} className="mb-3 text-rose-400" />
                    <p className="text-sm font-mono text-rose-200">{error}</p>
                    <button onClick={onRetry} className="mt-4 rounded-lg border border-cyan-400/30 px-4 py-2 text-xs font-mono uppercase tracking-widest text-cyan-300 hover:bg-cyan-400/10" disabled={!onRetry}>
                      Retry
                    </button>
                  </motion.div>
                ) : filteredMemories.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500"
                  >
                    <div className="p-4 rounded-full border border-dashed border-white/10 bg-white/[0.02] mb-4">
                      <Brain size={32} className="opacity-40" />
                    </div>
                    <h4 className="text-sm font-semibold tracking-wide text-slate-300">No memories recorded yet</h4>
                    <p className="text-xs max-w-xs mt-1.5 leading-relaxed font-mono">
                      {activeTab === "all" 
                        ? "Add a memory explicitly, or ask Sara to remember a specific detail in voice mode. Automatic conversation storage is off by default."
                        : `No saved memories in "${categoryConfig[activeTab as MemoryCategory]?.label}". Add one to make it available for relevant chat.`}
                    </p>
                  </motion.div>
                ) : (
                  filteredMemories.map((m, index) => {
                    const cfg = categoryConfig[m.category] || categoryConfig.behavior;
                    const Icon = cfg.icon;
                    const approved = m.approvedByUser && m.source === "user_provided";
                    const expired = m.expiresAt && Date.parse(m.expiresAt) <= Date.now();

                    return (
                      <motion.div
                        key={m.id || `memory-${index}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className={`p-4 rounded-xl border border-white/5 backdrop-blur-md bg-white/[0.02] ${cfg.bg} transition-colors group relative`}
                      >
                        {editingMemoryId === m.id ? (
                          <div className="w-full space-y-3">
                            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-cyan-300">
                              <Pencil size={13} /> Correct personal memory
                            </div>
                            <div>
                              <label htmlFor={`memory-category-${m.id}`} className="block text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1.5">
                                Category
                              </label>
                              <select
                                id={`memory-category-${m.id}`}
                                value={editedCategory}
                                onChange={(event) => setEditedCategory(event.target.value as MemoryCategory)}
                                className="w-full rounded-lg border border-white/10 bg-[#0b0b14] px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500/60"
                              >
                                {(Object.keys(categoryConfig) as MemoryCategory[]).map((category) => (
                                  <option key={category} value={category}>{categoryConfig[category].label}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`memory-text-${m.id}`} className="block text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1.5">
                                Corrected text
                              </label>
                              <textarea
                                id={`memory-text-${m.id}`}
                                value={editedText}
                                onChange={(event) => setEditedText(event.target.value)}
                                maxLength={1000}
                                required
                                className="w-full min-h-24 rounded-lg border border-white/10 bg-black/40 p-3 text-xs leading-relaxed text-white focus:outline-none focus:border-cyan-500/60 resize-y"
                              />
                              <p className="mt-1 text-[9px] font-mono text-slate-500">Do not enter passwords, API keys, or tokens.</p>
                            </div>
                            <label className="block text-xs text-slate-300">Expires on (optional)
                              <input type="date" value={editedExpiry} min={new Date().toISOString().slice(0, 10)}
                                onChange={(event) => setEditedExpiry(event.target.value)}
                                className="block mt-1 p-2 rounded-lg bg-black/40 border border-white/10 text-white" />
                            </label>
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => { setEditingMemoryId(null); setActionError(null); }}
                                disabled={savingMemoryId === m.id}
                                className="px-3 py-1.5 rounded-lg border border-white/10 text-xs font-mono text-slate-300 hover:bg-white/5 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => { void handleCorrection(m.id); }}
                                disabled={savingMemoryId === m.id || !editedText.trim()}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 text-xs font-mono font-bold hover:bg-cyan-400 disabled:opacity-50"
                              >
                                <Save size={12} /> {savingMemoryId === m.id ? "Saving..." : "Save correction"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-3 w-full">
                              <div className="flex gap-3.5 overflow-hidden min-w-0">
                                <div className={`p-2 rounded-lg border mt-0.5 shrink-0 bg-black/40 ${cfg.color}`}>
                                  <Icon size={14} />
                                </div>
                                <div className="overflow-hidden min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={`text-[9px] font-mono uppercase tracking-wider block ${cfg.color}`}>
                                      {cfg.label}
                                    </span>
                                    {m.tier && (
                                      <span className="text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-cyan-300">
                                        {String(m.tier).replace("_", " ")}
                                      </span>
                                    )}
                                    {m.source && (
                                      <span className="text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-white/10 bg-black/20 text-slate-400">
                                        {String(m.source).replace(/_/g, " ")}
                                      </span>
                                    )}
                                    {(!approved || m.verificationStatus !== "verified") && (
                                      <span className="text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-amber-500/20 bg-amber-500/10 text-amber-300">
                                        Review: {m.verificationStatus ? String(m.verificationStatus).replace(/_/g, " ") : "unclassified"}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-200 mt-1 font-sans leading-relaxed break-words font-medium">
                                    {String(m.text || "No memory text available.")}
                                  </p>
                                  <span className="text-[9px] font-mono text-slate-500 mt-2 block">
                                    Saved: {formatDate(m.createdAt || m.updatedAt || "")}
                                    {m.expiresAt && ` · Expires ${formatDate(m.expiresAt)}`}
                                  </span>
                                  <span className={`text-[9px] font-mono ${approved && !expired && m.verificationStatus !== "unverified" ? "text-emerald-300" : "text-amber-300"}`}>
                                    {expired ? "Expired · not used in chat" : approved && m.verificationStatus !== "unverified" ? "User-approved · available for relevant chat" : "Legacy/inferred · review before use"}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {(!approved || m.verificationStatus !== "verified") && (
                                  <button
                                    type="button"
                                    onClick={() => { void handleConfirmMemory(m.id); }}
                                    disabled={confirmingMemoryId === m.id}
                                    aria-label="Confirm this memory is accurate and allow SARA to use it"
                                    title="Confirm this memory is accurate and allow SARA to use it"
                                    className="p-2 rounded-lg border border-emerald-500/25 bg-emerald-950/15 text-emerald-300 hover:bg-emerald-500 hover:text-white transition disabled:opacity-50 cursor-pointer"
                                  >
                                    <Check size={13} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => beginEditing(m)}
                                  aria-label="Correct this memory"
                                  title="Correct this memory"
                                  className="p-2 rounded-lg border border-white/10 bg-black/20 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200 transition cursor-pointer"
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setActionError(null); setConfirmDeleteId(m.id); }}
                                  aria-label="Ask to forget this memory"
                                  title="Forget this memory"
                                  className="p-2 rounded-lg border border-red-500/25 bg-red-950/15 text-red-400 hover:bg-red-500 hover:text-white transition cursor-pointer"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>
                            {confirmDeleteId === m.id && (
                              <div role="group" aria-label="Confirm memory deletion" className="w-full rounded-lg border border-red-500/25 bg-red-950/20 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
                                <span className="text-[10px] font-mono text-red-100">Forget this memory permanently? This cannot be undone.</span>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    disabled={deletingMemoryId === m.id}
                                    className="px-2.5 py-1 rounded-md border border-white/10 text-[10px] font-mono text-slate-300 hover:bg-white/5 disabled:opacity-50"
                                  >
                                    Keep
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { void handleConfirmedDelete(m.id); }}
                                    disabled={deletingMemoryId === m.id}
                                    className="px-2.5 py-1 rounded-md bg-red-500 text-white text-[10px] font-mono font-bold hover:bg-red-400 disabled:opacity-50"
                                  >
                                    {deletingMemoryId === m.id ? "Forgetting..." : "Confirm forget"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>

            {/* Technical visual core footprint footer */}
            <div className="p-5 border-t border-white/10 bg-black/40 flex items-center justify-between text-[9px] font-mono text-slate-600 tracking-wider">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_5px_rgba(34,211,238,0.7)] animate-pulse" />
                <span>MEM-SYNC STREAM ACTIVE</span>
              </span>
              <span>DURABLE LOCAL JSON DB SEED</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

