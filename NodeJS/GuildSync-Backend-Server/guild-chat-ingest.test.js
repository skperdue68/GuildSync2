import test from 'node:test';
import assert from 'node:assert/strict';
// The SavedVariables parsers live beside the database helpers, which read their
// connection settings from the environment at import time.
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';

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
          channel: params[2],
          sender: params[3],
          text: params[4],
          timestamp: params[5],
          source: params[7],
          uploadedBy: params[8]
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
    // The column probe runs before the table can be altered; reporting the
    // column missing exercises the migration on every test run.
    async execute() {
      return [[{present: 0}]];
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
  assert.equal(db.rows[0].channel, 'guild', 'a report without a channel is guild chat');

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
  assert.ok(db.schema[0].includes('channel VARCHAR(16) NOT NULL DEFAULT \'guild\''));
  assert.ok(db.schema.some(sql => sql.includes('ADD COLUMN channel')));
});

test('officer chat is stored as officer chat and never deduped against guild chat', async () => {
  const db = memoryDB();

  const officer = await ingestGuildChatMessages(db, {
    guildId: '761817',
    uploadedBy: 'Eva',
    entries: [
      { sender: '@Officer', timestamp: 1795637000, text: 'Raid at 8', channel: 'officer' },
      { sender: '@Officer', timestamp: 1795637000, text: 'Raid at 8', channel: 'guild' },
      { sender: '@Officer', timestamp: 1795637001, text: 'Officer only', channel: 'OFFICER' },
      { sender: '@Officer', timestamp: 1795637002, text: 'Unknown channel', channel: 'whisper' }
    ]
  });

  assert.equal(officer.chat_messages_inserted, 4, 'a channel change is a different message');
  assert.deepEqual(db.rows.map(row => row.channel), ['officer', 'guild', 'officer', 'guild']);
  assert.notEqual(db.rows[0].hash, db.rows[1].hash, 'the hash includes the channel');
});

test('a dropped GuildSyncChat file parses every message and channel', async () => {
  const {parseGuildSyncChatSavedVarsLua} = await import('./guildsync-database-actions.js');

  // The shape ESO writes, including the older messages that carry guild instead
  // of channel and the newer ones that carry channel.
  const data = parseGuildSyncChatSavedVarsLua(`GuildSyncChat =
{
    ["Default"] =
    {
        ["@evainefaye"] =
        {
            ["$AccountWide"] =
            {
                ["NA Megaserver"] =
                {
                    ["version"] = 1,
                    ["debugChat"] = false,
                    ["messages"] =
                    {
                        [1] =
                        {
                            ["text"] = "first line",
                            ["timestamp"] = 1795650771,
                            ["sender"] = "@lesidhe",
                            ["guild"] = "alphabet_mafia",
                        },
                        [2] =
                        {
                            ["text"] = "Yall are being waay too talkative tonight :)",
                            ["timestamp"] = 1795652978,
                            ["sender"] = "@evainefaye",
                            ["channel"] = "officer",
                        },
                        [3] =
                        {
                            ["text"] = "Hi hello :3",
                            ["timestamp"] = 1795653002,
                            ["sender"] = "@RainStarlight",
                            ["channel"] = "guild",
                        },
                        [4] =
                        {
                            ["text"] = "",
                            ["timestamp"] = 1795653010,
                            ["sender"] = "@Vatrys",
                        },
                    },
                },
            },
        },
    },
}
`);

  assert.equal(data.account_names[0], '@evainefaye');
  assert.equal(data.entries_count, 3, 'an empty message is skipped');
  assert.deepEqual(data.entries.map((entry) => entry.channel), ['guild', 'officer', 'guild']);
  assert.deepEqual(data.entries.map((entry) => entry.timestamp), [1795650771, 1795652978, 1795653002]);
  assert.equal(data.entries[1].text, 'Yall are being waay too talkative tonight :)');
});

test('a dropped reminder file parses its delivery results', async () => {
  const {parseGuildSyncDiscordReminderSavedVarsLua} = await import('./guildsync-database-actions.js');

  const data = parseGuildSyncDiscordReminderSavedVarsLua(`GuildSyncDiscordReminder =
{
    ["NA Megaserver"] =
    {
        ["@evainefaye"] =
        {
            ["$AccountWide"] =
            {
                ["mailAck"] =
                {
                    ["req-1"] =
                    {
                        ["requestId"] = "req-1",
                        ["batchId"] = "batch-1",
                        ["guildId"] = "761817",
                        ["sendingAccount"] = "@evainefaye",
                        ["worldName"] = "NA Megaserver",
                        ["status"] = "sent",
                        ["sentAt"] = 1795650771,
                    },
                    ["req-2"] =
                    {
                        ["requestId"] = "req-2",
                        ["batchId"] = "batch-1",
                        ["guildId"] = "761817",
                        ["sendingAccount"] = "@evainefaye",
                        ["worldName"] = "NA Megaserver",
                        ["status"] = "failed",
                        ["detail"] = "Mailbox full",
                    },
                },
            },
        },
    },
}
`);

  assert.equal(data.acks_count, 2);
  assert.deepEqual(data.acks.map((ack) => ack.status), ['sent', 'failed']);
  assert.equal(data.acks[0].sentAt, 1795650771);
  assert.equal(data.acks[1].detail, 'Mailbox full');
});
