import { sendWebhook } from './notifications';
import path from 'path';
import fs from 'fs';
import { dataFile } from '../../server_paths';

export async function sendEmail(to: string[], subject: string, text: string, smtpConfig?: any) {
  try {
    let nodemailer: any;
    try { const mod = await import('nodemailer'); nodemailer = (mod && (mod as any).default) ? (mod as any).default : mod; } catch (e) { return { ok: false, reason: 'nodemailer_not_installed' }; }

    // Accept SMTP URLs, nodemailer transport objects, and the app's {url, from,
    // auth} wrapper. Parse URL transports so the keytar-backed auth and sender
    // settings are not silently discarded.
    let transporter: any;
    const configObject = smtpConfig && typeof smtpConfig === 'object' ? smtpConfig : {};
    const smtpUrl = typeof smtpConfig === 'string' ? smtpConfig : String(configObject.url || '');
    const envUrl = !smtpUrl && !(smtpConfig && typeof smtpConfig === 'object')
      ? process.env.SARA_SMTP_URL || process.env.SMTP_URL || ''
      : '';
    const transportUrl = smtpUrl || envUrl;
    let authenticatedUser = "";
    if (transportUrl) {
      const parsed = new URL(transportUrl);
      if (!["smtp:", "smtps:"].includes(parsed.protocol) || !parsed.hostname) {
        return { ok: false, reason: 'invalid_smtp_url' };
      }
      const configuredAuth = configObject.auth && typeof configObject.auth === 'object' ? configObject.auth : {};
      const urlUser = parsed.username ? decodeURIComponent(parsed.username) : '';
      const urlPass = parsed.password ? decodeURIComponent(parsed.password) : '';
      const user = String(configuredAuth.user || urlUser || '');
      const pass = String(configuredAuth.pass || urlPass || '');
      authenticatedUser = user;
      const port = Number(parsed.port || (parsed.protocol === 'smtps:' ? 465 : 587));
      transporter = nodemailer.createTransport({
        host: parsed.hostname,
        port: Number.isInteger(port) && port > 0 ? port : 587,
        secure: parsed.protocol === 'smtps:' || port === 465,
        ...(user || pass ? { auth: { user: user || undefined, pass: pass || undefined } } : {}),
        connectionTimeout: Number(configObject.connectionTimeout) || 10_000,
        socketTimeout: Number(configObject.socketTimeout) || 20_000,
      });
    } else if (smtpConfig && typeof smtpConfig === 'object') {
      transporter = nodemailer.createTransport(smtpConfig);
    } else {
      return { ok: false, reason: 'smtp_not_configured' };
    }

    const from = configObject.from || process.env.SARA_SMTP_FROM || configObject.auth?.user || authenticatedUser || 'sara@example.local';
    const res = await transporter.sendMail({ from, to: to.join(','), subject, text });
    return { ok: true, info: res };
  } catch (e:any) { return { ok: false, error: String(e) }; }
}

export async function sendDesktopNotification(title: string, message: string) {
  // Prefer Electron-native notify endpoint when available (backend->electron IPC)
  try {
    const notifyUrl = process.env.SARA_ELECTRON_NOTIFY_URL || 'http://127.0.0.1:43123/_electron_notify';
    const token = process.env.SARA_ELECTRON_NOTIFY_TOKEN || '';
    try {
      const body = JSON.stringify({ title, message });
      const res = await fetch(notifyUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Sara-Notify-Token': token }, keepalive: true });
      if (res.ok) return { ok: true, via: 'electron', status: res.status };
    } catch (e) {
      // fall through to node-notifier
    }

    // Fallback to node-notifier
    let notifier: any;
    try { const mod = await import('node-notifier'); notifier = (mod && (mod as any).default) ? (mod as any).default : mod; } catch (e) { return { ok: false, reason: 'node-notifier-not-installed' }; }
    return new Promise((resolve) => {
      notifier.notify({ title, message }, (err: any, res: any) => {
        if (err) resolve({ ok: false, error: String(err) }); else resolve({ ok: true, via: 'node-notifier', res });
      });
    });
  } catch (e:any) { return { ok: false, error: String(e) }; }
}

export async function sendNotifications(config: any, payload: any) {
  const results: any = { webhook: null, email: null, desktop: null };
  try {
    if (config?.webhook?.url) {
      try { results.webhook = await sendWebhook(config.webhook.url, payload, config.webhook.secret || undefined); } catch (e) { results.webhook = { ok: false, error: String(e) }; }
    }
    if (Array.isArray(config?.emails) && config.emails.length) {
      try { results.email = await sendEmail(config.emails, `SARA Notification: ${payload.event || 'ALERT'}`, JSON.stringify(payload, null, 2)); } catch (e) { results.email = { ok: false, error: String(e) }; }
    }
    if (config?.desktop) {
      try { results.desktop = await sendDesktopNotification('SARA', `${payload.event || 'Notification'} @ ${new Date().toISOString()}`); } catch (e) { results.desktop = { ok: false, error: String(e) }; }
    }
  } catch (e:any) { return { ok:false, error: String(e) }; }
  return results;
}

export default { sendEmail, sendDesktopNotification, sendNotifications };
