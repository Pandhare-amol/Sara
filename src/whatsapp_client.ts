import { dataFile } from '../server_paths';
import fs from 'fs';
import crypto from 'crypto';
import { getIdempotencyEntry, upsertIdempotencyEntry } from '../server_state';

const WH_API_BASE = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com';
const WH_VERSION = process.env.WHATSAPP_API_VERSION || 'v17.0';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const MESSAGE_TIMEOUT_MS = 20_000;

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

export function normalizeWhatsAppRecipient(to: unknown): string {
  const raw = String(to ?? '').trim();
  if (!raw || !/^\+?[0-9\s().-]+$/.test(raw)) {
    throw new WhatsAppSendError('Recipient must be a phone number with an optional leading +.', 'INVALID_RECIPIENT');
  }
  const digits = raw.replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new WhatsAppSendError('Recipient must contain 8 to 15 digits, including the country code.', 'INVALID_RECIPIENT');
  }
  return digits;
}

export function validateWhatsAppText(text: unknown): string {
  const message = String(text ?? '').trim();
  if (!message) throw new WhatsAppSendError('Message text cannot be empty.', 'EMPTY_MESSAGE');
  if (message.length > 4096) throw new WhatsAppSendError('Message text exceeds the 4096-character limit.', 'MESSAGE_TOO_LONG');
  if (message.includes('\0')) throw new WhatsAppSendError('Message text contains an invalid character.', 'INVALID_MESSAGE');
  return message;
}

function messagesFile() {
  try { return dataFile('whatsapp_messages.json'); } catch { return 'data/whatsapp_messages.json'; }
}

export function loadMessages(): any[] {
  const f = messagesFile();
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return []; }
}
export function saveMessages(list: any[]) { const f = messagesFile(); try { fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf-8'); } catch {} }

export async function sendTextMessage(to: string, text: string, clientMessageId?: string) {
  const recipient = normalizeWhatsAppRecipient(to);
  const message = validateWhatsAppText(text);
  if (!PHONE_ID || !TOKEN) {
    throw new WhatsAppSendError('WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)', 'CREDENTIALS_MISSING');
  }

  const requestId = String(clientMessageId || '').trim();
  const key = requestId
    ? `wh:${requestId}`
    : `wh:${crypto.createHash('sha256').update(`${recipient}|${message}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`).digest('hex')}`;
  const existing = await getIdempotencyEntry(key);
  if (existing?.status === 'sent') return existing.result || existing;
  if (existing?.status === 'pending' || existing?.status === 'uncertain') {
    throw new WhatsAppSendError(
      'A previous send attempt may already have reached WhatsApp. Check the conversation before trying again.',
      'WHATSAPP_SEND_UNCERTAIN',
      true,
    );
  }

  // Persist a send reservation before contacting the provider. If SARA exits or
  // the network fails mid-request, the same task ID cannot silently send twice.
  await upsertIdempotencyEntry({
    id: key,
    toolName: 'whatsappSend',
    args: { to: recipient, text: message },
    result: { state: 'pending' },
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  const url = `${WH_API_BASE}/${WH_VERSION}/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: message },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESSAGE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const textResp = await res.text();
    let data: any = {};
    try { data = textResp ? JSON.parse(textResp) : {}; } catch { data = { raw: textResp }; }

    if (!res.ok) {
      const safeDetails = JSON.stringify(data).replaceAll(TOKEN, '[REDACTED]');
      const errorMessage = `WhatsApp API error ${res.status}: ${safeDetails}`;
      const uncertain = res.status >= 500;
      await upsertIdempotencyEntry({
        id: key,
        toolName: 'whatsappSend',
        args: { to: recipient, text: message },
        result: { error: errorMessage },
        status: uncertain ? 'uncertain' : 'failed',
        created_at: new Date().toISOString(),
      });
      throw new WhatsAppSendError(
        uncertain
          ? `${errorMessage} The send outcome is unknown; check WhatsApp before retrying.`
          : errorMessage,
        uncertain ? 'WHATSAPP_SEND_UNCERTAIN' : 'WHATSAPP_PROVIDER_REJECTED',
        uncertain,
      );
    }

    // Persist successful provider acknowledgement before best-effort local history
    // writes, so a local disk error cannot trigger an accidental duplicate send.
    await upsertIdempotencyEntry({
      id: key,
      toolName: 'whatsappSend',
      args: { to: recipient, text: message },
      result: data,
      status: 'sent',
      created_at: new Date().toISOString(),
    });
    try {
      const list = loadMessages();
      const generatedId = data?.messages?.[0]?.id || requestId || `local-${Date.now()}`;
      list.push({ id: generatedId, client_reference: requestId || undefined, to: recipient, text: message, ts: Date.now(), raw: data });
      saveMessages(list);
    } catch {}
    return data;
  } catch (error: any) {
    if (error instanceof WhatsAppSendError) throw error;
    const reason = error?.name === 'AbortError' ? 'request timed out' : 'network failure';
    await upsertIdempotencyEntry({
      id: key,
      toolName: 'whatsappSend',
      args: { to: recipient, text: message },
      result: { error: reason },
      status: 'uncertain',
      created_at: new Date().toISOString(),
    });
    throw new WhatsAppSendError(
      `WhatsApp send outcome is unknown after a ${reason}. Check the conversation before retrying.`,
      'WHATSAPP_SEND_UNCERTAIN',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function persistIncomingEvent(evt: any) {
  try {
    const list = loadMessages();
    list.push({ incoming: true, ts: Date.now(), event: evt });
    saveMessages(list);
  } catch (e) {}
}
