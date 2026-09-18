import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, MessageSquareOff, ArrowDown, ThumbsUp, ThumbsDown, Send } from "lucide-react";
import { getDesktopConversation, saveDesktopConversation, createDesktopConversation, restoreDesktopConversation, DesktopConversationRecord, DesktopChatMessage } from "../lib/desktopConversationStore";
import { canSendMessage, shouldApplyConversationResponse } from "./desktopChatUtils";
import "./DesktopChatPanel.css";

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
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<number, "positive" | "negative">>({});
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<number, string>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialLoadRef = useRef(true);
  const activeConversationIdRef = useRef<string | null>(null);

  const title = useMemo(() => conversation?.title ?? "Chat with SARA", [conversation]);

  const updateScrollState = () => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 8;
    setShowScrollToLatest(!atBottom);
  };

  const scrollToBottom = (force = false) => {
    const container = scrollRef.current;
    if (!container) return;
    const threshold = 120;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    if (force || nearBottom) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      setShowScrollToLatest(false);
    }
  };

  useEffect(() => {
    activeConversationIdRef.current = conversation?.id ?? null;
    setFeedbackByMessage({});
    setCorrectionDrafts({});
  }, [conversation?.id]);

  useEffect(() => {
    if (!messages.length) return;
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (initialLoadRef.current) {
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      initialLoadRef.current = false;
    } else if (nearBottom) {
      scrollToBottom(true);
    } else {
      setShowScrollToLatest(true);
    }
    updateScrollState();
  }, [messages.length, conversation?.id, isOpen]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => updateScrollState();
    container.addEventListener("scroll", onScroll, { passive: true });
    updateScrollState();
    return () => container.removeEventListener("scroll", onScroll);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const onVoiceTurn = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; role?: "user" | "assistant"; text?: string }>).detail;
      if (!detail?.text || detail.conversationId !== conversation?.id) return;
      const message: DesktopChatMessage = {
        role: detail.role === "user" ? "user" : "assistant",
        text: detail.text,
        timestamp: new Date().toISOString(),
      };
      setConversation((current) => current ? { ...current, messages: [...current.messages, message], updatedAt: message.timestamp } : current);
      setMessages((current) => [...current, message]);
    };
    window.addEventListener("sara.voiceConversationTurn", onVoiceTurn);
    return () => window.removeEventListener("sara.voiceConversationTurn", onVoiceTurn);
  }, [conversation?.id, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    initialLoadRef.current = true;
    (async () => {
      const loaded = initialConversationId ? await getDesktopConversation(initialConversationId) : null;
      if (!mounted) return;
      if (loaded) {
        const restored = await restoreDesktopConversation(loaded.id);
        const active = restored ?? loaded;
        setConversation(active);
        setMessages(active.messages);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("sara.conversationId", active.id);
        }
        return;
      }
      const initial = createDesktopConversation();
      setConversation(initial);
      setMessages(initial.messages);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("sara.conversationId", initial.id);
      }
      await saveDesktopConversation(initial);
    })();

    return () => {
      mounted = false;
    };
  }, [isOpen, initialConversationId]);

  const persistConversation = async (next: DesktopConversationRecord, expectedConversationId?: string | null) => {
    if (expectedConversationId && !shouldApplyConversationResponse(expectedConversationId, activeConversationIdRef.current)) {
      return;
    }
    setConversation(next);
    setMessages(next.messages);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("sara.conversationId", next.id);
    }
    await saveDesktopConversation(next);
  };

  const sendChat = async (text: string) => {
    const body = JSON.stringify({
      text,
      history: messages,
      source: "desktop",
      conversationId: conversation?.id ?? null,
      summary: conversation?.summary ?? "",
      activeContext: conversation?.activeContext ?? {},
      taskState: conversation?.taskState ?? {},
    });
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
    if (!canSendMessage(trimmed, sending, conversation)) return;

    const requestConversationId = conversation?.id ?? null;
    const userMessage: DesktopChatMessage = { role: "user", text: trimmed, timestamp: new Date().toISOString() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInputText("");
    setSending(true);

    try {
      const result = await sendChat(trimmed);
      if (!shouldApplyConversationResponse(requestConversationId, activeConversationIdRef.current)) {
        return;
      }
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
        summary: conversation?.summary || `Continuing conversation about ${trimmed.slice(0, 80) || "the current task"}.`,
        activeContext: {
          ...(conversation?.activeContext ?? {}),
          objective: conversation?.activeContext?.objective || trimmed.slice(0, 80) || "Continue from saved context",
          lastUserMessage: trimmed,
          lastUpdatedAt: new Date().toISOString(),
        },
        taskState: {
          ...(conversation?.taskState ?? {}),
          status: "in_progress",
          lastUpdatedAt: new Date().toISOString(),
        },
      };
      await persistConversation(updatedConversation, requestConversationId);
    } catch (error: any) {
      if (!shouldApplyConversationResponse(requestConversationId, activeConversationIdRef.current)) {
        return;
      }
      const assistantMessage: DesktopChatMessage = {
        role: "assistant",
        text: error?.message || "Unable to connect to SARA.",
        timestamp: new Date().toISOString(),
      };
      const updatedMessages = [...nextMessages, assistantMessage];
      const updatedConversation: DesktopConversationRecord = {
        ...conversation,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
        summary: conversation?.summary || "Conversation restored from saved state.",
        activeContext: {
          ...(conversation?.activeContext ?? {}),
          lastUpdatedAt: new Date().toISOString(),
        },
        taskState: {
          ...(conversation?.taskState ?? {}),
          status: "needs_attention",
          lastUpdatedAt: new Date().toISOString(),
        },
      };
      await persistConversation(updatedConversation, requestConversationId);
    } finally {
      setSending(false);
    }
  };

  const submitFeedback = async (index: number, feedback: "positive" | "negative") => {
    const message = messages[index];
    if (!message || message.role !== "assistant") return;
    const correctedAnswer = correctionDrafts[index]?.trim() || undefined;
    try {
      const response = await fetch("/api/learning/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation?.id,
          feedback: feedback === "positive" ? "This answer was helpful." : "This answer needs correction.",
          correctedAnswer,
          source: "desktop",
        }),
      });
      if (!response.ok) throw new Error("Feedback request failed.");
      setFeedbackByMessage((current) => ({ ...current, [index]: feedback }));
      if (feedback === "negative" && correctedAnswer) {
        setCorrectionDrafts((current) => ({ ...current, [index]: "" }));
      }
    } catch (error) {
      console.error("Failed to submit SARA feedback:", error);
    }
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 30 }}
          className="absolute inset-y-10 right-10 z-50 flex max-h-[calc(100vh-5rem)] min-h-0 w-[calc(100%-2.5rem)] max-w-2xl flex-col rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl overflow-hidden"
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
                aria-label="Open conversations"
                className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-500/15"
              >
                Conversations
              </button>
              <button onClick={onClose} aria-label="Close chat" className="rounded-2xl p-2 text-slate-400 hover:text-white hover:bg-white/5">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col bg-slate-950">
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                className="chat-messages h-full overflow-y-auto overflow-x-hidden p-6 space-y-4"
              >
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
                      <p className="whitespace-pre-line text-sm leading-6 break-words">{item.text}</p>
                      {item.role === "assistant" && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-2">
                          <button
                            type="button"
                            onClick={() => void submitFeedback(index, "positive")}
                            className={`rounded-lg p-1.5 transition ${feedbackByMessage[index] === "positive" ? "bg-emerald-500/20 text-emerald-300" : "text-slate-500 hover:bg-white/5 hover:text-emerald-300"}`}
                            aria-label="Mark answer helpful"
                            title="Mark answer helpful"
                          >
                            <ThumbsUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setFeedbackByMessage((current) => ({ ...current, [index]: "negative" }))}
                            className={`rounded-lg p-1.5 transition ${feedbackByMessage[index] === "negative" ? "bg-rose-500/20 text-rose-300" : "text-slate-500 hover:bg-white/5 hover:text-rose-300"}`}
                            aria-label="Correct this answer"
                            title="Correct this answer"
                          >
                            <ThumbsDown size={14} />
                          </button>
                          {feedbackByMessage[index] === "negative" && (
                            <div className="flex min-w-[220px] flex-1 gap-2">
                              <input
                                value={correctionDrafts[index] || ""}
                                onChange={(event) => setCorrectionDrafts((current) => ({ ...current, [index]: event.currentTarget.value }))}
                                placeholder="Add the correct answer"
                                aria-label="Correct answer"
                                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => void submitFeedback(index, "negative")}
                                disabled={!correctionDrafts[index]?.trim()}
                                className="rounded-lg bg-cyan-400 p-2 text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                                aria-label="Submit correction"
                                title="Submit correction"
                              >
                                <Send size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
              {showScrollToLatest && (
                <button
                  onClick={() => scrollToBottom(true)}
                  className="absolute bottom-4 right-4 z-10 flex items-center gap-2 rounded-full border border-cyan-400/30 bg-slate-900/90 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-200 shadow-lg transition hover:border-cyan-300/60 hover:bg-slate-800/95"
                  aria-label="Scroll to newest messages"
                >
                  <ArrowDown size={12} />
                  New messages
                </button>
              )}
            </div>

            <div className="shrink-0 border-t border-white/10 bg-slate-900/95 p-5">
              <div className="flex gap-3">
                <textarea
                  value={inputText}
                  onChange={(event) => setInputText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" && !event.shiftKey) || event.key === "NumpadEnter") {
                      event.preventDefault();
                      if (canSendMessage(inputText, sending, conversation)) {
                        void handleSend();
                      }
                    }
                  }}
                  placeholder="Type a message..."
                  aria-label="Message input"
                  className="min-h-[96px] flex-1 resize-none rounded-3xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                />
                <button
                  onClick={() => {
                    if (canSendMessage(inputText, sending, conversation)) {
                      void handleSend();
                    }
                  }}
                  disabled={!canSendMessage(inputText, sending, conversation)}
                  aria-label={sending ? "Sending message" : "Send message"}
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
