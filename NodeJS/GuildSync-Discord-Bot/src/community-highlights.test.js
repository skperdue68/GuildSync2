import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestCommunityHighlights, formatCommunityHighlights } from './community-highlights.js';
import { highlightsDigestDue, startCommunityHighlightsAnnouncements } from './community-highlights-announcements.js';

const report = {
  overview: [{ label: 'Current ESO members', value: 120 }],
  traderLatestAt: 1795305600,
  highlights: [
    { id: 'trader-sales', title: 'Market Moguls (current 50/50 raffle, Top 5)', unit: 'gold', hideValue: true, rows: [{ name: 'Alice' }, { name: 'Bob' }] },
    { id: 'trader-items', title: 'Pack Mules (current 50/50 raffle, Top 5)', unit: 'items', rows: [{ name: 'Bob', value: 40 }, { name: 'Alice', value: 7 }] },
    { id: 'discord-posts', title: 'Most Posts', unit: 'posts', rows: [] }
  ]
};

test('the digest lists names without gold and keeps visible totals with their unit', () => {
  const content = formatCommunityHighlights(report);
  assert.match(content, /Community Highlights/);
  assert.match(content, /Current ESO members: 120/);
  const goldSection = content.split('**Pack Mules')[0];
  assert.match(goldSection, /Market Moguls/);
  assert.ok(goldSection.includes('Alice\nBob'), 'the gold card lists names only');
  assert.doesNotMatch(goldSection, /Alice — /);
  assert.match(content, /Bob — 40 items/);
  // A card with no rows is left out instead of adding an empty heading.
  assert.ok(!content.includes('Most Posts'));
});

test('the digest stays inside one Discord message', () => {
  const long = { highlights: Array.from({ length: 200 }, (_, index) => ({
    id: 'card-' + index, title: 'Card ' + index, unit: 'items', rows: [{ name: 'Member ' + index, value: index }]
  })) };
  const content = formatCommunityHighlights(long);
  assert.ok(content.length <= 1900, 'content is truncated to a sendable length');
  assert.ok(content.endsWith('…'));
});

test('a highlights request needs a connected socket and an accepted report', async () => {
  await assert.rejects(() => requestCommunityHighlights({ connected: false }), /temporarily unavailable/);
  const denied = { connected: true, timeout: () => ({ emit: (event, payload, callback) => callback(null, { ok: false, message: 'Approved GuildSync access is required.' }) }) };
  await assert.rejects(() => requestCommunityHighlights(denied), /Approved GuildSync access is required/);
  const timeout = { connected: true, timeout: () => ({ emit: (event, payload, callback) => callback(new Error('timeout')) }) };
  await assert.rejects(() => requestCommunityHighlights(timeout), /did not respond/);
  const ok = { connected: true, timeout: () => ({ emit: (event, payload, callback) => {
    assert.equal(event, 'guildsync:request-community-statistics');
    assert.equal(payload.timeZone, 'America/New_York');
    callback(null, { ok: true, report });
  } }) };
  assert.equal((await requestCommunityHighlights(ok)).highlights.length, 3);
});

test('the digest becomes due once the configured interval has passed', () => {
  const now = 1_800_000_000_000;
  assert.equal(highlightsDigestDue({ now, lastPostedAt: 0 }), true);
  assert.equal(highlightsDigestDue({ now, lastPostedAt: now - 3600_000 }), false);
  assert.equal(highlightsDigestDue({ now, lastPostedAt: now - 7 * 24 * 3600_000 }), true);
  assert.equal(highlightsDigestDue({ now, lastPostedAt: now - 2 * 3600_000, intervalHours: 1 }), true);
  assert.equal(highlightsDigestDue({ now, lastPostedAt: now, intervalHours: 0 }), false);
});

test('a due digest posts once and remembers when it went out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'highlights-'));
  const statePath = path.join(dir, 'state.json');
  const sent = [];
  const channel = {
    isTextBased: () => true,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true }),
    send: async payload => sent.push(payload.content)
  };
  let listener;
  const socket = {
    connected: true,
    on: (event, handler) => { if (event === 'connect') listener = handler; },
    off: () => {},
    timeout: () => ({ emit: (event, payload, callback) => callback(null, { ok: true, report }) })
  };
  const client = { isReady: () => true, user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const stop = startCommunityHighlightsAnnouncements(client, socket, () => {}, {
    GUILDSYNC_HIGHLIGHTS_CHANNEL_ID: 'channel', DISCORD_GUILD_ID: 'guild', GUILDSYNC_HIGHLIGHTS_STATE_FILE: statePath
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sent.length, 1, 'the first digest posts');
  await listener();
  assert.equal(sent.length, 1, 'a reconnect inside the interval does not repeat it');
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.ok(saved.lastPostedAt > 0);
  await stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('no digest is attempted without a configured channel', async () => {
  const sent = [];
  const socket = { connected: true, on: () => {}, off: () => {} };
  const client = { isReady: () => true, channels: { fetch: async () => { sent.push('fetched'); } } };
  const stop = startCommunityHighlightsAnnouncements(client, socket, () => {}, {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
  await stop();
});
