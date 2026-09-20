import fs from 'fs';
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
    }
  }
};

populateAgentSelectOptions(mockSlotConfig, global.config, global.document);

assert.strictEqual(defaultAgentEl.options.length, 3, 'Should have 3 options populated');
assert.strictEqual(defaultAgentEl.options[0].value, 'claude-code');
assert.strictEqual(defaultAgentEl.options[1].value, 'agy');
assert.strictEqual(defaultAgentEl.options[2].value, 'custom-agent');
assert.ok(defaultAgentEl.options[1].textContent.includes('Google Antigravity 2.0'));
// The option label is the description ONLY - the full command line (e.g. agy's
// --dangerously-skip-permissions default) is long enough on its own to make every
// option in the dropdown equally unreadable, so it must not be appended here. It
// remains visible in agents.yaml and, when relevant, in the auto-approve warning.
assert.ok(!defaultAgentEl.options[2].textContent.includes('my-custom-cli'), 'option label must not include the raw command');
assert.strictEqual(defaultAgentEl.options[2].textContent, 'My Custom Agent');
assert.strictEqual(defaultAgentEl.value, 'agy', 'default_agent "agy" must be selected');

console.log('PASS: Dynamic agent options populated correctly with custom agents.');
