import test from 'node:test';
import assert from 'node:assert/strict';

import { canSendMessage, mergePendingVoiceTurns } from '../src/components/desktopChatUtils';
import { cacheDesktopConversation, createDesktopConversation } from '../src/lib/desktopConversationStore';

test('desktop chat allows sending only when text is entered and not already sending', () => {
  const conversation = { id: '1', title: 'Desktop chat with SARA', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any;

  assert.equal(canSendMessage('', false, conversation), false);
  assert.equal(canSendMessage('   ', false, conversation), false);
  assert.equal(canSendMessage('hello', true, conversation), false);
  assert.equal(canSendMessage('hello', false, null), false);
  assert.equal(canSendMessage('hello', false, conversation), true);
});

test('reloading the same conversation retains pending voice turns without duplicating already saved turns', () => {
  const conversation = createDesktopConversation();
  const voice = { role: 'user' as const, text: 'voice turn while chat was waiting', timestamp: new Date().toISOString() };
  assert.deepEqual(mergePendingVoiceTurns({ ...conversation, messages: [voice] }, [voice]).messages, [voice]);
  assert.deepEqual(mergePendingVoiceTurns(conversation, [voice]).messages, [voice]);
});

test('a chat response already saved by /api/chat can update the fallback cache without another HTTP POST', () => {
  const entries = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => entries.get(key) || null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  } } });
  globalThis.fetch = (async () => { fetchCalls++; throw new Error('must not POST a duplicate snapshot'); }) as typeof fetch;
  try {
    const conversation = createDesktopConversation('Existing conversation');
    cacheDesktopConversation(conversation);
    cacheDesktopConversation({ ...conversation, messages: [{ role: 'user', text: 'still saved locally', timestamp: new Date().toISOString() }] });
    assert.equal(fetchCalls, 0);
    const items = JSON.parse(entries.get('sara_desktop_conversations') || '[]');
    assert.equal(items.length, 1);
    assert.equal(items[0].messages[0].text, 'still saved locally');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
