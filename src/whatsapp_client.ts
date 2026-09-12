import { dataFile } from '../server_paths';
import fs from 'fs';
import crypto from 'crypto';
import { getIdempotencyEntry, upsertIdempotencyEntry } from '../server_state';

const WH_API_BASE = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com';
const WH_VERSION = process.env.WHATSAPP_API_VERSION || 'v17.0';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';

function messagesFile() {
  try { return dataFile('whatsapp_messages.json'); } catch { return 'data/whatsapp_messages.json'; }
}

export function loadMessages(): any[] {
  const f = messagesFile();
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return []; }
}
export function saveMessages(list: any[]) { const f = messagesFile(); try { fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf-8'); } catch {} }

export async function sendTextMessage(to: string, text: string, clientMessageId?: string) {
  if (!PHONE_ID || !TOKEN) {
    throw new Error('WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)');
  }

  // Idempotency: if a clientMessageId is provided and already present, return the existing record
  try {
    const key = clientMessageId || `wh:${crypto.createHash('sha256').update(`${to}|${text}`).digest('hex')}`;
    const existing = await getIdempotencyEntry(key);
    if (existing && existing.status === 'sent') return existing.result || existing;
    // Local file quick-check: avoid immediate duplicates: same to+text within last 30s
    const recent = loadMessages().find((m: any) => m.to === to && m.text === text && (Date.now() - (m.ts || 0)) < 30_000);
    if (recent) return recent.raw || recent;
  } catch (e) {}

  const url = `${WH_API_BASE}/${WH_VERSION}/${PHONE_ID}/messages`;
  const body: any = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  if (clientMessageId) body.client_reference = clientMessageId;

  // Retry with exponential backoff
  let attempt = 0;
  const maxAttempts = 3;
  let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const textResp = await res.text();
      let data: any = {};
      try { data = textResp ? JSON.parse(textResp) : {}; } catch { data = { raw: textResp }; }
      if (!res.ok) {
        lastErr = new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data)}`);
        throw lastErr;
      }
      // persist to messages file for idempotency/history and DB-backed idempotency
      try {
        const list = loadMessages();
        const generatedId = data?.messages?.[0]?.id || (clientMessageId || `local-${Date.now()}`);
        const entry = { id: generatedId, client_reference: clientMessageId, to, text, ts: Date.now(), raw: data };
        list.push(entry);
        saveMessages(list);
        try {
          const key = clientMessageId || `wh:${crypto.createHash('sha256').update(`${to}|${text}`).digest('hex')}`;
          await upsertIdempotencyEntry({ id: key, toolName: 'whatsappSend', args: { to, text, clientMessageId }, result: data, status: 'sent', created_at: new Date().toISOString() });
        } catch (e) {}
      } catch (e) {}
      return data;
    } catch (err: any) {
      lastErr = err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const backoff = Math.pow(2, attempt) * 250;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr || new Error('WhatsApp send failed');
}

export function persistIncomingEvent(evt: any) {
  try {
    const list = loadMessages();
    list.push({ incoming: true, ts: Date.now(), event: evt });
    saveMessages(list);
  } catch (e) {}
}
