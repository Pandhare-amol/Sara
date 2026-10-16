import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, MessageSquareOff, ArrowDown } from "lucide-react";
import { getDesktopConversation, saveDesktopConversation, cacheDesktopConversation, createDesktopConversation, restoreDesktopConversation, DesktopConversationRecord, DesktopChatMessage } from "../lib/desktopConversationStore";
import { canSendMessage, mergePendingVoiceTurns, shouldApplyConversationResponse } from "./desktopChatUtils";
import { recentChatHistory } from "../core/context/recentChatHistory";
import { apiFetch } from "../lib/userSession";
import { readChatStream } from "../lib/chatStream";
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
  persisted?: boolean;
  savedVoiceTurns?: DesktopChatMessage[];
};

export function DesktopChatPanel({ isOpen, onClose, onShowConversations, initialConversationId }: Props) {
  const [conversation, setConversation] = useState<DesktopConversationRecord | null>(null);
  const [messages, setMessages] = useState<DesktopChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialLoadRef = useRef(true);
  const activeConversationIdRef = useRef<string | null>(null);
  const messagesRef = useRef<DesktopChatMessage[]>([]);
  const pendingVoiceTurnsRef = useRef<DesktopChatMessage[]>([]);
  const pendingVoiceConversationIdRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const sendAbortRef = useRef<AbortController | null>(null);

  // Switching/closing a conversation stops the provider request and prevents
  // a stale partial answer being written into another conversation's UI.
  useEffect(() => () => { sendAbortRef.current?.abort(); }, [conversation?.id, isOpen]);

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
      pendingVoiceConversationIdRef.current = conversation.id;
      pendingVoiceTurnsRef.current.push(message);
      const nextMessages = [...messagesRef.current, message];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setConversation((current) => current ? { ...current, messages: nextMessages, updatedAt: message.timestamp } : current);
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
        const saved = restored ?? loaded;
        const active = pendingVoiceConversationIdRef.current === saved.id
          ? mergePendingVoiceTurns(saved, pendingVoiceTurnsRef.current) : saved;
        if (pendingVoiceConversationIdRef.current !== saved.id) pendingVoiceTurnsRef.current = [];
        pendingVoiceConversationIdRef.current = saved.id;
        messagesRef.current = active.messages;
        setConversation(active);
        setMessages(active.messages);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("sara.conversationId", active.id);
        }
        return;
      }
      const initial = createDesktopConversation();
      pendingVoiceTurnsRef.current = [];
      pendingVoiceConversationIdRef.current = initial.id;
      messagesRef.current = initial.messages;
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

  const persistConversation = async (next: DesktopConversationRecord, expectedConversationId?: string | null, savedByChat = false) => {
    if (expectedConversationId && !shouldApplyConversationResponse(expectedConversationId, activeConversationIdRef.current)) return;
    messagesRef.current = next.messages;
    setConversation(next);
    setMessages(next.messages);
    if (typeof window !== "undefined") window.localStorage.setItem("sara.conversationId", next.id);
    // /api/chat has already saved the new pair and supplied voice turns. Avoid
    // immediately POSTing (and rewriting) the entire history a second time.
    if (savedByChat) cacheDesktopConversation(next);
    else await saveDesktopConversation(next);
  };

  const sendChat = async (text: string, previousMessages: DesktopChatMessage[], voiceTurns: DesktopChatMessage[], onDelta: (text: string) => void) => {
    // A very long voice session retains the existing full-snapshot fallback;
    // never silently truncate voice turns when using the incremental path.
    const voiceTurnsFit = voiceTurns.length <= 50 && voiceTurns.every((turn) => turn.text.length <= 8_000);
    const body = JSON.stringify({
      text,
      history: recentChatHistory(previousMessages),
      voiceTurns: voiceTurnsFit ? voiceTurns : [],
      source: "desktop",
      conversationId: conversation?.id ?? null,
      title: conversation?.title === "Desktop chat with SARA" ? text.slice(0, 40) : conversation?.title,
      summary: conversation?.summary ?? "",
      activeContext: {
        ...(conversation?.activeContext ?? {}),
        objective: conversation?.activeContext?.objective && conversation.activeContext.objective !== "Desktop chat with SARA"
          ? conversation.activeContext.objective : text.slice(0, 80),
        lastUserMessage: text,
      },
      taskState: conversation?.taskState ?? {},
    });
    const controller = new AbortController();
    sendAbortRef.current = controller;
    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body, signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { error: data.error || "Desktop chat failed." } as ChatResponse;
      }
      // Legacy special routes (e.g. song control) still send one JSON result.
      const data = res.headers.get("content-type")?.includes("text/event-stream")
        ? await readChatStream(res, onDelta) : await res.json();
      return { text: data.text ?? data.result ?? "",
        persisted: voiceTurnsFit && data.ok === true && data.conversationId === conversation?.id,
        savedVoiceTurns: voiceTurnsFit && data.ok === true ? voiceTurns : [],
      } as ChatResponse;
    } finally {
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!canSendMessage(trimmed, sendingRef.current, conversation)) return;
    sendingRef.current = true;
    setChatNotice(null);
    let draftMessage: DesktopChatMessage | null = null;

    const requestConversationId = conversation?.id ?? null;
    const userMessage: DesktopChatMessage = { role: "user", text: trimmed, timestamp: new Date().toISOString() };
    const previousMessages = messagesRef.current;
    const nextMessages = [...previousMessages, userMessage];
    const unsavedVoiceTurns = [...pendingVoiceTurnsRef.current];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setInputText("");
    setSending(true);

    try {
      const result = await sendChat(trimmed, previousMessages, unsavedVoiceTurns, (delta) => {
        if (!delta || !shouldApplyConversationResponse(requestConversationId, activeConversationIdRef.current)) return;
        const current = messagesRef.current;
        const index = draftMessage ? current.indexOf(draftMessage) : -1;
        if (draftMessage && index < 0) return; // switched conversations
        const nextDraft: DesktopChatMessage = { role: "assistant", text: (draftMessage?.text || "") + delta,
          timestamp: draftMessage?.timestamp || new Date().toISOString() };
        draftMessage = nextDraft;
        const next = index >= 0 ? current.map((item, i) => i === index ? nextDraft : item) : [...current, nextDraft];
        messagesRef.current = next;
        setMessages(next);
      });
      if (!shouldApplyConversationResponse(requestConversationId, activeConversationIdRef.current)) {
        return;
      }
      if (!result.text) {
        throw new Error(result.error || "No response from SARA.");
      }
      if (result.savedVoiceTurns?.length) {
        pendingVoiceTurnsRef.current = pendingVoiceTurnsRef.current.filter((turn) => !result.savedVoiceTurns?.includes(turn));
      }
      const assistantMessage: DesktopChatMessage = { role: "assistant", text: result.text, timestamp: new Date().toISOString() };
      // Voice turns may arrive mid-stream; replace only this request's draft.
      const draftIndex = draftMessage ? messagesRef.current.indexOf(draftMessage) : -1;
      const updatedMessages = draftIndex >= 0
        ? messagesRef.current.map((item, index) => index === draftIndex ? assistantMessage : item)
        : [...messagesRef.current, assistantMessage];
      const updatedConversation: DesktopConversationRecord = {
        ...conversation,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
        title: conversation.title === "Desktop chat with SARA" ? trimmed.slice(0, 40) || "Desktop chat with SARA" : conversation.title,
        summary: conversation?.summary || `Continuing conversation about ${trimmed.slice(0, 80) || "the current task"}.`,
        activeContext: {
          ...(conversation?.activeContext ?? {}),
          objective: conversation?.activeContext?.objective && conversation.activeContext.objective !== "Desktop chat with SARA"
            ? conversation.activeContext.objective : trimmed.slice(0, 80) || "Continue from saved context",
          lastUserMessage: trimmed,
          lastUpdatedAt: new Date().toISOString(),
        },
        taskState: {
          ...(conversation?.taskState ?? {}),
          // A chat reply does not imply that an automation task is in progress.
          lastUpdatedAt: new Date().toISOString(),
        },
      };
      await persistConversation(updatedConversation, requestConversationId, result.persisted === true);
    } catch (error: any) {
      if (!shouldApplyConversationResponse(requestConversationId, activeConversationIdRef.current)) return;
      // An aborted/failed stream is not an assistant reply. Remove its draft
      // and leave an explicit local notice instead of persisting a fake answer.
      if (draftMessage) {
        messagesRef.current = messagesRef.current.filter((item) => item !== draftMessage);
        setMessages(messagesRef.current);
      }
      setChatNotice(error?.name === "AbortError" ? "Response stopped. No completed answer was saved."
        : error?.message || "No completed answer was saved. You can try again.");
    } finally {
      sendingRef.current = false;
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
              {(sending || chatNotice) && (
                <div className="mb-3 flex items-center justify-between gap-2 text-xs" role={chatNotice ? "alert" : "status"}>
                  <span className={chatNotice ? "text-amber-300" : "text-cyan-200"}>
                    {chatNotice || "Waiting for or receiving provider text. Background tasks continue separately."}
                  </span>
                  {sending && <button type="button" onClick={() => sendAbortRef.current?.abort()}
                    className="shrink-0 rounded-xl border border-amber-500/40 px-3 py-2 text-amber-200 hover:bg-amber-500/10"
                    aria-label="Stop this chat response without cancelling tasks">Stop response</button>}
                </div>
              )}
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
