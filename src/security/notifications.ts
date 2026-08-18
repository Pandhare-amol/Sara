import crypto from 'crypto';

export async function sendWebhook(url: string, payload: any, secret?: string) {
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      headers['X-Sara-Signature'] = `sha256=${sig}`;
    }
    // use global fetch (Node 18+ or polyfilled)
    const res = await fetch(url, { method: 'POST', body, headers, keepalive: true });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
