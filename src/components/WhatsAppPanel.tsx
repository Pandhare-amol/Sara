import React, { useEffect, useState } from 'react';

type Msg = {
  id?: string;
  to?: string;
  text?: string;
  ts?: number;
  incoming?: boolean;
  event?: any;
  raw?: any;
};

export function WhatsAppPanel({ onClose }: { onClose?: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/history');
      const data = await res.json();
      setMessages(Array.isArray(data?.messages) ? data.messages.reverse() : []);
    } catch (e) {
      console.error('Failed to load whatsapp history', e);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const sendSuggestion = async (to: string, suggestion: string, id?: string) => {
    setSending((s) => ({ ...s, [id || suggestion]: true }));
    try {
      const res = await fetch('/api/whatsapp/send_suggestion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, suggestion }) });
      const data = await res.json();
      if (data?.ok) {
        await load();
      } else {
        console.warn('send_suggestion failed', data);
      }
    } catch (e) { console.error(e); }
    setSending((s) => ({ ...s, [id || suggestion]: false }));
  };

  const queueSend = async (to: string, suggestion: string) => {
    setSending((s) => ({ ...s, [`q-${to}`]: true }));
    try {
      const res = await fetch('/api/whatsapp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text: suggestion }) });
      const data = await res.json();
      if (data?.ok) await load();
    } catch (e) { console.error(e); }
    setSending((s) => ({ ...s, [`q-${to}`]: false }));
  };

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, width: 420, maxHeight: '70vh', background: 'white', boxShadow: '0 6px 18px rgba(0,0,0,0.12)', borderRadius: 8, overflow: 'auto', zIndex: 9999, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>WhatsApp</strong>
        <div>
          <button onClick={load} style={{ marginRight: 8 }}>Refresh</button>
          <button onClick={() => onClose && onClose()}>Close</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>{loading ? 'Loading...' : `${messages.length} messages`}</div>
      <div>
        {messages.map((m, idx) => (
          <div key={String(m.id||idx)} style={{ padding: 8, borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#666' }}>{m.incoming ? 'Incoming' : 'Outgoing'} • {m.to || (m.event?.from || m.event?.sender?.id) || ''}</div>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{m.text || m.event?.text?.body || JSON.stringify(m.event)}</div>
              <div style={{ marginTop: 6 }}>
                {/* quick suggestion helpers */}
                {m.incoming && (
                  <>
                    <button disabled={Boolean(sending[m.id||idx])} onClick={() => sendSuggestion(String(m.to || (m.event?.from || m.event?.sender?.id || '')), `Thanks — I received your message.`, m.id)}>Suggest</button>
                    <button disabled={Boolean(sending[m.id||idx])} onClick={() => sendSuggestion(String(m.to || (m.event?.from || m.event?.sender?.id || '')), `I'll check on that and get back to you shortly.`, m.id)} style={{ marginLeft: 6 }}>Suggest (detailed)</button>
                    <button disabled={Boolean(sending[`q-${m.to}`])} onClick={() => queueSend(String(m.to || (m.event?.from || m.event?.sender?.id || '')), `Thanks — I received your message.`)} style={{ marginLeft: 6 }}>Queue Send</button>
                  </>
                )}
              </div>
            </div>
            <div style={{ width: 80, textAlign: 'right', fontSize: 11, color: '#888' }}>{m.ts ? new Date(m.ts).toLocaleString() : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default WhatsAppPanel;
