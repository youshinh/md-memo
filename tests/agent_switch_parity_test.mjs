// Switching agents off (enabled: false / disabled_agents): the frontend copy of the rules and its parity with the Go side.
//   - pkg/slotagent/enabled.go       finalizeAgents, agentFallbackOrder, RunProblem sentences (Go, the source of truth)
//   - frontend/js/slot_agent.js      finalizeAgentConfig, AGENT_FALLBACK_ORDER
//   - frontend/js/i18n.js            the same sentences in the UI language
// The Go rules are tested in pkg/slotagent/enabled_test.go; the table below is the same table with the same answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const goEnabled = read('pkg/slotagent/enabled.go');
const goConfig = read('pkg/slotagent/config.go');
const jsSlot = read('frontend/js/slot_agent.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}`);
  }
}

// ---- slot_agent.js under the smallest browser mock ------------------------------------------------------------------
global.document = {
  body: { appendChild: () => {} },
  createElement: () => ({ id: '', className: '', classList: { add() {}, remove() {}, contains: () => false }, style: {}, querySelectorAll: () => [], addEventListener: () => {} }),
  getElementById: () => null,
  querySelector: () => null
};
global.window = { innerWidth: 1024, innerHeight: 768 };
require('../frontend/js/slot_agent.js');
const SlotAgent = global.window.SlotAgent;
const finalize = (cfg) => SlotAgent._finalizeAgentConfig(JSON.parse(JSON.stringify(cfg)));

const A = { command: 'a' };
const base = () => ({
  'claude-code': { command: 'claude', aliases: ['claude', 'cc'] },
  hermes: { command: 'ollama' },
  codex: { command: 'codex' },
  agy: { command: 'agy', aliases: ['antigravity', 'gemini'] }
});
const keys = (cfg) => Object.keys(cfg.agents).sort();

// ---- finalizeAgentConfig: the same answers as slotagent.finalizeAgents ----------------------------------------------
check('disabled_agents and enabled: false take agents out, either spelling, any case; the list is sorted and merged', () => {
  const cases = [
    ['disabled_agents', { agents: base(), disabled_agents: ['agy'] }, ['claude-code', 'codex', 'hermes'], ['agy']],
    ['other case', { agents: base(), disabled_agents: ['AGY'] }, ['claude-code', 'codex', 'hermes'], ['agy']],
    ['enabled: false', { agents: Object.assign(base(), { agy: { command: 'agy', enabled: false } }) }, ['claude-code', 'codex', 'hermes'], ['agy']],
    ['both spellings, one agent', { agents: Object.assign(base(), { agy: { command: 'agy', enabled: false } }), disabled_agents: ['agy'] }, ['claude-code', 'codex', 'hermes'], ['agy']],
    ['both spellings, two agents', { agents: Object.assign(base(), { agy: { command: 'agy', enabled: false } }), disabled_agents: ['hermes'] }, ['claude-code', 'codex'], ['agy', 'hermes']],
    ['enabled: true does not beat the list', { agents: Object.assign(base(), { agy: { command: 'agy', enabled: true } }), disabled_agents: ['agy'] }, ['claude-code', 'codex', 'hermes'], ['agy']],
    ['enabled: true alone', { agents: Object.assign(base(), { agy: { command: 'agy', enabled: true } }) }, ['agy', 'claude-code', 'codex', 'hermes'], []],
    ['an unknown key is only listed', { agents: base(), disabled_agents: ['nobody'] }, ['agy', 'claude-code', 'codex', 'hermes'], ['nobody']],
    ['blank entries are ignored', { agents: base(), disabled_agents: ['', '  ', null] }, ['agy', 'claude-code', 'codex', 'hermes'], []],
    ['a listed key takes the spelling of its agents entry', { agents: { Mine: A, other: A }, disabled_agents: ['mine'] }, ['other'], ['Mine']]
  ];
  for (const [name, input, wantAgents, wantDisabled] of cases) {
    const out = finalize(input);
    assert.deepEqual(keys(out), wantAgents, name);
    assert.deepEqual(JSON.parse(JSON.stringify(out.disabled_agents)), wantDisabled, name);
  }
});

