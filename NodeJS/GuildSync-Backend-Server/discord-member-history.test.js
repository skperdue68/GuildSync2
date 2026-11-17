import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function getDiscordMemberHistoryMatches');
assert.ok(start >= 0, 'getDiscordMemberHistoryMatches is missing');
const end = source.indexOf('export async function getDiscordMemberHistoryForMember', start);
assert.ok(end > start, 'getDiscordMemberHistoryMatches end marker is missing');
const query = source.slice(start, end);
const nameOrder = text => [...text.matchAll(/\b(dm|h)\.(server_nickname|global_name|username)\b/g)].map(match => `${match[1]}.${match[2]}`);
const currentFirst = ['dm.server_nickname', 'dm.global_name', 'dm.username', 'h.server_nickname', 'h.global_name', 'h.username'];

test('Discord member history matches label from every current name before any historical one',()=>{
 const select=query.slice(query.indexOf('SELECT'),query.indexOf('FROM discord_member_history'));
 assert.deepEqual(nameOrder(select),currentFirst);
});

test('Discord member history matches sort by the same current-first name they display',()=>{
 const orderBy=query.slice(query.indexOf('ORDER BY'));
 assert.deepEqual(nameOrder(orderBy),currentFirst);
});

test('old Discord names stay searchable in member history matches',()=>{
 const where=query.slice(query.indexOf('WHERE'),query.indexOf('GROUP BY'));
 for(const clause of ['h.discord_id LIKE ?','h.username LIKE ?','h.global_name LIKE ?','h.server_nickname LIKE ?','dm.username LIKE ?','dm.global_name LIKE ?','dm.server_nickname LIKE ?']){
  assert.ok(where.includes(clause),`missing search clause: ${clause}`);
 }
 assert.equal((where.match(/LIKE \?/g)||[]).length,7);
});
