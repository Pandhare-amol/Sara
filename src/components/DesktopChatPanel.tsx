import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, MessageSquare, ArrowDown, Send } from "lucide-react";
import { getDesktopConversation, saveDesktopConversation, createDesktopConversation, restoreDesktopConversation, DesktopConversationRecord, DesktopChatMessage } from "../lib/desktopConversationStore";
import { canSendMessage, shouldApplyConversationResponse } from "./desktopChatUtils";
import "./DesktopChatPanel.css";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onShowConversations: () => void;
  initialConversationId?: string | null;
  variant?: "quick" | "desktop";
};

type ChatResponse = {
  text?: string;
  error?: string;
};

export function DesktopChatPanel({ isOpen, onClose, onShowConversations, initialConversationId, variant = "desktop" }: Props) {
  const isQuickChat = variant === "quick";
  const [conversation, setConversation] = useState<DesktopConversationRecord | null>(null);
  const [messages, setMessages] = useState<DesktopChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialLoadRef = useRef(true);
  const activeConversationIdRef = useRef<string | null>(null);

  const title = useMemo(() => conversation?.title ?? "Chat with SARA", [conversation]);

  const starterQuestions = [
    { label: "Plan my day", prompt: "Help me plan my priorities for today. Ask me one question at a time." },
    { label: "What can SARA do?", prompt: "What can you help me do right now? Be clear about what you can and cannot do." },
    { label: "AGI vs ASI", prompt: "Explain current AI, AGI, and ASI in plain language. Does SARA actually have AGI or ASI?" },
    { label: "Think it through", prompt: "Help me think through a problem by asking me one clear question at a time." },
  ];
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const useStarterQuestion = (prompt: string) => {
    setInputText(prompt);
    inputRef.current?.focus();
  };

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
      let conversationToRestore = initialConversationId || null;
      if (!conversationToRestore && isQuickChat) {
        try { conversationToRestore = window.localStorage.getItem("sara.conversationId"); } catch { /* local history is optional */ }
      }
      const loaded = conversationToRestore ? await getDesktopConversation(conversationToRestore) : null;
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
  }, [isOpen, initialConversationId, isQuickChat]);

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
      history: messages.slice(-20),
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

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          role="dialog"
          aria-modal="false"
          aria-label={isQuickChat ? "Quick text chat with SARA" : "Desktop chat with SARA"}
          initial={{ opacity: 0, x: 24, scale: isQuickChat ? 0.98 : 1 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24, scale: isQuickChat ? 0.98 : 1 }}
          className={`${isQuickChat
            ? "fixed right-4 top-16 z-50 flex max-h-[calc(100vh-5.5rem)] min-h-0 w-[calc(100%-2rem)] max-w-md flex-col rounded-3xl border border-cyan-300/15 bg-slate-950/95 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:right-8 sm:top-20"
            : "absolute inset-y-10 right-10 z-50 flex max-h-[calc(100vh-5rem)] min-h-0 w-[calc(100%-2.5rem)] max-w-2xl flex-col rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl"} overflow-hidden`}
        >
          <div className={`flex items-center justify-between gap-3 border-b border-white/10 bg-slate-900/90 ${isQuickChat ? "px-4 py-3" : "px-6 py-4"}`}>
            <div className="flex min-w-0 items-center gap-3">
              <MessageSquare size={18} className="shrink-0 text-cyan-300" />
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-white">{isQuickChat ? "Quick chat with SARA" : title}</h2>
                <p className="text-[10px] text-slate-400">{isQuickChat ? "Fast, private text replies" : "Desktop conversation with SARA"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onShowConversations}
                aria-label="Open conversations"
                className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200 transition hover:bg-cyan-500/15"
              >
                {isQuickChat ? "History" : "Conversations"}
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
                className={`chat-messages h-full overflow-y-auto overflow-x-hidden space-y-4 ${isQuickChat ? "p-4" : "p-6"}`}
                aria-live="polite"
              >
                {messages.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-gradient-to-br from-cyan-400/[0.07] to-indigo-400/[0.04] p-5 text-center text-slate-300">
                    <MessageSquare size={21} className="mx-auto mb-3 text-cyan-300" />
                    <p className="text-sm font-medium text-white">Hi, I’m SARA. What would be useful today?</p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
                      {isQuickChat ? "Pick a question or type your own. I’ll answer here in text." : "Choose an opener to start, or ask me about a task, idea, or question."}
                    </p>
                    <div role="group" aria-label="Conversation starter questions" className="mt-4 flex flex-wrap justify-center gap-2">
                      {starterQuestions.map((starter) => (
                        <button
                          key={starter.label}
                          type="button"
                          onClick={() => useStarterQuestion(starter.prompt)}
                          aria-label={`Add starter question: ${starter.prompt}`}
                          className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.06] px-3 py-2 text-[10px] font-medium text-cyan-100 transition hover:border-cyan-200/40 hover:bg-cyan-300/10 focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
                        >
                          {starter.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 text-[10px] text-slate-500">Questions are only drafted here; nothing is sent until you press Send.</p>
                  </div>
                ) : (
                  messages.map((item, index) => (
                    <div
                      key={`${item.role}-${index}`}
                      className={`max-w-[80%] rounded-3xl p-4 ${item.role === "user" ? "ml-auto bg-cyan-500/10 text-cyan-100" : "mr-auto bg-white/5 text-slate-100"}`}
                    >
                      <p className="text-[11px] uppercase tracking-[0.25em] text-slate-400 mb-2">{item.role === "user" ? "You" : "SARA"}</p>
                      <p className="whitespace-pre-line text-sm leading-6 break-words">{item.text}</p>
                    </div>
                  ))
                )}
                {sending && (
                  <div role="status" aria-live="polite" className="mr-auto flex max-w-[85%] items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-xs text-slate-300">
                    <span className="font-semibold text-cyan-200">SARA</span>
                    <span className="flex items-center gap-1" aria-label="SARA is preparing a text reply">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-300 [animation-delay:-0.2s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-300 [animation-delay:-0.1s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-300" />
                    </span>
                    <span className="sr-only">Preparing a text reply</span>
                  </div>
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

            <div className={`shrink-0 border-t border-white/10 bg-slate-900/95 ${isQuickChat ? "p-3" : "p-5"}`}>
              <div className="flex gap-2.5">
                <textarea
                  ref={inputRef}
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
                  className={`${isQuickChat ? "min-h-[72px]" : "min-h-[96px]"} flex-1 resize-none rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/20`}
                />
                <button
                  onClick={() => {
                    if (canSendMessage(inputText, sending, conversation)) {
                      void handleSend();
                    }
                  }}
                  disabled={!canSendMessage(inputText, sending, conversation)}
                  aria-label={sending ? "Sending message" : "Send message"}
                  className="inline-flex min-w-20 items-center justify-center gap-2 self-stretch rounded-2xl bg-cyan-300 px-4 py-3 text-xs font-bold text-slate-950 shadow-lg shadow-cyan-950/20 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send size={14} />
                  <span>{sending ? "Sending…" : "Send"}</span>
                </button>
              </div>
              <p className="mt-2 px-1 text-[10px] text-slate-500">Enter to send <span className="px-1 text-slate-700">·</span> Shift+Enter for a new line</p>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
