// The local copy of the config no longer holds API keys (secret_strip.js). If config.json cannot be read at
// start-up the page has no keys, so saving the config then would blank them in the file: the save is skipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const i18n = fs.readFileSync('frontend/js/i18n.js', 'utf8');

const sync = appJs.slice(appJs.indexOf('async function syncBackendConfig()'));
const catchAt = sync.indexOf("console.warn('Failed to load persistent config from backend:'");
assert.ok(catchAt > 0, 'the start-up load error handler exists');
assert.ok(/backendConfigLoadFailed = true;/.test(sync.slice(Math.max(0, catchAt - 120), catchAt)), 'a failed load sets the flag');

const save = appJs.slice(appJs.indexOf('async function savePersistentConfig()'), appJs.indexOf('async function savePersistentConfig()') + 1800);
const guard = save.indexOf('if (backendConfigLoadFailed)');
const write = save.indexOf('window.backend.saveConfig(JSON.stringify(config))');
assert.ok(guard > 0 && write > guard, 'the guard runs before the config is handed to the backend');
assert.ok(/return;/.test(save.slice(guard, write)), 'the guarded path returns without saving');

// The message exists in both languages.
const hits = i18n.match(/configNotSavedUnreadable:/g) || [];
assert.equal(hits.length, 2, 'the message has an English and a Japanese text');
console.log('PASS: config save is skipped after an unreadable config.json at start-up.');
