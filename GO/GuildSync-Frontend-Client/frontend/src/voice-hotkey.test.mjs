import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const captureSource=await readFile(new URL('./shortcut-capture.js',import.meta.url),'utf8');
const desktopSource=await readFile(new URL('./desktop-controls.js',import.meta.url),'utf8');
const shellSource=await readFile(new URL('./profile-menu-shell.js',import.meta.url),'utf8');
const source = (await readFile(new URL('./voice-hotkey.js', import.meta.url), 'utf8'))
  .replace('./shortcut-capture.js','data:text/javascript;base64,'+Buffer.from(captureSource).toString('base64'))
  .replace('./desktop-controls.js','data:text/javascript;base64,'+Buffer.from(desktopSource).toString('base64'))
  .replace('./profile-menu-shell.js','data:text/javascript;base64,'+Buffer.from(shellSource).toString('base64'));
const {createVoiceHotkeyController} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