check('the default agent falls back in the fixed order; the note about it is the Go side\'s (agent_issues)', () => {
  const rows = [
    ['default stays when enabled', ['agy'], 'claude-code', 'claude-code'],
    ['a disabled default: the first enabled in the fixed order', ['claude-code'], 'claude-code', 'hermes'],
    ['the next in the order', ['claude-code', 'hermes'], 'claude-code', 'codex'],
    ['and the next', ['claude-code', 'hermes', 'codex'], 'hermes', 'agy'],
    ['another case', ['agy'], 'AGY', 'claude-code'],
    ['an unknown default that is not disabled: unchanged', ['agy'], 'nobody', 'nobody']
  ];
  for (const [name, disabled, dflt, want] of rows) {
    assert.equal(finalize({ agents: base(), disabled_agents: disabled, default_agent: dflt }).default_agent, want, name);
  }
  // then the other agents by key
  const out = finalize({ agents: { zed: A, abe: A, 'claude-code': A, hermes: A, codex: A, agy: A }, disabled_agents: ['claude-code', 'hermes', 'codex', 'agy'], default_agent: 'claude-code' });
  assert.equal(out.default_agent, 'abe');
  // an unknown default with claude-code disabled: not the claude-code fallback
  assert.equal(finalize({ agents: base(), disabled_agents: ['claude-code'], default_agent: 'gone' }).default_agent, 'hermes');
  // an agent without a command is not a usable default
  assert.equal(finalize({ agents: { hermes: { command: '' }, codex: { command: 'codex' } }, disabled_agents: ['claude-code'], default_agent: 'claude-code' }).default_agent, 'codex');
});

check('every agent disabled: no agents, no default, the list keeps every key', () => {
  const out = finalize({ agents: base(), disabled_agents: ['claude-code', 'hermes', 'codex', 'agy'], default_agent: 'claude-code' });
  assert.deepEqual(keys(out), []);
  assert.equal(out.default_agent, '');
  assert.deepEqual(JSON.parse(JSON.stringify(out.disabled_agents)), ['agy', 'claude-code', 'codex', 'hermes']);
});

check('nothing disabled changes nothing (and the object it was given is never edited)', () => {
  const agents = base();
  const cfg = { agents, default_agent: 'agy' };
  const out = SlotAgent._finalizeAgentConfig(cfg);
  assert.equal(out.agents, agents, 'the same agents object when nothing is switched off');
  assert.deepEqual(out.disabled_agents, []);
  assert.equal(out.default_agent, 'agy');

  const persisted = base();
  const cfg2 = { agents: persisted, disabled_agents: ['agy'] };
  const out2 = SlotAgent._finalizeAgentConfig(cfg2);
  assert.deepEqual(Object.keys(persisted).sort(), ['agy', 'claude-code', 'codex', 'hermes'], 'the input object keeps its entries');
  assert.notEqual(out2.agents, persisted);
});

