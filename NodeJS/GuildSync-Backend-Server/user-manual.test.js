import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

// The user manual is a small static site served at /manual/ by both clients. The
// pages are meant to stay modular, so these checks keep the navigation, the
// screenshot slots and the slot manifest honest as pages are added.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const manualDir = path.join(repo, 'manual');
const pages = readdirSync(manualDir).filter((file) => file.endsWith('.html')).sort();
const read = (file) => readFileSync(path.join(manualDir, file), 'utf8');

test('the manual ships an index, a stylesheet and one page per section', () => {
  assert.ok(pages.includes('index.html'), 'index.html is missing');
  assert.ok(existsSync(path.join(manualDir, 'assets', 'manual.css')), 'assets/manual.css is missing');
  assert.ok(pages.length >= 8, `expected the manual to be split into pages, found ${pages.length}`);
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /<link rel="stylesheet" href="assets\/manual\.css">/, `${page} does not load the shared stylesheet`);
    assert.match(html, /<header class="manual-top">/, `${page} has no manual header`);
  }
});

test('every navigation link points at a page that exists', () => {
  for (const page of pages) {
    const html = read(page);
    const hrefs = [...html.matchAll(/<a href="([a-z-]+\.html)(?:#[^"]*)?"/g)].map((match) => match[1]);
    const missing = [...new Set(hrefs)].filter((href) => !pages.includes(href));
    assert.deepEqual(missing, [], `${page} links to missing pages: ${missing.join(', ')}`);
  }
});

test('each page marks at most one current section in the navigation', () => {
  for (const page of pages) {
    const html = read(page);
    const current = html.match(/aria-current="page"/g) || [];
    assert.ok(current.length <= 1, `${page} marks ${current.length} navigation entries as current`);
  }
});

test('the navigation offers the same sections on every page', () => {
  const navOf = (html) => {
    const nav = html.match(/<nav class="manual-nav"[^>]*>([\s\S]*?)<\/nav>/);
    assert.ok(nav, 'page without a manual navigation');
    return nav[1].replace(/\s*aria-current="page"/g, '').replace(/\s+/g, ' ').trim();
  };
  const reference = navOf(read('index.html'));
  for (const page of pages) {
    assert.equal(navOf(read(page)), reference, `${page} has a different section list`);
  }
});

test('every screenshot slot has a unique reference and a caption', () => {
  for (const page of pages) {
    const html = read(page);
    const figures = [...html.matchAll(/<figure class="shot" id="(SHOT-[A-Z]+-\d{2})" data-shot="\1">([\s\S]*?)<\/figure>/g)];
    assert.ok(figures.length > 0, `${page} has no screenshot slots`);
    const seen = new Set();
    for (const [, id, body] of figures) {
      assert.match(id, /^SHOT-[A-Z]+-\d{2}$/);
      // One image may be referenced from a second page (the unsupported-desktop
      // screen belongs in two places), but a page must not repeat a slot.
      assert.ok(!seen.has(id), `${page} repeats ${id}`);
      seen.add(id);
      assert.match(body, /class="shot-slot"/, `${id} has no placeholder box`);
      assert.match(body, /<figcaption>[\s\S]*class="shot-id"[\s\S]*\S{20,}/, `${id} has no explanatory caption`);
    }
  }
});

test('the slot manifest and the pages list the same references', () => {
  const manifest = readFileSync(path.join(manualDir, 'SCREENSHOTS.md'), 'utf8');
  const documented = new Set([...manifest.matchAll(/`(SHOT-[A-Z]+-\d{2})`/g)].map((match) => match[1]));
  const placed = new Set();
  for (const page of pages) {
    for (const match of read(page).matchAll(/data-shot="(SHOT-[A-Z]+-\d{2})"/g)) placed.add(match[1]);
  }
  assert.deepEqual([...placed].filter((id) => !documented.has(id)), [], 'slots missing from SCREENSHOTS.md');
  assert.deepEqual([...documented].filter((id) => !placed.has(id)), [], 'SCREENSHOTS.md lists slots no page uses');
});

test('the manifest only names pages that exist', () => {
  const manifest = readFileSync(path.join(manualDir, 'SCREENSHOTS.md'), 'utf8');
  const named = [...new Set([...manifest.matchAll(/`([a-z-]+\.html)`/g)].map((match) => match[1]))];
  assert.deepEqual(named.filter((page) => !pages.includes(page)), []);
});
