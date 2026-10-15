import React, { useCallback, useEffect, useState } from 'react';

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
  const [adminToken, setAdminToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminToken.trim()) {
      setList([]);
      setError('Enter the configured admin approval key to view pending actions.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/confirm/list', {
        headers: { 'X-Admin-Token': adminToken },
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
  }, [adminToken]);

  useEffect(() => {
    if (!adminToken.trim()) {
      setList([]);
      setError('Enter the configured admin approval key to view pending actions.');
      return;
    }
    void load();
    const interval = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(interval);
  }, [adminToken, load]);

  const decide = async (id: string, approved: boolean) => {
    if (!adminToken.trim()) {
      setError('An admin approval key is required.');
      return;
    }
    setProcessingId(id);
    try {
      const response = await fetch('/api/confirm/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken,
        },
        body: JSON.stringify({ id, approved }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `Could not process the decision (${response.status}).`);
      }
      if (!approved) {
        setError('Action rejected.');
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
    <div className="fixed right-6 top-20 z-50 w-96 p-4 rounded-lg bg-slate-900/95 border border-white/10 shadow-lg text-sm text-slate-100">
      <div className="flex items-center justify-between mb-3">
        <strong>Pending action approvals</strong>
        <button onClick={onClose} className="text-xs text-slate-300">Close</button>
      </div>

      <label className="block text-xs text-slate-300 mb-1" htmlFor="sara-confirm-admin-token">
        Admin approval key (used only for this panel session)
      </label>
      <input
        id="sara-confirm-admin-token"
        type="password"
        autoComplete="off"
        value={adminToken}
        onChange={(event) => setAdminToken(event.target.value)}
        className="w-full p-2 bg-black/30 border border-white/10 rounded text-xs"
        placeholder="SARA_ADMIN_TOKEN"
      />

      {error && <div role="status" className="mt-2 text-xs text-amber-300 break-words">{error}</div>}
      {loading && <div className="mt-2 text-xs text-slate-400">Refreshing pending actions…</div>}

      <div className="space-y-2 max-h-[52vh] overflow-auto mt-3">
        {list.length === 0 && !loading && adminToken && (
          <div className="text-xs text-slate-400">No pending confirmations.</div>
        )}
        {list.map((confirmation) => {
          const args = confirmation.args || {};
          const isWhatsAppSend = confirmation.action === 'whatsapp_send';
          const recipient = String(args.phone || args.to || '');
          const exactMessage = String(args.message || args.text || '');
          return (
          <div key={confirmation.id} className="p-3 rounded bg-black/25 border border-white/5">
            <div className="font-medium break-words">{isWhatsAppSend ? 'WhatsApp message' : confirmation.action}</div>
            {confirmation.taskId && <div className="text-[10px] text-slate-500 mt-1">Task: {confirmation.taskId}</div>}
            {isWhatsAppSend ? (
              <div className="mt-2 space-y-2 text-xs">
                <div><span className="text-slate-400">Recipient:</span> <strong>+{recipient.replace(/\D/g, '')}</strong></div>
                <div>
                  <div className="text-slate-400">Exact message to send:</div>
                  <div className="mt-1 p-2 rounded bg-black/35 whitespace-pre-wrap break-words">{exactMessage}</div>
                </div>
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
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs disabled:opacity-50"
                disabled={!adminToken || processingId !== null}
              >
                {processingId === confirmation.id ? 'Processing…' : 'Approve and run'}
              </button>
              <button
                onClick={() => void decide(confirmation.id, false)}
                className="px-3 py-1.5 bg-rose-800 hover:bg-rose-700 rounded text-xs disabled:opacity-50"
                disabled={!adminToken || processingId !== null}
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
