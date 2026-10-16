import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';

type Confirmation = {
  id: string;
  action: string;
  args?: Record<string, unknown>;
  taskId?: string | null;
  createdAt?: string;
  expiresAt: number;
};

export function ConfirmationPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Confirmation[]>([]);
  const [adminToken, setAdminToken] = useState(() => {
    try { return window.sessionStorage.getItem('sara.adminToken') || ''; } catch { return ''; }
  });
  const [adminPasskeySession, setAdminPasskeySession] = useState(() => {
    try { return window.sessionStorage.getItem('sara.adminPasskeySession') || ''; } catch { return ''; }
  });
  const hasApprovalAuth = Boolean(adminToken.trim() || adminPasskeySession.trim());
  const authHeaders = () => ({
    ...(adminToken.trim() ? { 'X-Admin-Token': adminToken } : {}),
    ...(adminPasskeySession.trim() ? { 'X-Sara-Admin-Session': adminPasskeySession } : {}),
  });
  const [loading, setLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncAdminAuth = () => {
      try {
        setAdminToken(window.sessionStorage.getItem('sara.adminToken') || '');
        setAdminPasskeySession(window.sessionStorage.getItem('sara.adminPasskeySession') || '');
      } catch { /* session storage may be unavailable */ }
    };
    window.addEventListener('sara.adminAuthChanged', syncAdminAuth);
    return () => window.removeEventListener('sara.adminAuthChanged', syncAdminAuth);
  }, []);

  const load = useCallback(async () => {
    if (!hasApprovalAuth) {
      setList([]);
      setError('Sign in with the configured admin approval key or passkey to view pending actions.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/confirm/list', {
        headers: authHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `Could not load confirmations (${response.status}).`);
      }
      setList(Array.isArray(payload.confirmations) ? payload.confirmations : []);
      setError(null);
    } catch (cause: any) {
      setError(cause?.message || 'Could not load pending confirmations.');
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [adminToken, adminPasskeySession, hasApprovalAuth]);

  useEffect(() => {
    if (!hasApprovalAuth) {
      setList([]);
      setError('Sign in with the configured admin approval key or passkey to view pending actions.');
      return;
    }
    void load();
    const interval = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(interval);
  }, [hasApprovalAuth, load]);

  const decide = async (id: string, approved: boolean) => {
    if (!hasApprovalAuth) {
      setError('Admin approval is required. Sign in with the configured key or passkey.');
      return;
    }
    setProcessingId(id);
    try {
      const response = await fetch('/api/confirm/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, approved }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `Could not process the decision (${response.status}).`);
      }
      if (!approved) {
        setError('Action rejected.');
      } else if (payload?.execResult?.action === 'email_send' && payload?.execResult?.smtpAccepted === true) {
        setError('Approval accepted. The configured SMTP server accepted the email; final recipient delivery is not verified.');
      } else if (payload?.execResult?.ok === true) {
        setError('Approval accepted. The action returned successfully.');
      } else {
        setError(payload?.execResult?.error || 'Approval accepted, but the action failed or needs manual review. Check the task status before retrying.');
      }
      await load();
    } catch (cause: any) {
      setError(cause?.message || 'Could not process this confirmation.');
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div role="dialog" aria-modal="false" aria-labelledby="sara-confirm-title" className="fixed inset-x-3 top-16 z-50 flex max-h-[calc(100vh-5rem)] w-auto flex-col overflow-hidden rounded-2xl border border-amber-300/15 bg-slate-950/95 p-4 text-sm text-slate-100 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:inset-x-auto sm:right-6 sm:top-20 sm:w-[min(28rem,calc(100vw-3rem))]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <strong id="sara-confirm-title" className="block text-sm font-semibold text-white">Pending approvals</strong>
          <span className="text-[10px] text-slate-500">Review the exact action before it runs.</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close approvals" className="rounded-lg border border-white/10 p-2 text-slate-400 transition hover:border-white/20 hover:bg-white/5 hover:text-white"><X size={15} /></button>
      </div>

      <label className="block text-xs text-slate-300 mb-1" htmlFor="sara-confirm-admin-token">
        Admin approval key (or use an active passkey session)
      </label>
      {adminPasskeySession && !adminToken && <div className="mb-1 text-[10px] text-emerald-300">Passkey approval session is active for this panel session.</div>}
      <input
        id="sara-confirm-admin-token"
        type="password"
        autoComplete="current-password"
        value={adminToken}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setAdminToken(value);
          try {
            if (value) window.sessionStorage.setItem('sara.adminToken', value);
            else window.sessionStorage.removeItem('sara.adminToken');
            window.dispatchEvent(new Event('sara.adminAuthChanged'));
          } catch { /* session storage may be unavailable */ }
        }}
        className="w-full rounded-xl border border-white/10 bg-slate-950/80 p-3 text-xs text-white placeholder:text-slate-500 transition focus:border-cyan-300/50 focus:outline-none focus:ring-2 focus:ring-cyan-300/10"
        placeholder="Enter your configured SARA admin key"
      />

      {error && <div role="status" className="mt-2 text-xs text-amber-300 break-words">{error}</div>}
      {loading && <div className="mt-2 text-xs text-slate-400">Refreshing pending actions…</div>}

      <div className="space-y-2 max-h-[52vh] overflow-auto mt-3">
        {list.length === 0 && !loading && hasApprovalAuth && (
          <div className="text-xs text-slate-400">No pending confirmations.</div>
        )}
        {list.map((confirmation) => {
          const args = confirmation.args || {};
          const isWhatsAppSend = confirmation.action === 'whatsapp_send';
          const isEmailSend = confirmation.action === 'email_send';
          const recipient = String(args.phone || args.to || '');
          const exactMessage = String(args.message || args.text || '');
          const emailBody = String(args.body || args.text || '');
          return (
          <div key={confirmation.id} className="rounded-xl border border-white/10 bg-white/[0.035] p-3 shadow-lg shadow-black/10">
            <div className="font-medium break-words">{isWhatsAppSend ? 'WhatsApp message' : isEmailSend ? 'Email message' : confirmation.action}</div>
            {confirmation.taskId && <div className="text-[10px] text-slate-500 mt-1">Task: {confirmation.taskId}</div>}
            {isWhatsAppSend ? (
              <div className="mt-2 space-y-2 text-xs">
                <div><span className="text-slate-400">Recipient:</span> <strong>+{recipient.replace(/\D/g, '')}</strong></div>
                <div>
                  <div className="text-slate-400">Exact message to send:</div>
                  <div className="mt-1 p-2 rounded bg-black/35 whitespace-pre-wrap break-words">{exactMessage}</div>
                </div>
              </div>
            ) : isEmailSend ? (
              <div className="mt-2 space-y-2 text-xs">
                <div><span className="text-slate-400">To:</span> <strong className="break-words">{recipient}</strong></div>
                <div><span className="text-slate-400">Subject:</span> <strong className="break-words">{String(args.subject || '')}</strong></div>
                <div>
                  <div className="text-slate-400">Exact email body:</div>
                  <div className="mt-1 max-h-48 overflow-auto rounded bg-black/35 p-2 whitespace-pre-wrap break-words">{emailBody}</div>
                </div>
                <p className="text-[10px] text-amber-200">Approval submits this email through configured SMTP. Final delivery to the recipient cannot be verified by SARA.</p>
              </div>
            ) : (
              <pre className="text-[10px] text-slate-300 whitespace-pre-wrap break-words pt-2">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
            <div className="text-[10px] text-slate-500 pt-1">
              Expires {new Date(confirmation.expiresAt).toLocaleTimeString()}
            </div>
            <div className="pt-2 flex gap-2">
              <button
                onClick={() => void decide(confirmation.id, true)}
                className="rounded-xl border border-emerald-300/20 bg-emerald-400/15 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasApprovalAuth || processingId !== null}
              >
                {processingId === confirmation.id ? 'Processing…' : 'Approve and run'}
              </button>
              <button
                onClick={() => void decide(confirmation.id, false)}
                className="rounded-xl border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasApprovalAuth || processingId !== null}
              >
                Reject
              </button>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
