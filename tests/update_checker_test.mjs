import fs from 'fs';
import assert from 'assert';

console.log('=== Testing Update Checker Logic & Version Comparison ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');

// Extract isNewerVersion function from app.js
const isNewerVersionMatch = appJs.match(/function isNewerVersion\(latest, current\) \{[\s\S]*?\n  \}/);
if (!isNewerVersionMatch) {
  throw new Error('Could not find isNewerVersion in app.js');
}

const isNewerVersion = new Function('latest', 'current', `${isNewerVersionMatch[0]}; return isNewerVersion(latest, current);`);

// 1. Version comparison unit tests
assert.strictEqual(isNewerVersion('1.5.5', '1.5.5'), false, 'Same version 1.5.5 should NOT be newer');
assert.strictEqual(isNewerVersion('1.5.4', '1.5.5'), false, 'Older version 1.5.4 should NOT be newer than 1.5.5');
assert.strictEqual(isNewerVersion('1.5.6', '1.5.5'), true, 'Newer patch version 1.5.6 should be newer than 1.5.5');
assert.strictEqual(isNewerVersion('1.6.0', '1.5.5'), true, 'Newer minor version 1.6.0 should be newer than 1.5.5');
assert.strictEqual(isNewerVersion('2.0.0', '1.5.5'), true, 'Newer major version 2.0.0 should be newer than 1.5.5');
assert.strictEqual(isNewerVersion('1.5.5', '1.1.0'), true, 'Regression check: 1.5.5 was newer than the old hardcoded 1.1.0');

console.log('PASS: isNewerVersion unit tests passed.');

// 2. Verify checkForAppUpdates uses dynamic version and fallback
assert.ok(appJs.includes("currentVersion = '1.10.0'"), 'Default fallback version must be 1.10.0');
assert.ok(appJs.includes('window.backend.getAppVersion'), 'Must check window.backend.getAppVersion');
assert.ok(appJs.includes('mdmemo_dismissed_update_version'), 'Must support dismissed version state');

console.log('PASS: app.js contains dynamic backend version check and dismissal logic.');
