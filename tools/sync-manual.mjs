// Copies the user manual into both frontends so each client serves it at
// /manual/. The manual itself lives once, in manual/, and is never edited in the
// generated copies. Runs from the `prebuild` and `predev` scripts of
// GO/GuildSync-Frontend-Client/frontend and NodeJS/GuildSync-Backend-Server/web.
import {cpSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repo, 'manual');
const targets = [
  path.join(repo, 'GO', 'GuildSync-Frontend-Client', 'frontend', 'public', 'manual'),
  path.join(repo, 'NodeJS', 'GuildSync-Backend-Server', 'web', 'public', 'manual')
];

for (const target of targets) {
  rmSync(target, {recursive: true, force: true});
  mkdirSync(path.dirname(target), {recursive: true});
  cpSync(source, target, {recursive: true});
  console.log(`manual: ${path.relative(repo, target)}`);
}
