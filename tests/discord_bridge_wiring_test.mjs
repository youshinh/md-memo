import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

console.log('=== Discord Bridge (mobile capture) wiring tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8').replace(/\r\n/g, '\n');
const winGo = fs.readFileSync('window_windows.go', 'utf8').replace(/\r\n/g, '\n');
const macGo = fs.readFileSync('window_darwin.go', 'utf8').replace(/\r\n/g, '\n');

// ---- index.html: the settings row lives inside the Sync pane ------------------------------
const paneStart = indexHtml.indexOf('<div id="pane-sync"');
const paneEnd = indexHtml.indexOf('<!-- Shortcuts Config Pane -->', paneStart);
assert(paneStart > 0 && paneEnd > paneStart, 'pane-sync not found');
const paneHtml = indexHtml.slice(paneStart, paneEnd);
for (const id of ['cfg-discord-enabled', 'cfg-discord-bot-token', 'cfg-discord-user-id', 'cfg-discord-poll-interval', 'btn-discord-test', 'discord-test-result-hint']) {
  assert(paneHtml.includes(`id="${id}"`), `pane-sync must contain #${id}`);
}
const tokenLine = paneHtml.split('\n').find((l) => l.includes('id="cfg-discord-bot-token"'));
assert(tokenLine && /type="password"/.test(tokenLine), 'the bot token field must be a password input, not plain text');
console.log('PASS: settings markup for the Discord bridge exists in the Sync pane, token field masked.');

// ---- i18n: every new key exists in en & ja, none carries an emoji -------------------------
const context = { window: {} };
vm.createContext(context);
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;
const DISCORD_KEYS = [
  'sectionDiscordBridge', 'discordBridgeEnabledLabel', 'discordBridgeEnabledHint',
  'discordBridgeBotTokenLabel', 'discordBridgeBotTokenHint', 'discordBridgeAllowedUserIdLabel',
  'discordBridgeAllowedUserIdHint', 'discordBridgePollIntervalLabel', 'discordBridgePollIntervalHint',
  'btnDiscordBridgeTest', 'btnDiscordBridgeTesting', 'discordBridgeTestSuccess', 'discordBridgeTestFailed',
  'discordBridgeStatusConnected', 'discordBridgeStatusConnecting', 'discordBridgeStatusError',
  'discordBridgeMessageToast',
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const lang of ['en', 'ja']) {
  for (const key of DISCORD_KEYS) {
    assert(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `I18N.${lang}.${key} must exist`);
    assert(!EMOJI.test(I18N[lang][key]), `I18N.${lang}.${key} must not contain an emoji: ${I18N[lang][key]}`);
  }
}
console.log('PASS: every Discord bridge i18n key exists in en & ja with no emoji.');

