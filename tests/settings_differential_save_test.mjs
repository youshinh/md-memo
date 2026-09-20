import fs from 'fs';
import assert from 'assert';

console.log("=== Testing Differential Save & Optimistic UI Logic in app.js ===");

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');

// 1. Check openedConfigSnapshot exists in openSettings
assert(appJs.includes('let openedConfigSnapshot = null;'), 'openedConfigSnapshot variable declared');
assert(appJs.includes('openedConfigSnapshot = JSON.parse(JSON.stringify(config));'), 'openedConfigSnapshot captured in openSettings');
console.log("PASS: Configuration snapshot initialization verified.");

// 2. Check differential git remote logic
assert(appJs.includes('curRemoteUrl !== prevRemoteUrl || curBranch !== prevBranch'), 'Differential check for git remote setup exists');
assert(!appJs.includes('window.backend.setupGitRemote(config.scraps.scrapDir, config.scraps.gitRemoteUrl, config.scraps.gitRemoteBranch).catch(() => {});\n    }'), 'Unconditional setupGitRemote removed from save button');
console.log("PASS: Unconditional git setup on save removed and differential check implemented.");

// 3. Check differential theme & language logic
assert(appJs.includes('if (config.general.theme !== prevGeneral.theme)'), 'Differential theme check exists');
assert(appJs.includes('if (config.general.language !== prevGeneral.language)'), 'Differential language check exists');
console.log("PASS: Differential UI updates for theme and language verified.");

// 4. Check Optimistic UI (immediate closeSettings and showMessage before savePersistentConfig)
const saveHandlerIdx = appJs.indexOf("document.getElementById('btn-save-settings').onclick");
const closeSettingsIdx = appJs.indexOf("closeSettings();", saveHandlerIdx);
const showMessageIdx = appJs.indexOf("showMessage(t('settingsSaved'), 2000);", saveHandlerIdx);
const savePersistentIdx = appJs.indexOf("savePersistentConfig()", saveHandlerIdx);

assert(closeSettingsIdx !== -1 && showMessageIdx !== -1 && savePersistentIdx !== -1, 'All key save calls exist in handler');
assert(closeSettingsIdx < savePersistentIdx, 'closeSettings occurs before savePersistentConfig background call (Optimistic UI)');
assert(showMessageIdx < savePersistentIdx, 'showMessage occurs before savePersistentConfig background call (Optimistic UI)');
console.log("PASS: Optimistic UI execution order verified (instant modal dismissal).");

// 5. Check taskkill non-blocking async execution in Windows
const ollamaWin = fs.readFileSync('ollama_ops_windows.go', 'utf8');
assert(ollamaWin.includes('_ = cmd.Start()'), 'cmd.Start() used instead of cmd.Run() for taskkill in Windows');
console.log("PASS: Non-blocking async process termination in ollama_ops_windows.go verified.");

console.log("\nALL DIFFERENTIAL SAVE & OPTIMISTIC UI EVALUATION TESTS PASSED (100%)!");
