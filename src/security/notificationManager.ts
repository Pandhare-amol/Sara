import { sendWebhook } from './notifications';
import path from 'path';
import fs from 'fs';
import { dataFile } from '../../server_paths';

export async function sendEmail(to: string[], subject: string, text: string, smtpConfig?: any) {
  try {
    let nodemailer: any;
    try { const mod = await import('nodemailer'); nodemailer = (mod && (mod as any).default) ? (mod as any).default : mod; } catch (e) { return { ok: false, reason: 'nodemailer_not_installed' }; }

    // smtpConfig can be a URL/string or an object transporter config
    let transporter: any;
    if (typeof smtpConfig === 'string' && smtpConfig.length) {
      transporter = nodemailer.createTransport(smtpConfig);
    } else if (smtpConfig && typeof smtpConfig === 'object') {
      transporter = nodemailer.createTransport(smtpConfig);
    } else {
      const envUrl = process.env.SARA_SMTP_URL || process.env.SMTP_URL || '';
      if (!envUrl) return { ok: false, reason: 'smtp_not_configured' };
      transporter = nodemailer.createTransport(envUrl);
    }

    const from = smtpConfig?.from || process.env.SARA_SMTP_FROM || 'sara@example.local';
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
