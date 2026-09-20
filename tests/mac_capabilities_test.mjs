// Tests for the runtime OS-capabilities handling added for macOS support:
//   - IME Guardian defaults OFF for a brand-new config when nativeImeSwitch
//     is false, but a persisted/explicit value is never clobbered.
//   - The persistent IME-Guardian hint and the tray/Dock hint toggle their
//     visibility based on the fetched capabilities.
//   - Switching the settings-screen language to Japanese does not silently
//     re-enable IME Guardian when nativeImeSwitch is false.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

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

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

// Minimal element mock: just enough for classList.toggle/contains and .disabled.
function makeEl() {
  const classes = new Set();
  return {
    disabled: false,
    classList: {
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        }
        if (force) classes.add(c); else classes.delete(c);
        return force;
      },
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c)
    }
  };
}

function buildSandbox({ nativeImeSwitch = true, tray = true, hasPersisted = false, initialImeGuardian = false } = {}) {
  const elements = {
    'ime-guardian-os-hint': makeEl(),
    'tray-resident-os-hint': makeEl(),
    'cfg-tray-resident': makeEl()
  };
  const config = { general: { imeGuardian: initialImeGuardian } };
  const platformCapabilities = { os: 'darwin', nativeImeSwitch, tray, globalHotkey: true };
  const context = vm.createContext({
    console,
    config,
    platformCapabilities,
    hasPersistedImeGuardianSetting: hasPersisted,
    document: { getElementById: (id) => elements[id] || null }
  });

  const code = [
    extractFunction(appCode, 'applyImeGuardianCapabilityDefault'),
    extractFunction(appCode, 'updateImeGuardianCapabilityHint'),
    extractFunction(appCode, 'applyTrayCapabilityUI')
  ].join('\n');

  vm.runInContext(`${code}
    globalThis.__applyIme = applyImeGuardianCapabilityDefault;
    globalThis.__updateImeHint = updateImeGuardianCapabilityHint;
    globalThis.__applyTray = applyTrayCapabilityUI;
  `, context);

  return { context, elements, config };
}

check('new config (nothing persisted) on an OS without native IME switch defaults IME Guardian OFF', () => {
  const { context, elements, config } = buildSandbox({ nativeImeSwitch: false, hasPersisted: false, initialImeGuardian: true });
  context.__applyIme();
  assert.equal(config.general.imeGuardian, false, 'imeGuardian should be forced off for a brand-new config');
  assert.equal(elements['ime-guardian-os-hint'].classList.contains('hidden'), false, 'hint should be visible when unsupported');
});

check('a config that already has an explicit imeGuardian value is never clobbered', () => {
  const { context, config } = buildSandbox({ nativeImeSwitch: false, hasPersisted: true, initialImeGuardian: true });
  context.__applyIme();
  assert.equal(config.general.imeGuardian, true, 'a persisted/explicit true value must survive the capability default');
});

check('when nativeImeSwitch is true (or unknown), the hint stays hidden and nothing is forced off', () => {
  const { context, elements, config } = buildSandbox({ nativeImeSwitch: true, hasPersisted: false, initialImeGuardian: true });
  context.__applyIme();
  assert.equal(config.general.imeGuardian, true, 'imeGuardian must be left alone when the OS supports native switching');
  assert.equal(elements['ime-guardian-os-hint'].classList.contains('hidden'), true, 'hint should stay hidden when supported');
});

check('updateImeGuardianCapabilityHint only toggles the hint, never config', () => {
  const { context, elements, config } = buildSandbox({ nativeImeSwitch: false, hasPersisted: true, initialImeGuardian: true });
  context.__updateImeHint();
  assert.equal(elements['ime-guardian-os-hint'].classList.contains('hidden'), false, 'hint becomes visible');
  assert.equal(config.general.imeGuardian, true, 'config must be untouched by the hint-only function');
});

check('applyTrayCapabilityUI disables the checkbox and shows the hint when tray is unsupported', () => {
  const { context, elements } = buildSandbox({ tray: false });
  context.__applyTray();
  assert.equal(elements['cfg-tray-resident'].disabled, true, 'checkbox should be disabled when tray is unsupported');
  assert.equal(elements['tray-resident-os-hint'].classList.contains('hidden'), false, 'hint should be visible when tray is unsupported');
});

check('applyTrayCapabilityUI leaves the checkbox enabled and hint hidden when tray is supported', () => {
  const { context, elements } = buildSandbox({ tray: true });
  context.__applyTray();
  assert.equal(elements['cfg-tray-resident'].disabled, false);
  assert.equal(elements['tray-resident-os-hint'].classList.contains('hidden'), true);
});

// ---------------------------------------------------------------------------
// The settings-screen language <select> onchange handler must not auto-check
// IME Guardian when nativeImeSwitch is false (source-level check, since the
// full onchange handler lives inside a large IIFE closure not designed for
// standalone extraction).
// ---------------------------------------------------------------------------
check('the language-select onchange handler gates the IME Guardian auto-check on platformCapabilities.nativeImeSwitch', () => {
  const onchangeStart = appCode.indexOf('cfgLanguageSelect.onchange = () => {');
  assert.ok(onchangeStart !== -1, 'cfgLanguageSelect.onchange handler found');
  const onchangeBody = appCode.substring(onchangeStart, onchangeStart + 700);
  assert.ok(
    onchangeBody.includes("if (imeCheckbox && platformCapabilities.nativeImeSwitch !== false)"),
    'the auto-check must be gated on platformCapabilities.nativeImeSwitch, not run unconditionally'
  );
});

if (failures > 0) {
  console.error(`\n${failures} mac capability test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll mac capability tests passed with 0 error(s)!');
