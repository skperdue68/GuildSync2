import test from 'node:test';
import assert from 'node:assert/strict';
import {guildChatClearAllowed, uploadGuildChatAndMaybeClear} from './chat-upload.js';

function harness({running, commit = {ok: true, message: 'cleared'}} = {}) {
  const calls = [];
  const messages = [];

  return {
    calls,
    messages,
    options: {
      esoRunning: running,
      async upload() {
        calls.push('upload');
        return {ok: true, message: 'Guild chat processed: 2 new, 0 duplicate.'};
      },
      async clear() {
        calls.push('clear');
        return commit;
      },
      notify(messageId, message) {
        calls.push('notify');
        messages.push({messageId, message});
      }
    }
  };
}

test('guild chat uploads while ESO runs and is not cleared yet', async () => {
  const harnessed = harness({running: true});
  const outcome = await uploadGuildChatAndMaybeClear(harnessed.options);

  assert.deepEqual(harnessed.calls, ['upload', 'notify'], 'the file is left alone while ESO owns it');
  assert.equal(outcome.cleared, false);
  assert.equal(harnessed.messages[0].messageId, 'chat-data-sent');
  assert.match(harnessed.messages[0].message, /Guild chat processed: 2 new/);
  assert.match(harnessed.messages[0].message, /keeps the messages until ESO closes/);
  assert.equal(guildChatClearAllowed(true), false);
});

test('guild chat is cleared once ESO has closed', async () => {
  const harnessed = harness({running: false});
  const outcome = await uploadGuildChatAndMaybeClear(harnessed.options);

  assert.deepEqual(harnessed.calls, ['upload', 'clear', 'notify'], 'the clear waits for a confirmed upload and closed ESO');
  assert.equal(outcome.cleared, true);
  assert.equal(harnessed.messages[0].message, 'Guild chat processed: 2 new, 0 duplicate.');
  assert.equal(guildChatClearAllowed(false), true);
});

test('a failed upload never clears the SavedVariables file', async () => {
  const calls = [];

  await assert.rejects(
    uploadGuildChatAndMaybeClear({
      esoRunning: false,
      async upload() {
        calls.push('upload');
        throw new Error('GuildSync websocket is not connected.');
      },
      async clear() {
        calls.push('clear');
        return {ok: true};
      }
    }),
    /websocket is not connected/
  );

  assert.deepEqual(calls, ['upload']);
});

test('a refused clear is reported instead of ignored', async () => {
  const harnessed = harness({running: false, commit: {ok: false, message: 'ESO is currently running. Guild chat messages were not cleared yet.'}});

  await assert.rejects(uploadGuildChatAndMaybeClear(harnessed.options), /ESO is currently running/);
  assert.deepEqual(harnessed.calls, ['upload', 'clear']);
});
