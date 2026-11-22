import {releaseExpiredDepositMailCheckouts} from './deposit-mail-lease.js';

// An abandoned checkout should return to the pool on its own; relying on the
// next banking read would keep the batch reserved until some client asked.
export function startDepositMailSweep(db, {release = releaseExpiredDepositMailCheckouts, notify = async () => {}, intervalMs = 60000, schedule = true, log = () => {}} = {}) {
  let running = null;
  let stopped = false;
  const tick = () => {
    if (running) return running;
    running = (async () => {
      if (stopped) return 0;
      const released = Number(await release(db)) || 0;
      if (released > 0 && !stopped) await notify(released);
      return released;
    })().finally(() => { running = null; });
    return running;
  };
  const safelyTick = () => tick().catch(error => log('Deposit mail checkout sweep failed: ' + (error?.message || error)));
  let timer, initial;
  if (schedule) {
    timer = setInterval(safelyTick, intervalMs);
    timer.unref?.();
    initial = setTimeout(safelyTick, 0);
    initial.unref?.();
  }
  return {tick, stop() { stopped = true; clearInterval(timer); clearTimeout(initial); }};
}
