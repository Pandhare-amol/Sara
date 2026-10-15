async function callApi(path, token) {
  const res = await fetch(path, { headers: { 'x-admin-token': token } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function el(id) { return document.getElementById(id); }

el('btnStatus').addEventListener('click', async () => {
  const token = el('token').value.trim();
  el('status').textContent = 'Loading admin status...';
  el('audit').textContent = 'Loading audit events...';

  const statusResponse = await callApi('/api/admin/security/status', token);
  el('raw').textContent = JSON.stringify(statusResponse.body, null, 2);
  if (statusResponse.status === 401) {
    el('status').textContent = 'Admin authorization token required or invalid.';
    el('audit').textContent = '(unauthorized)';
    return;
  }
  const status = statusResponse.body;
  el('status').textContent = status.enabled === false
    ? status.message || 'Integrity verification is disabled.'
    : `Integrity state: ${status.status || 'unknown'}`;

  const auditResponse = await callApi('/api/admin/audit/recent', token);
  if (auditResponse.status === 401) {
    el('audit').textContent = 'Admin authorization token required or invalid.';
    return;
  }
  const events = Array.isArray(auditResponse.body.events) ? auditResponse.body.events : [];
  el('audit').textContent = events.length
    ? events.map((event) => `${event.timestamp || ''} ${event.event_type || ''} (${event.severity || 'INFO'})`).join('\n')
    : 'No audit events are available.';
});
