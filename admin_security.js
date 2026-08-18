async function callApi(path, token, opts = {}){
  const headers = opts.headers || {};
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body });
  return res.json().catch(async ()=> ({ ok:false, status: res.status, text: await res.text() }));
}

function el(id){ return document.getElementById(id); }

el('btnStatus').addEventListener('click', async ()=>{
  const token = el('token').value;
  el('status').textContent = 'loading...';
  const r = await callApi('/api/admin/security/status', token);
  el('raw').textContent = JSON.stringify(r, null, 2);
  if (r.ok){
    const s = r.status || {};
    el('status').textContent = `Build: ${s.build?.application || ''} ${s.build?.version || ''} (${s.build?.build_id || ''})\nStatus: ${s.status || ''}`;
    el('audit').textContent = (s.results || []).slice(-10).map(x=>`${x.file} : ${x.ok? 'OK':'MOD'} (${x.classification||''})`).join('\n');
  } else {
    el('status').textContent = `Error: ${r.error || JSON.stringify(r)}`;
  }
});

// simple UI validation: disable actions when no token provided
function updateButtonState(){
  const has = !!el('token').value;
  el('btnStatus').disabled = !has;
  el('btnVerify').disabled = !has;
  el('btnApprove').disabled = !has;
}
el('token').addEventListener('input', updateButtonState);
updateButtonState();

el('btnVerify').addEventListener('click', async ()=>{
  const token = el('token').value;
  el('raw').textContent = 'verifying...';
  const r = await callApi('/api/admin/security/verify', token, { method: 'POST' });
  el('raw').textContent = JSON.stringify(r, null, 2);
  if (r.ok) el('status').textContent = `Verify: ${r.results.length} files checked`;
});

el('btnApprove').addEventListener('click', async ()=>{
  const token = el('token').value;
  if (!confirm('Approve current generated baseline as trusted?')) return;
  const r = await callApi('/api/admin/security/approveBaseline', token, { method: 'POST' });
  el('raw').textContent = JSON.stringify(r, null, 2);
  if (r.ok) el('status').textContent = `Approve: ${r.result}`;
});
