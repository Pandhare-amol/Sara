import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, Search } from "lucide-react";
import { getDesktopConversations, deleteDesktopConversation, searchDesktopConversations, DesktopConversationRecord } from "../lib/desktopConversationStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onCreateNew: () => void;
};

export function DesktopConversationsPanel({ isOpen, onClose, onOpenConversation, onCreateNew }: Props) {
  const [conversations, setConversations] = useState<DesktopConversationRecord[]>([]);
  const [searchValue, setSearchValue] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      const next = searchValue.trim()
        ? await searchDesktopConversations(searchValue)
        : await getDesktopConversations();
      setConversations(next);
    };
    load();
  }, [isOpen, searchValue]);

  const handleDelete = async (conversationId: string) => {
    await deleteDesktopConversation(conversationId);
    setConversations((prev) => prev.filter((item) => item.id !== conversationId));
  };

  const groupedConversations = useMemo<Record<string, DesktopConversationRecord[]>>(() => {
    const now = Date.now();
    const groups: Record<string, DesktopConversationRecord[]> = {
      Today: [],
      Yesterday: [],
      "Previous 7 days": [],
      Older: [],
    };

    for (const item of conversations) {
      const diffDays = Math.floor((now - new Date(item.updatedAt).getTime()) / 86400000);
      if (diffDays <= 0) groups.Today.push(item);
      else if (diffDays === 1) groups.Yesterday.push(item);
      else if (diffDays <= 7) groups["Previous 7 days"].push(item);
      else groups.Older.push(item);
    }

    return groups;
  }, [conversations]);

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 30 }}
          className="absolute inset-y-10 right-10 z-50 w-full max-w-xl rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-slate-900/90 px-6 py-4">
            <div>
              <h2 className="text-base font-semibold text-white">Desktop Conversations</h2>
              <p className="text-xs text-slate-400">Open or delete saved desktop chats.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onCreateNew}
                className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-500/15"
              >
                New Chat
              </button>
              <button onClick={onClose} className="rounded-2xl p-2 text-slate-400 hover:text-white hover:bg-white/5">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="space-y-4 p-6">
            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900 px-3 py-3 text-sm text-slate-300">
              <Search size={16} className="text-cyan-300" />
              <input
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search conversations..."
                className="w-full bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
              />
            </label>

            {Object.entries(groupedConversations).every(([, items]) => (items as DesktopConversationRecord[]).length === 0) ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-slate-400">
                No matching conversations found.
              </div>
            ) : (
              Object.entries(groupedConversations).map(([section, items]) => {
                const sectionItems = items as DesktopConversationRecord[];
                if (!sectionItems.length) return null;
                return (
                  <div key={section} className="space-y-3">
                    <div className="px-1 text-[10px] font-bold uppercase tracking-[0.28em] text-slate-500">{section}</div>
                    {sectionItems.map((item) => {
                      const lastMessage = item.messages[item.messages.length - 1];
                      const preview = lastMessage ? lastMessage.text : "New conversation";
                      return (
                        <div key={item.id} className="rounded-3xl border border-white/10 bg-slate-900/90 p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <button
                                onClick={() => onOpenConversation(item.id)}
                                className="text-left text-sm font-semibold text-white hover:text-cyan-300"
                              >
                                {item.title}
                              </button>
                              <p className="mt-2 line-clamp-2 text-xs text-slate-400">{preview}</p>
                              <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">{new Date(item.updatedAt).toLocaleString()}</p>
                            </div>
                            <button
                              onClick={() => handleDelete(item.id)}
                              className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-300 hover:bg-rose-500/15"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
