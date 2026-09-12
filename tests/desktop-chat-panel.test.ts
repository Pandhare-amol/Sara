import test from 'node:test';
import assert from 'node:assert/strict';

import { canSendMessage } from '../src/components/desktopChatUtils';

test('desktop chat allows sending only when text is entered and not already sending', () => {
  const conversation = { id: '1', title: 'Desktop chat with SARA', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any;

  assert.equal(canSendMessage('', false, conversation), false);
  assert.equal(canSendMessage('   ', false, conversation), false);
  assert.equal(canSendMessage('hello', true, conversation), false);
  assert.equal(canSendMessage('hello', false, null), false);
  assert.equal(canSendMessage('hello', false, conversation), true);
});
