import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

console.log('=== Testing Dynamic Agent Selection Population Logic ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');

// Verify that populateAgentSelectOptions is defined in app.js
assert.ok(appJs.includes('function populateAgentSelectOptions(slotCfg)'), 'populateAgentSelectOptions function must exist');

// Mock DOM elements
class MockElement {
  constructor(id) {
    this.id = id;
    this.options = [];
    this.value = '';
    this.selectedIndex = 0;
    this.innerHTML = '';
    this.disabled = false;
  }
  appendChild(child) {
    this.options.push(child);
    if (this.options.length === 1) {
      this.value = child.value;
      this.selectedIndex = 0;
    }
  }
}

class MockOption {
  constructor() {
    this.value = '';
    this.textContent = '';
  }
}

global.document = {
  getElementById: (id) => {
    if (id === 'cfg-default-agent') return defaultAgentEl;
    return null;
  },
  createElement: (tag) => {
    if (tag === 'option') return new MockOption();
    return new MockElement(tag);
  }
};

const defaultAgentEl = new MockElement('cfg-default-agent');
global.config = { default_agent: 'agy' };

// Extract and test populateAgentSelectOptions
const fnMatch = appJs.match(/function populateAgentSelectOptions\(slotCfg\) \{[\s\S]*?\n  \}/);
if (!fnMatch) {
  throw new Error('Could not find populateAgentSelectOptions in app.js');
}

const populateAgentSelectOptions = new Function('slotCfg', 'config', 'document', `
  ${fnMatch[0]}
  return populateAgentSelectOptions(slotCfg);
`);

// Test with mock SlotConfig from agents.yaml
const mockSlotConfig = {
  version: 2,
  default_agent: "agy",
  agents: {
    "claude-code": {
      command: "claude",
      args: ["--file", "{file}", "--prompt", "{instruction}"],
      description: "Claude Code (高知能・CLI操作・Web調査)"
    },
    "agy": {
      command: "agy",
      args: ["exec", "--file", "{file}"],
      description: "Google Antigravity 2.0 (自律型AIペアエンジニア)"
    },
    "custom-agent": {
      command: "my-custom-cli",
      args: ["run", "{instruction}"],
      description: "My Custom Agent"
    },
    "plain": {
      command: "plain-cli",
      args: ["{instruction}"]
    }
  }
};

populateAgentSelectOptions(mockSlotConfig, global.config, global.document);

assert.strictEqual(defaultAgentEl.options.length, 4, 'Should have 4 options populated');
assert.strictEqual(defaultAgentEl.options[0].value, 'claude-code');
assert.strictEqual(defaultAgentEl.options[1].value, 'agy');
assert.strictEqual(defaultAgentEl.options[2].value, 'custom-agent');
assert.ok(defaultAgentEl.options[1].textContent.includes('Google Antigravity 2.0'));
// The option label is "key - description": the key is what agents.yaml and {{ @key }} use, the description says what the
// agent is. The full command line (e.g. agy's --dangerously-skip-permissions default) is long enough on its own to make
// every option in the dropdown equally unreadable, so it must not be appended here. It remains visible in agents.yaml and,
// when relevant, in the auto-approve warning.
assert.ok(!defaultAgentEl.options[2].textContent.includes('my-custom-cli'), 'option label must not include the raw command');
assert.strictEqual(defaultAgentEl.options[0].textContent, 'claude-code - Claude Code (高知能・CLI操作・Web調査)');
assert.strictEqual(defaultAgentEl.options[1].textContent, 'agy - Google Antigravity 2.0 (自律型AIペアエンジニア)');
assert.strictEqual(defaultAgentEl.options[2].textContent, 'custom-agent - My Custom Agent');
assert.strictEqual(defaultAgentEl.options[3].textContent, 'plain', 'no description: just the key');
assert.strictEqual(defaultAgentEl.value, 'agy', 'default_agent "agy" must be selected');
assert.strictEqual(defaultAgentEl.disabled, false);

console.log('PASS: Dynamic agent options populated correctly with custom agents.');

