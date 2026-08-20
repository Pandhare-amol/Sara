import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { getDesktopConversations, deleteDesktopConversation, DesktopConversationRecord } from "../lib/desktopConversationStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onCreateNew: () => void;
};

export function DesktopConversationsPanel({ isOpen, onClose, onOpenConversation, onCreateNew }: Props) {
  const [conversations, setConversations] = useState<DesktopConversationRecord[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      setConversations(await getDesktopConversations());
    };
    load();
  }, [isOpen]);

  const handleDelete = async (conversationId: string) => {
    await deleteDesktopConversation(conversationId);
    setConversations((prev) => prev.filter((item) => item.id !== conversationId));
  };

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

          <div className="space-y-3 p-6">
            {conversations.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-slate-400">
                No desktop conversations saved yet.
              </div>
            ) : (
              conversations.map((item) => (
                <div key={item.id} className="rounded-3xl border border-white/10 bg-slate-900/90 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <button
                        onClick={() => onOpenConversation(item.id)}
                        className="text-left text-sm font-semibold text-white hover:text-cyan-300"
                      >
                        {item.title}
                      </button>
                      <p className="mt-2 text-xs text-slate-500">Updated {new Date(item.updatedAt).toLocaleString()}</p>
                    </div>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-rose-300 hover:bg-rose-500/15"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
