import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGuildChatSender,
  normalizeGuildChatText,
  guildChatMessageHash,
  ingestGuildChatMessages
} from './guild-chat-ingest.js';

function memoryDB() {
  const rows = [];
  const schema = [];
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    async execute(sql, params = []) {
      if (sql.includes('SELECT id FROM guildsync_guild_chat_messages')) {
        const [hash, from, to] = params;
        const matches = rows
          .filter((row) => row.hash === hash && row.timestamp >= from && row.timestamp <= to)
          .map((row) => ({ id: row.id }));
        return [matches];
      }

      if (sql.includes('INSERT INTO guildsync_guild_chat_messages')) {
        rows.push({
          id: rows.length + 1,
          hash: params[0],
          guild: params[1],
          sender: params[2],
          text: params[3],
          timestamp: params[4],
          source: params[6],
          uploadedBy: params[7]
        });
        return [{ affectedRows: 1 }];
      }

      return [{}];
    }
  };

  return {
    rows,
    schema,
    async query(sql) {
      schema.push(sql);
    },
    async getConnection() {
      return connection;
    }
  };
}

test('guild chat normalization strips ESO color codes and link markup', () => {
  assert.equal(normalizeGuildChatSender('  @EvaInEFaye  '), '@evainefaye');
  assert.equal(
    normalizeGuildChatText('|cFFAA00Hello|r   Mafia,\r\n look at |H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h[Dreugh Wax]|h'),
    'Hello Mafia, look at [Dreugh Wax]'
  );
  assert.equal(
    normalizeGuildChatText('Icon link |H1:item:99:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h here'),
    'Icon link here'
  );
});

test('guild chat hash ignores timestamp and reporter formatting', () => {
  const first = guildChatMessageHash({
    guild: '761817',
    sender: ' @EvaInEFaye ',
    text: '|c88CCFFHi|r  Lamb!'
  });
  const second = guildChatMessageHash({
    guild: '761817',
    sender: '@evainefaye',
    text: 'Hi Lamb!'
  });
  const otherGuild = guildChatMessageHash({ guild: '999', sender: '@evainefaye', text: 'Hi Lamb!' });
  const otherText = guildChatMessageHash({ guild: '761817', sender: '@evainefaye', text: 'Hi Lamb?' });

  assert.equal(first, second);
  assert.notEqual(first, otherGuild);
  assert.notEqual(first, otherText);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('guild chat ingestion dedupes reporters within 30 seconds but keeps a later repeat', async () => {
  const db = memoryDB();
  const payload = {
    guildId: '761817',
    uploadedBy: 'Eva',
    source: 'GuildSyncChat',
    entries: [
      { sender: '@TheLamb_Sauce', timestamp: 1795636949, text: 'Howdy Mafia!' },
      { sender: '@evainefaye', timestamp: 1795636954, text: '|c88CCFFHi|r Lamb!' }
    ]
  };

  const first = await ingestGuildChatMessages(db, payload);
  assert.equal(first.chat_messages_received, 2);
  assert.equal(first.chat_messages_inserted, 2);
  assert.equal(first.chat_messages_duplicates, 0);
  assert.equal(db.rows[0].uploadedBy, 'Eva', 'the submitting GuildSync user is recorded');
  assert.equal(db.rows[0].guild, '761817');
  assert.equal(db.rows[0].timestamp, 1795636949);

  const secondReport = await ingestGuildChatMessages(db, {
    guildId: '761817',
    uploadedBy: 'Lamb',
    entries: [
      { sender: ' @THELAMB_SAUCE ', timestamp: 1795636961, text: 'Howdy  Mafia!' },
      { sender: '@evainefaye', timestamp: 1795636930, text: 'Hi Lamb!' }
    ]
  });
  assert.equal(secondReport.chat_messages_inserted, 0);
  assert.equal(secondReport.chat_messages_duplicates, 2, 'both messages were already reported inside the window');
  assert.equal(db.rows.length, 2, 'duplicate reports are not stored again');

  const laterRepeat = await ingestGuildChatMessages(db, {
    guildId: '761817',
    uploadedBy: 'Eva',
    entries: [{ sender: '@TheLamb_Sauce', timestamp: 1795636989, text: 'Howdy Mafia!' }]
  });
  assert.equal(laterRepeat.chat_messages_inserted, 1, 'a repeated message sent later is a new record');
  assert.equal(db.rows.length, 3);

  const invalid = await ingestGuildChatMessages(db, {
    guildId: '761817',
    uploadedBy: 'Eva',
    entries: [
      { sender: '', timestamp: 1795637000, text: 'missing sender' },
      { sender: '@Eva', timestamp: 0, text: 'missing timestamp' },
      { sender: '@Eva', timestamp: 1795637000, text: '   ' }
    ]
  });
  assert.equal(invalid.chat_messages_skipped, 3);
  assert.equal(invalid.chat_messages_inserted, 0);
  assert.ok(db.schema[0].includes('CREATE TABLE IF NOT EXISTS guildsync_guild_chat_messages'));
});