// A disabled agent is not listed (the Go side leaves it out; an entry that still says enabled: false is skipped too), and a
// default_agent that is not offered leaves the first option selected.
{
  const cfg = {
    default_agent: 'agy',
    disabled_agents: ['agy', 'hermes'],
    agents: {
      'claude-code': { command: 'claude', description: 'Claude Code' },
      agy: { command: 'agy', description: 'Antigravity', enabled: false },
      codex: { command: 'codex', description: 'Codex' }
    }
  };
  const el = new MockElement('cfg-default-agent');
  const doc = { getElementById: (id) => (id === 'cfg-default-agent' ? el : null), createElement: () => new MockOption() };
  new Function('slotCfg', 'config', 'document', `${fnMatch[0]}; return populateAgentSelectOptions(slotCfg);`)(cfg, { default_agent: 'agy' }, doc);
  assert.deepStrictEqual(el.options.map((o) => o.value), ['claude-code', 'codex'], 'agy (enabled: false) and hermes (not present) are not offered');
  assert.strictEqual(el.value, 'claude-code', 'the disabled default is not selected: the first offered agent is');
  assert.ok(!el.options.some((o) => /Antigravity|hermes/i.test(o.textContent)));
  console.log('PASS: A disabled agent is not offered in the dropdown.');
}

// Every agent disabled: one placeholder, nothing to pick, and the saved default is left alone (the select is empty)
{
  const el = new MockElement('cfg-default-agent');
  const doc = { getElementById: (id) => (id === 'cfg-default-agent' ? el : null), createElement: () => new MockOption() };
  const cfg = { default_agent: '', disabled_agents: ['agy', 'claude-code'], agents: {} };
  const conf = { default_agent: 'claude-code' };
  new Function('slotCfg', 'config', 'document', `${fnMatch[0]}; return populateAgentSelectOptions(slotCfg);`)(cfg, conf, doc);
  assert.strictEqual(el.options.length, 1);
  assert.strictEqual(el.options[0].value, '');
  assert.strictEqual(el.disabled, true, 'nothing to choose');
  assert.strictEqual(conf.default_agent, 'claude-code', 'the configured default is not changed by an empty list');
  // and back to normal when agents are enabled again (the mock's innerHTML = '' does not clear options as a real select does)
  el.options = [];
  new Function('slotCfg', 'config', 'document', `${fnMatch[0]}; return populateAgentSelectOptions(slotCfg);`)({ default_agent: 'codex', agents: { codex: { command: 'codex' } } }, conf, doc);
  assert.strictEqual(el.disabled, false);
  assert.deepStrictEqual(el.options.map((o) => o.value), ['codex']);
  console.log('PASS: With every agent disabled the dropdown offers none.');
}

// The line under the select that names the disabled agents (Settings > Agent): only when there are any, in both languages
{
  const noteMatch = appJs.match(/function renderAgentDisabledNote\(slotCfg\) \{[\s\S]*?\n  \}/);
  assert.ok(noteMatch, 'renderAgentDisabledNote must exist in app.js');
  const i18n = {};
  vm.createContext(i18n);
  vm.runInContext(fs.readFileSync('frontend/js/i18n.js', 'utf8') + '; this.I18N = I18N;', i18n);
  const tFor = (lang) => (key, params) => String(i18n.I18N[lang][key]).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? params[name] : m));
  const makeNote = () => {
    const classes = new Set(['hidden']);
    return {
      textContent: '',
      classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) }
    };
  };
  const run = (cfg, lang) => {
    const note = makeNote();
    const doc = { getElementById: (id) => (id === 'agent-disabled-note' ? note : null) };
    new Function('slotCfg', 't', 'document', `${noteMatch[0]}; return renderAgentDisabledNote(slotCfg);`)(cfg, tFor(lang), doc);
    return note;
  };

  let note = run({ disabled_agents: ['agy', 'hermes'] }, 'en');
  assert.strictEqual(note.textContent, 'Disabled in agents.yaml: agy, hermes');
  assert.strictEqual(note.classList.contains('hidden'), false);
  note = run({ disabled_agents: ['agy', 'hermes'] }, 'ja');
  assert.strictEqual(note.textContent, 'agents.yaml で無効: agy, hermes');
  for (const cfg of [{}, { disabled_agents: [] }, { disabled_agents: ['', 5, null] }, null]) {
    note = run(cfg, 'en');
    assert.strictEqual(note.classList.contains('hidden'), true, 'no note without disabled agents: ' + JSON.stringify(cfg));
    assert.strictEqual(note.textContent, '');
  }
  assert.ok(fs.readFileSync('frontend/index.html', 'utf8').includes('id="agent-disabled-note"'), 'the line exists in the Settings page');
  assert.ok(appJs.includes('renderAgentDisabledNote(slotCfg);\n          renderAgentIssues(slotCfg);') || /renderAgentDisabledNote\(slotCfg\);\s*renderAgentIssues\(slotCfg\);/.test(appJs), 'it is rendered with the list');
  console.log('PASS: The Settings line names the disabled agents (en / ja), only when there are any.');
}
