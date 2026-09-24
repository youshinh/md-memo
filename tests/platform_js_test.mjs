// Tests for frontend/js/platform.js (window.MDMemoPlatform), loaded in isolation
// (the way jev_action.js / slot_agent.js / task_manager.js load it) with fake
// `navigator` variants, so the Mac-only branches get real coverage instead of
// only ever running on a Windows CI/dev box.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const platformCode = fs.readFileSync(path.resolve('frontend/js/platform.js'), 'utf-8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
  }
}

// Loads platform.js fresh into its own VM context with the given `navigator`,
// and returns the window.MDMemoPlatform object it produces.
function loadPlatform(navigatorMock) {
  const windowObj = {};
  const context = vm.createContext({ window: windowObj, navigator: navigatorMock, console });
  vm.runInContext(platformCode, context);
  return context.window.MDMemoPlatform;
}

// ---------------------------------------------------------------------------
// isMac detection across navigator variants
// ---------------------------------------------------------------------------
check('navigator.platform "MacIntel" is detected as Mac', () => {
  const p = loadPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  assert.equal(p.isMac, true);
  assert.equal(p.modLabel, 'Cmd');
  assert.equal(p.altLabel, 'Option');
});

check('empty platform, Macintosh in userAgent falls back to the userAgent check', () => {
  const p = loadPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit' });
  assert.equal(p.isMac, true);
});

check('navigator.platform "Win32" is not Mac', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  assert.equal(p.isMac, false);
  assert.equal(p.modLabel, 'Ctrl');
  assert.equal(p.altLabel, 'Alt');
});

check('an iPad (MacIntel-spoofed or iPadOS userAgent) counts as Mac-family', () => {
  const p = loadPlatform({ platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' });
  assert.equal(p.isMac, true);
});

check('no navigator at all (undefined) does not throw and defaults to non-Mac', () => {
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(platformCode, context);
  assert.equal(context.window.MDMemoPlatform.isMac, false);
});

// ---------------------------------------------------------------------------
// isModKey: Cmd on Mac, Ctrl elsewhere; does NOT fold Ctrl->Cmd on macOS
// ---------------------------------------------------------------------------
check('isModKey on macOS looks at metaKey, not ctrlKey', () => {
  const p = loadPlatform({ platform: 'MacIntel', userAgent: 'Macintosh' });
  assert.equal(p.isModKey({ metaKey: true, ctrlKey: false }), true);
  assert.equal(p.isModKey({ metaKey: false, ctrlKey: true }), false, 'Ctrl alone is not the mod key on macOS');
});

check('isModKey on Windows looks at ctrlKey, not metaKey', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.isModKey({ metaKey: false, ctrlKey: true }), true);
  assert.equal(p.isModKey({ metaKey: true, ctrlKey: false }), false, 'Meta alone is not the mod key on Windows');
});

check('isModKey handles a missing/null event gracefully', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.isModKey(null), false);
  assert.equal(p.isModKey(undefined), false);
});

// ---------------------------------------------------------------------------
// codeLetter / codeDigit
// ---------------------------------------------------------------------------
check('codeLetter extracts the physical letter from KeyX-style codes', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.codeLetter({ code: 'KeyT' }), 'T');
  assert.equal(p.codeLetter({ code: 'KeyA' }), 'A');
});

check('codeLetter returns "" for non-letter codes (negative cases)', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.codeLetter({ code: 'Digit1' }), '');
  assert.equal(p.codeLetter({ code: 'Space' }), '');
  assert.equal(p.codeLetter({ code: '' }), '');
  assert.equal(p.codeLetter({}), '');
  assert.equal(p.codeLetter(null), '');
  assert.equal(p.codeLetter({ code: 'Key' }), '', 'too short to have a letter');
  assert.equal(p.codeLetter({ code: 'KeyAB' }), '', 'too long');
});

check('codeDigit extracts the physical digit from Digit/Numpad codes', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.codeDigit({ code: 'Digit1' }), '1');
  assert.equal(p.codeDigit({ code: 'Digit0' }), '0');
  assert.equal(p.codeDigit({ code: 'Numpad5' }), '5');
});

check('codeDigit returns "" for non-digit codes (negative cases)', () => {
  const p = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(p.codeDigit({ code: 'KeyT' }), '');
  assert.equal(p.codeDigit({ code: 'NumpadEnter' }), '', 'Numpad code whose suffix is not a digit');
  assert.equal(p.codeDigit({ code: '' }), '');
  assert.equal(p.codeDigit({}), '');
  assert.equal(p.codeDigit(null), '');
});

// ---------------------------------------------------------------------------
// The exposed surface is read-only / consistent across the object
// ---------------------------------------------------------------------------
check('modLabel/altLabel are consistent with isMac on every variant tested', () => {
  const mac = loadPlatform({ platform: 'MacIntel', userAgent: 'Macintosh' });
  const win = loadPlatform({ platform: 'Win32', userAgent: 'Windows' });
  assert.equal(mac.modLabel, 'Cmd');
  assert.equal(mac.altLabel, 'Option');
  assert.equal(win.modLabel, 'Ctrl');
  assert.equal(win.altLabel, 'Alt');
});

if (failures > 0) {
  console.error(`\n${failures} platform.js test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll platform.js tests passed with 0 error(s)!');
