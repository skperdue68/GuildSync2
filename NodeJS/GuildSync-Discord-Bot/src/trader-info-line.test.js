import test from 'node:test';
import assert from 'node:assert/strict';
import { traderInfoLine } from './trader-info-line.js';

test('the info line stamps both times, so each reader sees them locally', () => {
  assert.equal(
    traderInfoLine({ now: 1794910000, latestEntryTime: 1794900000 }),
    'As of <t:1794910000:f> — most recent GuildSync info at <t:1794900000:f>.'
  );
});

test('without a stored entry the line says so instead of stamping zero', () => {
  assert.equal(
    traderInfoLine({ now: 100, latestEntryTime: 0 }),
    'As of <t:100:f> — no GuildSync trader info is stored yet.'
  );
});

test('an unknown clock falls back to the word now rather than <t:0:f>', () => {
  assert.equal(
    traderInfoLine({ now: 0, latestEntryTime: 50 }),
    'As of now — most recent GuildSync info at <t:50:f>.'
  );
});
