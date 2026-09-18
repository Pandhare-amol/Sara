import { useState } from 'react';
import { LLMService } from '../services/LLMService';

/**
 * LLMStatusPanel – UI widget to invoke Gemini 1.5 Pro advanced reasoning.
 * Shows a small button in the header; clicking opens a modal where the user
 * can type a prompt. The result is displayed below, and token usage stats are
 * shown in real‑time. Uses a glass‑morphism card with subtle hover animation
 * to match the app’s premium aesthetic.
 */
export const LLMStatusPanel = () => {
  const [showModal, setShowModal] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [tokens, setTokens] = useState<{inputTokens:number;outputTokens:number}|null>(null);
  const [loading, setLoading] = useState(false);
  const llm = new LLMService(); // lightweight wrapper, creates client on each mount

  const run = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      const res = await llm.runAdvancedReasoning(prompt);
      setResponse(res);
      setTokens(llm.getTokenUsage() ?? null);
    } catch (e) {
      console.error('LLM reasoning error', e);
      setResponse('Error: ' + (e as any).message);
      setTokens(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Small badge button */}
      <button
        onClick={() => setShowModal(true)}
        className="flex items-center gap-1.5 text-xs font-mono tracking-widest cursor-pointer opacity-25 hover:opacity-100 text-white"
        title="Run Advanced Reasoning (Gemini 1.5 Pro)"
      >
        <span className="hidden sm:inline">REASON</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          className="w-4 h-4"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
        </svg>
      </button>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-xl p-6 bg-slate-900/90 border border-white/10 rounded-xl shadow-xl backdrop-blur-xl">
            <h2 className="text-lg font-semibold mb-4 text-purple-300">Advanced Reasoning (Gemini 1.5 Pro)</h2>
            <textarea
              rows={4}
              className="w-full p-2 mb-4 text-sm bg-slate-800/70 border border-white/10 rounded resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="Enter a complex prompt…"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
            />
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={run}
                disabled={loading}
                className="px-4 py-1 bg-purple-600 hover:bg-purple-500 text-sm rounded disabled:opacity-50"
              >
                {loading ? 'Thinking…' : 'Run'}
              </button>
              <button
                onClick={() => setShowModal(false)}
                className="text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
            {response && (
              <div className="mt-4 p-3 bg-slate-800/60 rounded text-sm overflow-auto max-h-60">
                <pre className="whitespace-pre-wrap">{response}</pre>
                {tokens && (
                  <div className="mt-2 text-xs text-gray-400">
                    Tokens – input: {tokens.inputTokens}, output: {tokens.outputTokens}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
