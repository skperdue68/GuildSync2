import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The guild chat insert once named a channel column without a value, and MariaDB
// rejected every upload with "Column count doesn't match value count at row 1".
// This scans every backend module that writes SavedVariables data for the same
// shape problem, so a new column cannot be added without its value.
const backendDirectory = new URL('./', import.meta.url);
const SAVEDVARS_WRITERS = fs
  .readdirSync(backendDirectory)
  .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
  .sort();

function matchingParen(source, open) {
  let depth = 0;
  let quote = '';

  for (let index = open; index < source.length; index++) {
    const character = source[index];

    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }

    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (quote) {
      current += character;
      if (character === '\\') current += text[++index] ?? '';
      else if (character === quote) quote = '';
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;

    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  parts.push(current.trim());
  return parts.filter(Boolean);
}

function insertStatements(source) {
  const statements = [];
  const pattern = /INSERT\s+(?:IGNORE\s+)?INTO\s+([^\s(]+)\s*\(/gi;
  let match;

  while ((match = pattern.exec(source))) {
    const columnsOpen = source.indexOf('(', match.index + match[0].length - 1);
    const columnsClose = matchingParen(source, columnsOpen);
    if (columnsClose < 0) continue;

    const columnsText = source.slice(columnsOpen + 1, columnsClose);
    if (columnsText.includes('${')) continue;

    const valuesAt = source.indexOf('VALUES', columnsClose);
    if (valuesAt < 0) continue;

    const valuesOpen = source.indexOf('(', valuesAt);
    const valuesClose = matchingParen(source, valuesOpen);
    if (valuesOpen < 0 || valuesClose < 0) continue;

    const valuesText = source.slice(valuesOpen + 1, valuesClose);
    // Placeholder lists built at runtime cannot be counted here, and inline JSON
    // defaults carry commas that are not value separators.
    if (valuesText.includes('${') || valuesText.includes('=>') || valuesText.includes('{')) continue;

    statements.push({
      line: source.slice(0, match.index).split('\n').length,
      table: match[1],
      columns: splitTopLevel(columnsText),
      values: splitTopLevel(valuesText)
    });
  }

  return statements;
}

test('the scanner catches a column without a value', () => {
  const [statement] = insertStatements('INSERT INTO somewhere (a, b, c) VALUES (?, ?)');

  assert.equal(statement.columns.length, 3);
  assert.equal(statement.values.length, 2);
  assert.notEqual(statement.columns.length, statement.values.length);
});

test('every SavedVariables insert supplies one value for every column', () => {
  const mismatches = [];
  const checked = [];

  for (const file of SAVEDVARS_WRITERS) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

    for (const statement of insertStatements(source)) {
      checked.push({...statement, file});

      if (statement.columns.length !== statement.values.length) {
        mismatches.push(
          `${file}:${statement.line} ${statement.table}: ${statement.columns.length} columns, ${statement.values.length} values`
        );
      }
    }
  }

  assert.deepEqual(mismatches, []);
  assert.ok(checked.length >= 10, `expected to check the SavedVariables inserts, only checked ${checked.length}`);

  // The insert that broke must stay covered, with its officer chat column bound.
  const chatInsert = checked.find((statement) => statement.table === 'guildsync_guild_chat_messages');
  assert.ok(chatInsert, 'the guild chat insert was not scanned');
  assert.ok(chatInsert.columns.includes('channel'));
  assert.equal(chatInsert.columns.length, chatInsert.values.length);
});
