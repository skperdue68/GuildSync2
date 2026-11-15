import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEventsOn} from './desktop-events.mjs';

test('Wails 3 event envelopes deliver original OAuth, watcher and hotkey payloads', () => {
  for (const payload of ['denied', {logged_in:true}, {key:'banking'}, {shortcut:'Ctrl+M'}, ['a','b'], null]) {
    let listener;
    const unsubscribe = () => {};
    const events = {On(name, callback) {assert.equal(name,'update'); listener=callback; return unsubscribe;}};
    let received;
    const off = createEventsOn(events)('update', data => {received=data;});
    listener({name:'update',data:payload});
    assert.deepEqual(received,payload);
    assert.equal(off,unsubscribe);
  }
});
