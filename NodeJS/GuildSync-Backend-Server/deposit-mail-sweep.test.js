import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {startDepositMailSweep} from './deposit-mail-sweep.js';

test('the sweep announces only releases it actually performed', async () => {
  const notices = [];
  let released = 0;
  const sweep = startDepositMailSweep({}, {release: async () => released, notify: count => notices.push(count), schedule: false});
  assert.equal(await sweep.tick(), 0);
  assert.deepEqual(notices, []);
  released = 2;
  assert.equal(await sweep.tick(), 2);
  assert.deepEqual(notices, [2]);
});

test('overlapping ticks share one release and a stopped sweep does nothing', async () => {
  let finish;
  let calls = 0;
  const notices = [];
  const sweep = startDepositMailSweep({}, {
    release: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    notify: count => notices.push(count),
    schedule: false
  });
  const first = sweep.tick();
  const second = sweep.tick();
  finish(1);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(notices, [1]);
  sweep.stop();
  assert.equal(await sweep.tick(), 0);
  assert.equal(calls, 1);
});

test('a failed release surfaces to the caller and is logged by the timer', async () => {
  const failingRelease = async () => { throw new Error('database is down'); };
  const direct = startDepositMailSweep({}, {release: failingRelease, schedule: false, log: () => {}});
  await assert.rejects(direct.tick(), /database is down/);

  const logged = [];
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  const sweep = startDepositMailSweep({}, {
    release: failingRelease,
    intervalMs: 60000,
    log: message => { logged.push(message); report(); }
  });
  await reported;
  sweep.stop();
  assert.deepEqual(logged, ['Deposit mail checkout sweep failed: database is down']);
});

test('the backend sweeps expired checkouts and tells clients a batch is available', () => {
  const source = fs.readFileSync(new URL('./guildsync-backend-server.js', import.meta.url), 'utf8');
  assert.match(source, /depositMailSweep = startDepositMailSweep\(applicationDB, \{\s*notify: \(released\) => broadcastDepositMailAvailability\(released\)/);
  const start = source.indexOf('function broadcastDepositMailAvailability(');
  assert.ok(start > 0, 'availability broadcast must exist');
  const emitted = [];
  const ctx = vm.createContext({
    io: {to(room) {
      assert.equal(room, 'GuildSyncClient');
      return {emit(event, payload) { emitted.push({event, payload}); }};
    }},
    Log() {}
  });
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  ctx.broadcastDepositMailAvailability(3);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'guildsync:deposit-mail-availability-changed');
  assert.equal(emitted[0].payload.ok, true);
  assert.equal(emitted[0].payload.released, 3);
});

test('both clients refresh availability when the sweep releases a batch', () => {
  for (const client of ['web/src', '../../GO/GuildSync-Frontend-Client/frontend/src']) {
    const source = fs.readFileSync(new URL(`./${client}/main.js`, import.meta.url), 'utf8');
    assert.match(source, /onCurrentSocket\('guildsync:deposit-mail-availability-changed', \(\) => \{\s*void refreshDepositMailAvailabilityFromBackend\(\);/);
  }
});
