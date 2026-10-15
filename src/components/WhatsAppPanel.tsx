import React, { useEffect, useRef, useState } from 'react';

type Msg = {
  id?: string;
  to?: string;
  text?: string;
  ts?: number;
  incoming?: boolean;
  event?: any;
  raw?: any;
};

function incomingMessage(event: any) {
  const values = Array.isArray(event?.entry) ? event.entry : [];
  for (const entry of values) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (Array.isArray(value?.messages) && value.messages[0]) return value.messages[0];
    }
  }
  return undefined;
}

function getRecipient(message: Msg): string {
  const source = incomingMessage(message.event);
  return String(message.to || message.event?.from || message.event?.sender?.id || source?.from || '').trim();
}

function getMessageText(message: Msg): string {
  const source = incomingMessage(message.event);
  return String(message.text || message.event?.text?.body || source?.text?.body || source?.button?.text || '');
}

export function WhatsAppPanel({ onClose }: { onClose?: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const sendLocks = useRef(new Set<string>());

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/history');
      const data = await res.json();
      setMessages(Array.isArray(data?.messages) ? data.messages.reverse() : []);
    } catch (error) {
      console.error('Failed to load WhatsApp history', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const sendApprovedMessage = async (to: string, message: string, id?: string) => {
    const recipient = to.replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(recipient)) {
      window.alert('This message does not have a valid recipient number. Check the incoming message details.');
      return;
    }
    const exactMessage = message.trim();
    if (!exactMessage) return;

    const key = id || `${recipient}:${exactMessage}`;
    if (sendLocks.current.has(key)) return;
    sendLocks.current.add(key);
    setSending((current) => ({ ...current, [key]: true }));
    try {
      const approved = window.confirm(
        `Send this WhatsApp message now?\n\nRecipient: +${recipient}\n\nExact message:\n${exactMessage}`,
      );
      if (!approved) return;

      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipient, text: exactMessage, confirmed: true }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        await load();
      } else {
        window.alert(data?.error || 'WhatsApp message was not sent.');
      }
    } catch (error) {
      console.error('WhatsApp send failed', error);
      window.alert('Could not send the WhatsApp message. Check your connection and message history before trying again.');
    } finally {
      sendLocks.current.delete(key);
      setSending((current) => ({ ...current, [key]: false }));
    }
  };

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, width: 420, maxHeight: '70vh', background: 'white', boxShadow: '0 6px 18px rgba(0,0,0,0.12)', borderRadius: 8, overflow: 'auto', zIndex: 9999, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>WhatsApp</strong>
        <div>
          <button onClick={() => void load()} style={{ marginRight: 8 }}>Refresh</button>
          <button onClick={() => onClose?.()}>Close</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>
        {loading ? 'Loading...' : `${messages.length} messages`}
        <div style={{ marginTop: 4, color: '#666' }}>Every send asks you to review the recipient and exact message first.</div>
      </div>
      <div>
        {messages.map((item, index) => {
          const key = String(item.id || index);
          const recipient = getRecipient(item);
          const text = getMessageText(item);
          const quickReplyKey = item.id || `${recipient}:Thanks — I received your message.`;
          return (
            <div key={key} style={{ padding: 8, borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#666' }}>{item.incoming ? 'Incoming' : 'Outgoing'} • {recipient}</div>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text || JSON.stringify(item.event)}</div>
                {item.incoming && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      disabled={Boolean(sending[quickReplyKey])}
                      onClick={() => void sendApprovedMessage(recipient, 'Thanks — I received your message.', quickReplyKey)}
                    >Send quick reply</button>
                    <button
                      disabled={Boolean(sending[quickReplyKey])}
                      onClick={() => void sendApprovedMessage(recipient, "I'll check on that and get back to you shortly.", quickReplyKey)}
                      style={{ marginLeft: 6 }}
                    >Send detailed reply</button>
                  </div>
                )}
              </div>
              <div style={{ width: 80, flexShrink: 0, textAlign: 'right', fontSize: 11, color: '#888' }}>
                {item.ts ? new Date(item.ts).toLocaleString() : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default WhatsAppPanel;