// Every data-i18n reference used in the pane markup must resolve.
const usedKeys = [...paneHtml.matchAll(/data-i18n="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
assert(usedKeys.length >= 8, 'expected several data-i18n references in the new markup');
for (const key of usedKeys) {
  for (const lang of ['en', 'ja']) {
    assert(typeof I18N[lang][key] === 'string', `data-i18n="${key}" used in pane-sync has no I18N.${lang} entry`);
  }
}
console.log('PASS: every data-i18n reference in the new markup resolves in both languages.');

// ---- app.js: load / save / mute / test-button / event wiring ------------------------------
assert(/discordEnabledEl\.checked = !!\(config\.discordBridge && config\.discordBridge\.enabled\)/.test(appJs),
  'openSettings must load config.discordBridge.enabled');
assert(/discordTokenEl\.value = \(config\.discordBridge && config\.discordBridge\.botToken\) \|\| ''/.test(appJs),
  'openSettings must load config.discordBridge.botToken');
assert(/discordUserIdEl\.value = \(config\.discordBridge && config\.discordBridge\.allowedUserId\) \|\| ''/.test(appJs),
  'openSettings must load config.discordBridge.allowedUserId');
assert(/config\.discordBridge\.enabled = saveDiscordEnabledEl\.checked/.test(appJs), 'Save must write config.discordBridge.enabled');
assert(/config\.discordBridge\.botToken = saveDiscordTokenEl\.value\.trim\(\)/.test(appJs), 'Save must write config.discordBridge.botToken');
assert(/config\.discordBridge\.allowedUserId = saveDiscordUserIdEl\.value\.trim\(\)/.test(appJs), 'Save must write config.discordBridge.allowedUserId');
assert(/config\.discordBridge\.pollIntervalSeconds = clampNumber\(saveDiscordIntervalEl\.value, 15, 600, 45\)/.test(appJs),
  'Save must clamp the poll interval to [15, 600] with a default of 45');
assert(/wireNumberInputClamp\('cfg-discord-poll-interval', 15, 600, 45\)/.test(appJs), 'the poll interval input must clamp live as the user types');
assert(/function updateDiscordBridgeFieldStates\(\)/.test(appJs), 'a field-muting function for the Discord bridge section must exist');
assert(/discordEnabledToggleEl\.addEventListener\('change', updateDiscordBridgeFieldStates\)/.test(appJs),
  'toggling the enabled checkbox must re-evaluate which fields are muted');
console.log('PASS: settings load/save/mute wiring for the Discord bridge is in place.');

assert(/window\.backend\.testDiscordBridgeConnection/.test(appJs), 'the test-connection button must call window.backend.testDiscordBridgeConnection');
console.log('PASS: the "Test Connection" button is wired to the backend.');

// onDiscordBridgeMessage must never switch tabs or create one - it can fire at any time in the
// background, and must not steal focus from whatever the user is currently editing (unlike
// onScrapAppended, the CLI-pipe event, which does exactly that on purpose).
const msgStart = appJs.indexOf('window.onDiscordBridgeMessage = ');
const msgEnd = appJs.indexOf('\n  };', msgStart);
assert(msgStart > 0 && msgEnd > msgStart, 'window.onDiscordBridgeMessage not found');
const msgHandlerSrc = appJs.slice(msgStart, msgEnd);
assert(!/selectTab\(/.test(msgHandlerSrc), 'onDiscordBridgeMessage must not switch the active tab');
assert(!/createTab\(/.test(msgHandlerSrc), 'onDiscordBridgeMessage must not create a new tab');
assert(/showMessage\(t\('discordBridgeMessageToast'\)/.test(msgHandlerSrc), 'onDiscordBridgeMessage must show a toast');
console.log('PASS: onDiscordBridgeMessage refreshes an already-open tab at most, never switches focus.');

assert(/window\.onDiscordBridgeStatus = function/.test(appJs), 'window.onDiscordBridgeStatus must exist for the settings-screen status indicator');
console.log('PASS: window.onDiscordBridgeStatus is wired for the settings-screen indicator.');

// ---- no emoji anywhere in the new code -----------------------------------------------------
assert(!EMOJI.test(paneHtml), 'the new settings markup must not contain emoji (line SVG icons only)');
console.log('PASS: no emoji in the new markup.');

// ---- Go: the backend method is bound and exposed to the page on both platforms ------------
for (const [name, src] of [['window_windows.go', winGo], ['window_darwin.go', macGo]]) {
  assert(/_ = w\.Bind\("backend_testDiscordBridgeConnection", app\.TestDiscordBridgeConnection\)/.test(src),
    `${name} must bind backend_testDiscordBridgeConnection`);
  assert(/testDiscordBridgeConnection: \(botToken, allowedUserId\) => window\.backend_testDiscordBridgeConnection\(botToken \|\| "", allowedUserId \|\| ""\)/.test(src),
    `${name} must expose window.backend.testDiscordBridgeConnection`);
}
console.log('PASS: TestDiscordBridgeConnection is bound and exposed on both Windows and macOS.');

// ---- regression: discordBridge must survive the frontend's config load/sync path ----------
// SaveConfig writes config.discordBridge correctly and the Go poller reads config.json directly,
// so the feature can work on disk while the in-memory `config` object silently never learns about
// it - openSettings() then shows it as off/empty, and the next unrelated Settings save overwrites
// the working config.json with those empty values. Both the localStorage fast-path load and the
// backend-authoritative load must carry discordBridge through, exactly like scraps/action/etc do.
assert(/discordBridge:\s*\{\s*enabled:\s*false,\s*botToken:\s*'',\s*allowedUserId:\s*'',\s*pollIntervalSeconds:\s*45\s*\}/.test(appJs),
  "the default `config` object must declare a discordBridge section (like scraps/action/etc)");

const loadLocalStart = appJs.indexOf('function loadLocalConfigSync()');
const loadLocalEnd = appJs.indexOf('\n  }', appJs.indexOf('migrateFullscreenShortcut();', loadLocalStart));
assert(loadLocalStart > 0 && loadLocalEnd > loadLocalStart, 'loadLocalConfigSync not found');
const loadLocalSrc = appJs.slice(loadLocalStart, loadLocalEnd);
assert(/if \(parsed\.discordBridge\) \{\s*if \(!config\.discordBridge\) config\.discordBridge = \{\};\s*Object\.assign\(config\.discordBridge, parsed\.discordBridge\);\s*\}/.test(loadLocalSrc),
  'loadLocalConfigSync (the localStorage fast-path load) must merge parsed.discordBridge into config.discordBridge, the same way it already does for scraps/action/cli/image');

const syncBackendStart = appJs.indexOf('async function syncBackendConfig()');
const syncBackendEnd = appJs.indexOf('\n  }', appJs.indexOf('applyImeGuardianCapabilityDefault();', syncBackendStart));
assert(syncBackendStart > 0 && syncBackendEnd > syncBackendStart, 'syncBackendConfig not found');
const syncBackendSrc = appJs.slice(syncBackendStart, syncBackendEnd);
assert(/if \(fileConfig\.discordBridge\) \{\s*if \(!config\.discordBridge\) config\.discordBridge = \{\};\s*Object\.assign\(config\.discordBridge, fileConfig\.discordBridge\);\s*\}/.test(syncBackendSrc),
  'syncBackendConfig (the authoritative config.json load) must merge fileConfig.discordBridge into config.discordBridge, the same way it already does for scraps/action/cli/image');
console.log('PASS: discordBridge survives both the localStorage and backend config load paths (regression test).');

console.log('\nAll Discord bridge wiring tests passed.');
