// A dependency upgrade can invalidate route syntax without any test noticing:
// Express 5 parses paths with path-to-regexp v8, which rejects the bare '*'
// wildcard that Express 4 accepted, and the server itself cannot be imported
// here because it exits when MariaDB is unavailable. Register every route
// literal against the installed Express version instead, and prove the
// single-page fallback still answers from the root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';

const directory = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(directory, 'guildsync-backend-server.js');
const routePattern = /\b(?:app|router|api)\s*\.\s*(get|post|put|patch|delete|all|options|head|use)\s*\(\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;

function routeLiterals(source) {
 return [...source.matchAll(routePattern)].map(match => ({method: match[1], route: match[3]}));
}

test('every backend route literal registers under the installed Express version', () => {
 const files = fs.readdirSync(directory).filter(name => name.endsWith('.js') && !name.endsWith('.test.js'));
 let checked = 0;
 for (const name of files) {
  const source = fs.readFileSync(path.join(directory, name), 'utf8');
  for (const {method, route} of routeLiterals(source)) {
   // Interpolated and escaped paths cannot be validated statically.
   if (route.includes('${') || route.includes('\\')) continue;
   assert.doesNotThrow(() => express()[method](route, () => {}), `${name}: ${method.toUpperCase()} ${JSON.stringify(route)} is not valid route syntax`);
   checked++;
  }
 }
 assert.ok(checked >= 10, `expected to validate the server's HTTP routes, only found ${checked}`);
});

test('the single-page fallback serves the app from the root and every nested path', async () => {
 const source = fs.readFileSync(serverFile, 'utf8');
 // Anchor on the handler that sends the app shell, then take the route that
 // registers it, so unrelated routes and comments cannot be picked up.
 const sendAt = source.search(/res\.sendFile\([^)]*index\.html/);
 assert.ok(sendAt > 0, 'the single-page fallback was not found');
 const literal = [...source.slice(0, sendAt).matchAll(/app\.get\(\s*'([^']+)'/g)].pop();
 assert.ok(literal, 'the single-page fallback route was not found');

 const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'guildsync-dist-'));
 fs.writeFileSync(path.join(dist, 'index.html'), '<div id="app"></div>');
 const app = express();
 app.use(express.static(dist));
 app.get(literal[1], (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  return res.sendFile(path.join(dist, 'index.html'));
 });

 const server = app.listen(0, '127.0.0.1');
 try {
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const target of ['/', '/roster', '/banking/history']) {
   const response = await fetch(base + target);
   assert.equal(response.status, 200, `${target} should serve the app shell`);
   assert.match(await response.text(), /<div id="app">/);
  }
  for (const target of ['/api/unknown', '/socket.io/unknown']) {
   assert.equal((await fetch(base + target)).status, 404, `${target} must not fall through to the app shell`);
  }
 } finally {
  await new Promise(done => server.close(done));
  fs.rmSync(dist, {recursive: true, force: true});
 }
});
