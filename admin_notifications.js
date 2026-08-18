async function callApi(path, token, opts = {}){
  const headers = opts.headers || {};
  if (token) headers['x-admin-token'] = token;
  if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return res.json().catch(async ()=> ({ ok:false, status: res.status, text: await res.text() }));
}

function el(id){return document.getElementById(id)}

el('btnLoad').addEventListener('click', async ()=>{
  const token = el('token').value;
  const r = await callApi('/api/admin/notifications', token);
  el('raw').textContent = JSON.stringify(r, null, 2);
  if (r.ok){
    const cfg = r.config || {};
    const wh = (cfg.webhook || {});
    el('wh_url').value = wh.url || '';
    el('wh_events').value = (wh.events || ['*']).join(',');
    el('wh_secret').value = wh.secret_mask || '';
    el('desktop_notify').checked = !!(cfg.desktop || false);
    el('emails').value = (cfg.emails || []).join(',');
    const smtp = cfg.smtp || {};
    el('smtp_url').value = smtp.url || '';
    el('smtp_host').value = smtp.host || '';
    el('smtp_port').value = smtp.port || '';
    el('smtp_user').value = smtp.user || '';
    el('smtp_from').value = smtp.from || '';
  }
});

el('btnSave').addEventListener('click', async ()=>{
  const token = el('token').value;
  const body = {
    notifications: {
      webhook: { url: el('wh_url').value, events: (el('wh_events').value||'*').split(',').map(s=>s.trim()), secret: el('wh_secret').value || undefined },
      desktop: !!el('desktop_notify').checked,
      emails: (el('emails').value||'').split(',').map(s=>s.trim()).filter(Boolean)
    }
  };
  // client-side validation
  if (body.notifications.webhook.url && !/^https?:\/\//i.test(body.notifications.webhook.url)) { el('raw').textContent = JSON.stringify({ ok:false, error: 'Invalid webhook URL (must start with http(s)://)' }, null, 2); return; }
  if (!Array.isArray(body.notifications.emails) || body.notifications.emails.some(e=>e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) { el('raw').textContent = JSON.stringify({ ok:false, error: 'One or more email addresses are invalid' }, null, 2); return; }
  const r = await callApi('/api/admin/notifications', token, { method: 'POST', body });
  el('raw').textContent = JSON.stringify(r, null, 2);
});

// SMTP save endpoint
async function saveSmtp(){
  const token = el('token').value;
  const body = {
    smtp: {
      url: el('smtp_url').value || undefined,
      host: el('smtp_host').value || undefined,
      port: el('smtp_port').value ? Number(el('smtp_port').value) : undefined,
      user: el('smtp_user').value || undefined,
      from: el('smtp_from').value || undefined,
      secret: el('smtp_secret').value || undefined
    }
  };
  const r = await callApi('/api/admin/notifications/smtp', token, { method: 'POST', body });
  el('raw').textContent = JSON.stringify(r, null, 2);
}

async function testSmtp(){
  const token = el('token').value;
  const r = await callApi('/api/admin/notifications/smtp/test', token, { method: 'POST' });
  el('raw').textContent = JSON.stringify(r, null, 2);
}

el('btnSaveSmtp').addEventListener('click', saveSmtp);
el('btnTestSmtp').addEventListener('click', testSmtp);

el('btnTest').addEventListener('click', async ()=>{
  const token = el('token').value;
  const r = await callApi('/api/admin/notifications/test', token, { method: 'POST' });
  el('raw').textContent = JSON.stringify(r, null, 2);
});
