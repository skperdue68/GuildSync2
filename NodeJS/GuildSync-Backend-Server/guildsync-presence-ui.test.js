import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const clients = {
  web: './web/src/main.js',
  desktop: '../../GO/GuildSync-Frontend-Client/frontend/src/main.js'
};

function read(client) {
  return readFileSync(new URL(clients[client], import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

function pick(source, name) {
  return source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0] || '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[character]));
}

function render(client, payload, selfId) {
  const source = read(client);
  // The footer the line lives in, so the message-area class can be observed.
  const bar = {
    classes: new Set(),
    classList: {toggle(name, on) { if (on) bar.classes.add(name); else bar.classes.delete(name); }}
  };
  const nodes = {
    '#guildSyncPresence': {hidden: true, closest: selector => (selector === '.status-bar' ? bar : null)},
    '#guildSyncPresenceLabel': {textContent: ''},
    '#guildSyncPresenceTooltip': {innerHTML: ''}
  };
  const context = vm.createContext({
    guildSyncPresence: {users: [], total: 0, eso_running: 0},
    guildSyncSession: {user: {discord_user_id: selfId}},
    document: {querySelector: selector => nodes[selector] || null},
    escapeHtml
  });
  vm.runInContext([
    pick(source, 'guildSyncPresenceClientTypes'),
    pick(source, 'refreshGuildSyncPresence'),
    pick(source, 'setGuildSyncPresence')
  ].join('\n'), context);
  vm.runInContext('setGuildSyncPresence(payload)', Object.assign(context, {payload}));
  return {
    hidden: nodes['#guildSyncPresence'].hidden,
    label: nodes['#guildSyncPresenceLabel'].textContent,
    tooltip: nodes['#guildSyncPresenceTooltip'].innerHTML,
    shortened: bar.classes.has('has-guildsync-presence')
  };
}

const payload = {
  total: 3,
  eso_running: 1,
  users: [
    {user_id: 'self', name: 'Evan', login: '@evainefaye', eso_running: true, client_types: ['desktop']},
    {user_id: '2', name: 'Merlin', login: '@merlin6990', eso_running: false, client_types: ['desktop', 'web']},
    {user_id: '3', name: 'Tenthirty', login: '@tenthirty2', eso_running: false, client_types: ['web']}
  ]
};

for (const client of Object.keys(clients)) {
  test(`${client} footer states signed-in people and how many are running ESO`, () => {
    const view = render(client, payload, 'self');

    assert.equal(view.hidden, false);
    assert.equal(view.shortened, true, 'the message area shortens while the line shows');
    assert.equal(view.label, '3 signed in · 1 with ESO running');
    assert.match(view.tooltip, /Signed in to GuildSync/);
    assert.match(view.tooltip, /3 users · 1 with ESO running/);
    assert.match(view.tooltip, /Evan/, 'the reader is listed in their own tooltip too');
    assert.match(view.tooltip, /@evainefaye<\/span><span class="guildsync-presence-client is-desktop">desktop<\/span>/);
    assert.match(view.tooltip, /Merlin/);
    assert.match(view.tooltip, /@merlin6990<\/span><span class="guildsync-presence-client is-desktop">desktop<\/span><span class="guildsync-presence-client is-web">web<\/span>/);
    assert.match(view.tooltip, /Tenthirty/);
    assert.match(view.tooltip, /@tenthirty2<\/span><span class="guildsync-presence-client is-web">web<\/span>/);
    assert.doesNotMatch(view.tooltip, /\u00b7 desktop/);
    assert.doesNotMatch(view.tooltip, /\u00b7 web/);
  });

  test(`${client} tooltip colours the dot instead of spelling out the ESO state`, () => {
    const view = render(client, {
      total: 2,
      eso_running: 1,
      users: [
        {user_id: 'self', name: 'Self', login: '@self', eso_running: false, client_types: ['desktop']},
        {user_id: '2', name: 'Runner', login: '@runner', eso_running: true, client_types: ['desktop']},
        {user_id: '3', name: 'Idle', login: '@idle', eso_running: false, client_types: ['web']}
      ]
    }, 'self');

    assert.equal(view.label, '3 signed in · 1 with ESO running');
    assert.equal((view.tooltip.match(/guildsync-presence-dot eso-on/g) || []).length, 1);
    assert.equal((view.tooltip.match(/guildsync-presence-dot eso-off/g) || []).length, 2);
    // The only "ESO running" wording is the tooltip header; rows lean on the dot colour.
    assert.equal((view.tooltip.match(/ESO running/g) || []).length, 1);
    assert.doesNotMatch(view.tooltip, /ESO not running/);
  });

  test(`${client} counts you when you are the only one signed in`, () => {
    const alone = render(client, {
      total: 1,
      eso_running: 1,
      users: [{user_id: 'self', name: 'Self', login: '@self', eso_running: true, client_types: ['desktop']}]
    }, 'self');

    assert.equal(alone.hidden, false);
    assert.equal(alone.shortened, true);
    assert.equal(alone.label, '1 signed in · 1 with ESO running');
    assert.match(alone.tooltip, /1 user · 1 with ESO running/);
    assert.match(alone.tooltip, /Self/);
    assert.equal((alone.tooltip.match(/guildsync-presence-dot eso-on/g) || []).length, 1);
  });

  test(`${client} hides the line and restores the message area when the socket is gone`, () => {
    const offline = render(client, null, 'self');

    assert.equal(offline.hidden, true);
    assert.equal(offline.label, '');
    assert.equal(offline.tooltip, '');
    assert.equal(offline.shortened, false, 'the message area keeps its full width when the line is hidden');
  });

  test(`${client} subscribes to presence and reports its own ESO state`, () => {
    const source = read(client);

    assert.match(source, /<div id="guildSyncPresence" class="guildsync-presence" hidden>/);
    assert.match(source, /onCurrentSocket\('guildsync:presence',payload=>setGuildSyncPresence\(payload\)\);/);
    assert.match(source, /connectedSocket\.emit\('guildsync:presence-request'\);/);
    assert.match(source, /reportedEsoPresence = null;/);
    assert.match(source, /reportESOStatusToBackend\(/);
    assert.match(source, /socket\.emit\('guildsync:report-eso-status', \{ running: next \}\);/);
    assert.match(source, /setGuildSyncPresence\(null\);/);
  });

  test(`${client} keeps the line out of the left status-message area`, () => {
    const source = read(client);
    const messages = source.indexOf('id="statusMessageViewport"');
    const presence = source.indexOf('id="guildSyncPresence"');

    assert.ok(messages > 0, 'the status message viewport is still in the footer');
    assert.ok(presence > messages, 'the presence line sits after the status messages, not before them');
  });
}

test('the client type is a pill and User Settings stacks above other modals', () => {
  for (const client of Object.keys(clients)) {
    const css = readFileSync(new URL(clients[client].replace('/main.js', '/style.css'), import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    assert.match(css, /\.guildsync-presence-who small\.guildsync-presence-meta \{[^}]*display: flex;/, `${client}: the login and pills share a flex line`);
    assert.match(css, /\.guildsync-presence-client \{[^}]*border-radius: 999px;/, `${client}: the client type is a pill`);
    assert.match(css, /\.roster-history-overlay\.user-settings-overlay \{\n  z-index: 60;/, `${client}: User Settings stacks above report modals`);
    assert.match(read(client), /class="roster-history-overlay user-settings-overlay"/, `${client}: the User Settings overlay carries its stacking class`);
  }
});

test('the bar centres the line and caps the message area so the two cannot overlap', () => {
  for (const client of Object.keys(clients)) {
    const css = readFileSync(new URL(clients[client].replace('/main.js', '/style.css'), import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const desktop = css.slice(css.indexOf('@media (min-width: 900px) {'));

    assert.match(desktop, /\.guildsync-presence \{\n    position: absolute;\n    left: 50%;/, `${client}: centred in the bar`);
    assert.match(desktop, /transform: translateX\(-50%\);/, `${client}: centred with a transform`);
    assert.match(desktop, /\.status-bar\.has-guildsync-presence \.status-message-viewport \{\n    max-width: calc\(50% - 200px\);\n    margin-right: auto;/, `${client}: message area only shortens while the line shows`);
  }
});
