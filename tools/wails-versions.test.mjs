import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const moduleVersion = read('GO/GuildSync-Frontend-Client/go.mod')
  .match(/github\.com\/wailsapp\/wails\/v3\s+(v\S+)/)?.[1];

test('Wails Go module and frontend runtime use the same exact version', () => {
  assert.ok(moduleVersion, 'desktop must use a Wails 3 module');
  const manifest = JSON.parse(read('GO/GuildSync-Frontend-Client/frontend/package.json'));
  assert.equal('v' + manifest.dependencies['@wailsio/runtime'], moduleVersion);
});

for (const workflow of ['desktop.yml', 'buildguildsync.yml']) {
  test(`${workflow} builds with the same Wails CLI version as the Go module`, () => {
    const source = read('.github/workflows/' + workflow);
    const cliVersion = source.match(/WAILS_VERSION:\s*['"]?(v[\d.]+)/)?.[1];
    assert.equal(cliVersion, moduleVersion);
    assert.match(source, /github\.com\/wailsapp\/wails\/v3\/cmd\/wails3@/);
  });
}
