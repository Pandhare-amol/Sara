import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, MessageSquareOff } from "lucide-react";
import { getDesktopConversation, saveDesktopConversation, createDesktopConversation, DesktopConversationRecord, DesktopChatMessage } from "../lib/desktopConversationStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onShowConversations: () => void;
  initialConversationId?: string | null;
};

type ChatResponse = {
  text?: string;
  error?: string;
};

export function DesktopChatPanel({ isOpen, onClose, onShowConversations, initialConversationId }: Props) {
  const [conversation, setConversation] = useState<DesktopConversationRecord | null>(null);
  const [messages, setMessages] = useState<DesktopChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);

  const title = useMemo(() => conversation?.title ?? "Chat with SARA", [conversation]);

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    (async () => {
      const loaded = initialConversationId ? await getDesktopConversation(initialConversationId) : null;
      if (!mounted) return;
      if (loaded) {
        setConversation(loaded);
        setMessages(loaded.messages);
        return;
      }
      const initial = createDesktopConversation();
      setConversation(initial);
      setMessages(initial.messages);
      await saveDesktopConversation(initial);
    })();

    return () => {
      mounted = false;
    };
  }, [isOpen, initialConversationId]);

  const persistConversation = async (next: DesktopConversationRecord) => {
    setConversation(next);
    setMessages(next.messages);
    await saveDesktopConversation(next);
  };

  const sendChat = async (text: string) => {
    const body = JSON.stringify({ text, history: messages, source: "desktop" });
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: data.error || "Desktop chat failed." } as ChatResponse;
    }
    const data = await res.json();
    return { text: data.text ?? data.result ?? "" } as ChatResponse;
  };

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || !conversation) return;

    const userMessage: DesktopChatMessage = { role: "user", text: trimmed, timestamp: new Date().toISOString() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInputText("");
    setSending(true);

    try {
      const result = await sendChat(trimmed);
      if (!result.text) {
        throw new Error(result.error || "No response from SARA.");
      }
      const assistantMessage: DesktopChatMessage = { role: "assistant", text: result.text, timestamp: new Date().toISOString() };
      const updatedMessages = [...nextMessages, assistantMessage];
      const updatedConversation: DesktopConversationRecord = {
        ...conversation,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
        title: conversation.title === "Desktop chat with SARA" ? trimmed.slice(0, 40) || "Desktop chat with SARA" : conversation.title,
      };
      await persistConversation(updatedConversation);
    } catch (error: any) {
      const assistantMessage: DesktopChatMessage = {
        role: "assistant",
        text: error?.message || "Unable to connect to SARA.",
        timestamp: new Date().toISOString(),
      };
      const updatedMessages = [...nextMessages, assistantMessage];
      const updatedConversation = {
        ...conversation,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
      };
      await persistConversation(updatedConversation);
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 30 }}
          className="absolute inset-y-10 right-10 z-50 w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-slate-900/90 px-6 py-4">
            <div className="flex items-center gap-3">
              <MessageSquareOff size={20} className="text-cyan-300" />
              <div>
                <h2 className="text-base font-semibold text-white">{title}</h2>
                <p className="text-xs text-slate-400">Desktop chat panel with SARA.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onShowConversations}
                className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-500/15"
              >
                Conversations
              </button>
              <button onClick={onClose} className="rounded-2xl p-2 text-slate-400 hover:text-white hover:bg-white/5">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex h-[calc(100%-5.5rem)] flex-col bg-slate-950">
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.length === 0 ? (
                <div className="rounded-3xl border border-white/5 bg-white/5 p-8 text-center text-slate-300">
                  Start a desktop conversation with SARA.
                </div>
              ) : (
                messages.map((item, index) => (
                  <div
                    key={`${item.role}-${index}`}
                    className={`max-w-[80%] rounded-3xl p-4 ${item.role === "user" ? "ml-auto bg-cyan-500/10 text-cyan-100" : "mr-auto bg-white/5 text-slate-100"}`}
                  >
                    <p className="text-[11px] uppercase tracking-[0.25em] text-slate-400 mb-2">{item.role === "user" ? "You" : "SARA"}</p>
                    <p className="whitespace-pre-line text-sm leading-6">{item.text}</p>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-white/10 bg-slate-900/95 p-5">
              <div className="flex gap-3">
                <textarea
                  value={inputText}
                  onChange={(event) => setInputText(event.currentTarget.value)}
                  placeholder="Type a message..."
                  className="min-h-[96px] flex-1 resize-none rounded-3xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
                <button
                  onClick={handleSend}
                  disabled={!inputText.trim() || sending}
                  className="rounded-3xl bg-cyan-400 px-6 py-4 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