check('finalising twice is the same as once (the page does it after every merge)', () => {
  const once = finalize({ agents: base(), disabled_agents: ['agy', 'claude-code'], default_agent: 'claude-code' });
  const twice = SlotAgent._finalizeAgentConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

// ---- parity with the Go source ----------------------------------------------------------------------------------------
check('the fallback order is the same list in Go and JS, and the order the built-in agents are written in', () => {
  const go = /var agentFallbackOrder = \[\]string\{([^}]*)\}/.exec(goEnabled);
  const js = /const AGENT_FALLBACK_ORDER = \[([^\]]*)\];/.exec(jsSlot);
  assert.ok(go && js, 'both lists exist');
  const strings = (text) => [...text.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(strings(go[1]), strings(js[1]));
  const block = goConfig.slice(goConfig.indexOf('Agents: map[string]AgentDef{'), goConfig.indexOf('SlotProfiles: []SlotProfile{'));
  const written = [...block.matchAll(/^\t\t\t"([a-z-]+)": \{/gm)].map((m) => m[1]);
  assert.deepEqual(written, strings(go[1]), 'DefaultSlotConfig lists the agents in the fallback order');
});

check('Go wire names: AgentDef.enabled, SlotConfig.disabled_agents, RunProblem, the default-disabled issue', () => {
  assert.match(goConfig, /Enabled\s+\*bool\s+`json:"enabled,omitempty" yaml:"enabled,omitempty"`/);
  assert.match(goConfig, /DisabledAgents\s+\[\]string\s+`json:"disabled_agents,omitempty" yaml:"disabled_agents,omitempty"`/);
  assert.match(goConfig, /DefaultAgentDisabled\s+string\s+`json:"-" yaml:"-"`/, 'derived: never on the wire');
  assert.match(goEnabled, /ProblemDisabled\s+= "disabled"/);
  assert.match(goEnabled, /ProblemNoneEnabled\s+= "none-enabled"/);
  assert.match(goEnabled, /ProblemMissing\s+= "missing"/);
  assert.match(goEnabled, /`json:"kind"`/);
  const safety = read('pkg/slotagent/safety.go');
  assert.match(safety, /IssueDefaultDisabled = "default-disabled"/);
  const app = read('app_slot.go');
  assert.match(app, /RunProblem\s+\*slotagent\.RunProblem\s+`json:"runProblem,omitempty"`/);
  assert.match(app, /Problem\s+\*slotagent\.RunProblem\s+`json:"problem,omitempty"`/);
});

// ---- the sentences: Go and the UI dictionary say the same -------------------------------------------------------------
const i18n = {};
vm.createContext(i18n);
vm.runInContext(read('frontend/js/i18n.js') + '; this.I18N = I18N;', i18n);
const I18N = i18n.I18N;

check('RunProblem sentences (Go, English and Japanese) are the i18n texts', () => {
  const sentences = [...goEnabled.matchAll(/(?:Sprintf\()?`([^`]+)`/g)].map((m) => m[1]);
  const want = {
    agentRunDisabled: ['Agent "%s" is disabled in agents.yaml (enabled: false)', 'エージェント「%s」は agents.yaml で無効です (enabled: false)', ['agent']],
    agentRunMissing: ['Agent "%s" needs "%s", which was not found in PATH. Install it or choose another agent in agents.yaml.', 'エージェント「%s」には「%s」が必要ですが、PATH に見つかりません。インストールするか、agents.yaml で別のエージェントを選んでください。', ['agent', 'command']]
  };
  for (const [key, [en, ja, params]] of Object.entries(want)) {
    assert.ok(sentences.includes(en), `Go has the English sentence of ${key}`);
    assert.ok(sentences.includes(ja), `Go has the Japanese sentence of ${key}`);
    let i = 0;
    const fill = (tpl) => tpl.replace(/%s/g, () => `{${params[i++ % params.length]}}`);
    assert.equal(I18N.en[key], fill(en), `en ${key}`);
    i = 0;
    assert.equal(I18N.ja[key], fill(ja), `ja ${key}`);
  }
  const noneEn = 'No agent is enabled: every agent is disabled in agents.yaml (enabled: false)';
  const noneJa = '有効なエージェントがありません: agents.yaml のすべてのエージェントが無効です (enabled: false)';
  assert.ok(goEnabled.includes(`"${noneEn}"`) && goEnabled.includes(`"${noneJa}"`));
  assert.equal(I18N.en.agentRunNoneEnabled, noneEn);
  assert.equal(I18N.ja.agentRunNoneEnabled, noneJa);
});

check('the new UI strings exist in English and Japanese with the same placeholders', () => {
  const keysWanted = ['agentRunDisabled', 'agentRunNoneEnabled', 'agentRunMissing', 'slotPresetMissing', 'agentDisabledNote', 'agentNoneEnabled', 'agentIssueDefaultDisabled', 'agentIssueDefaultDisabledNone'];
  for (const key of keysWanted) {
    assert.ok(I18N.en[key] && I18N.ja[key], key);
    const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    assert.equal(placeholders(I18N.en[key]), placeholders(I18N.ja[key]), `${key}: same placeholders`);
  }
  assert.equal(I18N.en.agentDisabledNote, 'Disabled in agents.yaml: {agents}');
  assert.equal(I18N.ja.agentDisabledNote, 'agents.yaml で無効: {agents}');
});

// ---- the pure modules -----------------------------------------------------------------------------------------------
const AS = require('../frontend/js/auto_selector.js');
const Snippets = require('../frontend/js/slot_snippets.js');
const AgentRisk = require('../frontend/js/agent_risk.js');

check('auto selector: a disabled agent is not a task; "@key" of one is its own verdict; aliases are free', () => {
  const agents = { 'claude-code': { command: 'c', aliases: ['claude', 'cc'] } }; // agy and its aliases are gone
  assert.equal(AS.findTaskAt('{{ @agy x }}', 3, undefined, { agents }), null);
  assert.equal(AS.findTaskAt('{{ @gemini x }}', 3, undefined, { agents }), null);
  assert.equal(AS.findTaskAt('{{ @cc x }}', 3, undefined, { agents }).agent, 'claude-code');

  const off = { agents, disabledAgents: ['agy'] };
  let v = AS.classify('@agy fix it', off);
  assert.deepEqual([v.kind, v.target, v.reason, v.agent], ['unknown', 'agent', 'disabled-agent', 'agy']);
  v = AS.classify('@AGY: fix it', off);
  assert.equal(v.reason, 'disabled-agent');
  assert.equal(v.agent, 'agy', 'the key as listed');
  v = AS.classify('@gemini fix it', off);
  assert.equal(v.reason, 'mention-not-agent', 'a freed alias is an ordinary mention');
  v = AS.classify('@cc fix it', off);
  assert.equal(v.reason, 'explicit-agent');
  assert.equal(AS.classify('@agy fix it', { agents }).reason, 'mention-not-agent', 'without the list: as before');
});

check('auto selector: with no agent list the built-in defaults are used, without the disabled ones', () => {
  assert.equal(AS.findTaskAt('{{ @agy x }}', 3, undefined, {}).agent, 'agy', 'no list, nothing disabled: the defaults');
  const off = { disabledAgents: ['agy'] };
  assert.equal(AS.findTaskAt('{{ @agy x }}', 3, undefined, off), null);
  assert.equal(AS.findTaskAt('{{ @gemini x }}', 3, undefined, off), null);
  assert.equal(AS.findTaskAt('{{ @cc x }}', 3, undefined, off).agent, 'claude-code');
  assert.equal(AS.findTaskAt('{{ @hermes x }}', 3, undefined, { disabledAgents: ['HERMES'] }), null, 'any case');
});

check('auto selector: an entry that says enabled: false is not an agent either', () => {
  const agents = { 'claude-code': { command: 'c' }, agy: { command: 'agy', enabled: false, aliases: ['gemini'] } };
  assert.equal(AS.findTaskAt('{{ @agy x }}', 3, undefined, { agents }), null);
  assert.equal(AS.findTaskAt('{{ @gemini x }}', 3, undefined, { agents }), null);
  assert.equal(AS.findTaskAt('{{ @claude-code x }}', 3, undefined, { agents }).agent, 'claude-code');
});

check('snippets: pickAgent never picks a disabled agent', () => {
  const snippet = { id: 's', label: 'S', kind: 'agent', agent: 'agy', body: 'go$0' };
  const expand = (ctx) => Snippets.expand(snippet, ctx).text;
  const agents = { 'claude-code': { command: 'c' }, codex: { command: 'x' } };
  assert.equal(expand({ agents, defaultAgent: 'codex' }), '{{ @codex go }}', "the snippet's agent is not there: the default agent");
  assert.equal(expand({ agents: { agy: { command: 'a', enabled: false }, codex: { command: 'x' } }, defaultAgent: 'agy' }), '{{ @codex go }}', 'enabled: false is skipped for the snippet and for the default');
  assert.equal(expand({ agents: {}, disabledAgents: ['agy'], defaultAgent: 'codex' }), '{{ @codex go }}', 'no agent list: the first wanted name that is not disabled');
  assert.equal(expand({ agents: {}, disabledAgents: ['agy', 'claude-code'] }), '{{ @agy go }}', 'nothing is enabled: the name is kept, the run will say so');
  assert.equal(expand({ defaultAgent: 'hermes' }), '{{ @agy go }}', 'without a list at all: as before');
  // a list that still holds an agent that disabledAgents names (a stale copy): not picked either
  assert.equal(expand({ agents: { agy: { command: 'a' }, codex: { command: 'x' } }, disabledAgents: ['agy'], defaultAgent: 'agy' }), '{{ @codex go }}', 'listed as disabled: skipped even when the list has it');
  assert.equal(expand({ agents: ['agy', 'codex'], disabledAgents: ['AGY'] }), '{{ @codex go }}', 'an array of names, any case');
});

check('agent issues: default-disabled has its own text (English and Japanese, with and without a fallback)', () => {
  const tr = (lang) => (key) => I18N[lang][key];
  const issue = { agent: 'agy', kind: 'default-disabled', detail: 'claude-code' };
  assert.equal(AgentRisk.issueText(tr('en'), issue), 'agy: default_agent names this agent, but it is disabled in agents.yaml (enabled: false or disabled_agents), so claude-code is the default agent.');
  assert.match(AgentRisk.issueText(tr('ja'), issue), /^agy: default_agent がこのエージェントを指していますが.*claude-code が既定/);
  const none = { agent: 'agy', kind: 'default-disabled', detail: '' };
  assert.match(AgentRisk.issueText(tr('en'), none), /no other agent is enabled/);
  assert.match(AgentRisk.issueText(tr('ja'), none), /ほかに有効なエージェントもありません/);
  assert.ok(AgentRisk.issuesSignature([issue]), 'it counts as an issue (status-bar notice, Settings list)');
  assert.notEqual(AgentRisk.issuesSignature([issue]), AgentRisk.issuesSignature([none]));
});

if (failures > 0) {
  console.error(`\n${failures} agent switch test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll agent switch tests passed.');
