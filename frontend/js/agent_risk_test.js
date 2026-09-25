// Unit tests for agent_risk.js: which agent definitions are risky, the once-per-command-line confirmation, the notice
// about agent definitions (signature, start-up message, Settings list, the copied YAML), and the keys a settings
// package must never carry (config_pack.js). Nothing here touches a DOM beyond a tiny fake one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
const AR = require('./agent_risk.js');
const CP = require('./config_pack.js');

const risky = { command: 'agy', args: ['-p', 'Note: {file}\nTask: {instruction}', '--dangerously-skip-permissions'] };
const safe = { command: 'claude', args: ['-p', 'Note: {file}\nTask: {instruction}'] };

(function testFlagList() {
  for (const f of ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--auto-approve', '--allow-dangerously-skip-permissions']) {
    assert.ok(AR.AUTO_APPROVE_FLAGS.includes(f), f + ' is on the list the maintainer approved');
  }
  assert.ok(AR.AUTO_APPROVE_FLAGS.includes('--full-auto'), 'the Settings warning already knew --full-auto; the shared list keeps it');
  assert.ok(Object.isFrozen(AR.AUTO_APPROVE_FLAGS));
})();

(function testRiskFlags() {
  assert.deepStrictEqual(AR.riskFlags(risky), ['--dangerously-skip-permissions']);
  assert.deepStrictEqual(AR.riskFlags(safe), []);
  assert.deepStrictEqual(AR.riskFlags({ command: 'x', args: ['--YOLO', '--auto-approve=true', '--yolo-mode', '-p --yolo'] }), ['--YOLO', '--auto-approve=true'],
    'a whole argument or --flag=value, any case; a longer flag or a flag inside another argument is not one');
  assert.deepStrictEqual(AR.riskFlags({ command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '{instruction}'] }), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepStrictEqual(AR.riskFlags(null), []);
  assert.deepStrictEqual(AR.riskFlags({ command: 'x' }), []);
})();

(function testShellHazardMatchesGo() {
  const t = (command, args, append) => AR.shellHazard({ command: command, args: args, append_instruction: append });
  assert.strictEqual(t('powershell', ['-NoProfile']), 'powershell');
  assert.strictEqual(t('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE'), 'powershell');
  assert.strictEqual(t('/usr/bin/pwsh'), 'pwsh');
  assert.strictEqual(t('cmd.exe', ['/c', 'type']), 'cmd');
  assert.strictEqual(t('bash', ['-c', 'echo']), 'bash');
  assert.strictEqual(t('zsh'), 'zsh');
  assert.strictEqual(t('sh'), 'sh');
  assert.strictEqual(t('python3', ['-c', 'import sys']), '-c', 'a command switch is flagged even for another program (conservative)');
  assert.strictEqual(t('wsl', ['-e', 'bash', '-Command']), '-Command');
  assert.strictEqual(t('cmdtool', ['/C']), '/C');
  assert.strictEqual(t('powershell', ['-Command', 'Write-Output {instruction}']), '', 'the instruction goes where the user put it');
  assert.strictEqual(t('bash', ['-c', 'echo'], false), '', 'append_instruction: false appends nothing');
  assert.strictEqual(t('claude', ['-p', '{instruction}']), '');
  assert.strictEqual(t('ollama', ['run', 'hermes3']), '');
  assert.strictEqual(t('bashful', ['--cool']), '');

  assert.strictEqual(AR.appendsInstruction({ command: 'x', args: ['run'] }), true);
  assert.strictEqual(AR.appendsInstruction({ command: 'x', args: ['run'], append_instruction: true }), true);
  assert.strictEqual(AR.appendsInstruction({ command: 'x', args: ['run'], append_instruction: false }), false);
  assert.strictEqual(AR.appendsInstruction({ command: 'x', args: ['{instruction}'] }), false);

  // The lists are the Go side's (pkg/slotagent/safety.go), word for word.
  const go = fs.readFileSync(path.join(__dirname, '..', '..', 'pkg', 'slotagent', 'safety.go'), 'utf8');
  const keysOf = (name) => {
    const m = new RegExp(name + '\\s*=\\s*map\\[string\\]bool\\{([^}]*)\\}').exec(go);
    assert.ok(m, name + ' not found in safety.go');
    return [...m[1].matchAll(/"([^"]+)":\s*true/g)].map((x) => x[1]).sort();
  };
  assert.deepStrictEqual(keysOf('shellCommands'), AR.SHELL_COMMANDS.slice().sort());
  assert.deepStrictEqual(keysOf('shellCommandSwitches'), AR.SHELL_COMMAND_SWITCHES.slice().sort());
})();

(function testAssess() {
  assert.deepStrictEqual(AR.assess(risky), { risky: true, flags: ['--dangerously-skip-permissions'], shell: '' });
  assert.deepStrictEqual(AR.assess(safe), { risky: false, flags: [], shell: '' });
  assert.deepStrictEqual(AR.assess({ command: 'bash', args: ['-c'] }), { risky: true, flags: [], shell: 'bash' });
})();

(function testSignatureAndAcks() {
  const sig = AR.signature(risky);
  assert.ok(/^v1:[0-9a-f]+$/.test(sig), sig);
  assert.strictEqual(AR.signature(JSON.parse(JSON.stringify(risky))), sig, 'stable');
  assert.strictEqual(AR.signature(Object.assign({ description: 'other', aliases: ['x'] }, risky)), sig, 'description and aliases are not part of it');
  assert.strictEqual(AR.signature({ command: ' agy ', args: risky.args }), sig, 'surrounding spaces of the command are not');
  assert.notStrictEqual(AR.signature({ command: 'agy', args: risky.args.concat('--verbose') }), sig, 'one more argument');
  assert.notStrictEqual(AR.signature({ command: 'agy', args: risky.args.slice().reverse() }), sig, 'the order of the arguments');
  assert.notStrictEqual(AR.signature({ command: 'agy2', args: risky.args }), sig, 'the command');
  assert.notStrictEqual(AR.signature(Object.assign({ append_instruction: false }, risky)), sig, 'whether the instruction is appended');
  assert.notStrictEqual(AR.signature({ command: 'a', args: ['b c'] }), AR.signature({ command: 'a', args: ['b', 'c'] }), 'argument boundaries');

  const acks = { other: 'v1:1' };
  const next = AR.acknowledge(acks, 'agy', risky);
  assert.deepStrictEqual(acks, { other: 'v1:1' }, 'the old object is not changed');
  assert.deepStrictEqual(next, { other: 'v1:1', agy: sig });
  assert.strictEqual(AR.isAcknowledged(next, 'agy', risky), true);
  assert.strictEqual(AR.isAcknowledged(next, 'gemini', risky), false, 'per agent key');
  assert.strictEqual(AR.isAcknowledged(next, 'agy', { command: 'agy', args: ['--yolo'] }), false, 'per exact command line');
  assert.strictEqual(AR.isAcknowledged(undefined, 'agy', risky), false);
  assert.strictEqual(AR.isAcknowledged({}, 'toString', risky), false, 'no inherited keys');
})();

(function testCommandLineAndText() {
  assert.strictEqual(AR.commandLine({ command: 'agy', args: ['-p', 'a b', '', '--yolo'] }), 'agy -p "a b" "" --yolo');
  assert.strictEqual(AR.commandLine({ command: 'x', args: ['line1\nline2'] }), 'x "line1\\nline2"');
  const long = AR.commandLine({ command: 'x', args: ['y'.repeat(1000)] });
  assert.strictEqual(long.length, 400);
  assert.ok(long.endsWith('…'));

  const tr = (key) => ({
    agentRiskIntro: 'Agent {agent}:',
    agentRiskFlag: '- {flag} skips',
    agentRiskShell: '- {shell} runs',
    agentRiskCommand: 'Command: {command}',
    agentRiskOutro: 'Run? ({instruction} stays)'
  })[key];
  const text = AR.confirmText(tr, 'agy', { command: 'bash', args: ['-c', '$& $1', '--yolo'] });
  assert.strictEqual(text, 'Agent agy:\n- --yolo skips\n- bash runs\n\nCommand: bash -c "$& $1" --yolo\n\nRun? ({instruction} stays)',
    'every reason is listed, "$" patterns are not interpreted, unknown placeholders stay');
})();

(async function testConfirmRun() {
  let acks;
  const asked = [];
  let answer = false;
  const host = {
    getAcks: () => acks,
    setAcks: (a) => { acks = a; },
    ask: async (text) => { asked.push(text); return answer; },
    t: (key) => key + ' {agent}{flag}{command}'
  };
  assert.strictEqual(await AR.confirmRun(host, 'claude-code', safe), true, 'a safe agent runs');
  assert.strictEqual(asked.length, 0, 'without a question');
  assert.strictEqual(acks, undefined, 'and nothing is remembered');

  assert.strictEqual(await AR.confirmRun(host, 'agy', risky), false, 'declined');
  assert.strictEqual(asked.length, 1);
  assert.ok(asked[0].includes('agy') && asked[0].includes('--dangerously-skip-permissions'), asked[0]);
  assert.strictEqual(acks, undefined, 'a No is not remembered');

  answer = true;
  assert.strictEqual(await AR.confirmRun(host, 'agy', risky), true);
  assert.strictEqual(asked.length, 2);
  assert.deepStrictEqual(acks, { agy: AR.signature(risky) });

  assert.strictEqual(await AR.confirmRun(host, 'agy', JSON.parse(JSON.stringify(risky))), true);
  assert.strictEqual(asked.length, 2, 'asked once for this command line');

  answer = false;
  const changed = { command: 'agy', args: risky.args.concat('--model', 'x') };
  assert.strictEqual(await AR.confirmRun(host, 'agy', changed), false, 'changed arguments ask again');
  assert.strictEqual(asked.length, 3);
  assert.deepStrictEqual(acks, { agy: AR.signature(risky) }, 'the earlier answer is kept');
})().catch((e) => { console.error(e); process.exit(1); });

(function testNoticeState() {
  const issues = [
    { agent: 'claude-code', kind: 'outdated-default', detail: 'claude-code', suggested: safe },
    { agent: 'runner', kind: 'shell-append', detail: 'pwsh' },
    { agent: 'runner', kind: 'outdated-default', detail: 'codex' }
  ];
  const sig = AR.issuesSignature(issues);
  assert.ok(sig.startsWith('v1:'));
  assert.strictEqual(AR.issuesSignature(issues.slice().reverse()), sig, 'the order does not matter');
  assert.notStrictEqual(AR.issuesSignature(issues.slice(1)), sig, 'a different set, a different signature');
  assert.strictEqual(AR.issuesSignature([]), '');
  assert.strictEqual(AR.issuesSignature(null), '');
  assert.strictEqual(AR.issuesSignature([null, { agent: 1 }]), '', 'malformed entries are ignored');

  assert.strictEqual(AR.startupNotice(undefined, []), null, 'nothing to say');
  const first = AR.startupNotice(undefined, issues);
  assert.deepStrictEqual(first, { state: { shown: sig }, count: 2 }, 'two agents need a look');
  assert.strictEqual(AR.startupNotice(first.state, issues), null, 'once per set');
  const again = AR.startupNotice({ shown: sig, dismissed: 'v1:x' }, issues.slice(0, 1));
  assert.deepStrictEqual(again, { state: { shown: AR.issuesSignature(issues.slice(0, 1)), dismissed: 'v1:x' }, count: 1 }, 'a new set is told again');

  assert.strictEqual(AR.showInSettings(undefined, issues), true);
  assert.strictEqual(AR.showInSettings({ shown: sig }, issues), true, 'the status-bar message does not hide the Settings list');
  const hidden = AR.dismissed({ shown: sig }, issues);
  assert.deepStrictEqual(hidden, { shown: sig, dismissed: sig });
  assert.strictEqual(AR.showInSettings(hidden, issues), false);
  assert.strictEqual(AR.showInSettings(hidden, issues.slice(1)), true, 'until the set changes');
  assert.strictEqual(AR.showInSettings(undefined, []), false);
})();

(function testIssueTextAndYaml() {
  const tr = (key) => ({
    agentIssueOutdated: '{agent} is the old {builtin}. {reason}',
    agentIssueReasonClaude: 'Claude reason.',
    agentIssueReasonCodex: 'Codex reason.',
    agentIssueReasonAgy: 'Agy reason.',
    agentIssueShell: '{agent}: {shell} runs it; set append_instruction: false or place {instruction}.'
  })[key];
  assert.strictEqual(AR.issueText(tr, { agent: 'mine', kind: 'outdated-default', detail: 'claude-code' }), 'mine is the old claude-code. Claude reason.');
  assert.strictEqual(AR.issueText(tr, { agent: 'cx', kind: 'outdated-default', detail: 'codex' }), 'cx is the old codex. Codex reason.');
  assert.strictEqual(AR.issueText(tr, { agent: 'agy', kind: 'outdated-default', detail: 'agy' }), 'agy is the old agy. Agy reason.');
  assert.strictEqual(AR.issueText(tr, { agent: 'r', kind: 'shell-append', detail: 'pwsh' }), 'r: pwsh runs it; set append_instruction: false or place {instruction}.');

  const suggested = { command: 'claude', args: ['-p', '対象ノート: {file}\n指示: {instruction}'], description: 'Claude Code (default)', aliases: ['claude', 'cc'] };
  assert.strictEqual(AR.suggestedYaml('claude-code', suggested, { description: 'My Claude', aliases: ['claude', 'cc'] }),
    '  claude-code:\n    command: "claude"\n    args:\n      - "-p"\n      - "対象ノート: {file}\\n指示: {instruction}"\n    description: "My Claude"\n    aliases: ["claude", "cc"]\n',
    'the user key, description and aliases stay; command and args are the new ones; strings are JSON-quoted (valid YAML)');
  assert.strictEqual(AR.suggestedYaml('my agent', { command: 'codex', args: ['exec', '{instruction}'], description: 'Codex' }, null),
    '  "my agent":\n    command: "codex"\n    args:\n      - "exec"\n      - "{instruction}"\n    description: "Codex"\n', 'an unusual key is quoted');
})();

// A fake DOM just big enough for renderIssues.
function fakeDoc() {
  const make = (tag) => {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(), children: [], style: {}, type: '', className: '', onclick: null, _text: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c)
      },
      appendChild: (child) => { el.children.push(child); return child; },
      get textContent() { return el._text + el.children.map((c) => c.textContent).join(''); },
      set textContent(v) { el._text = String(v); el.children = []; }
    };
    return el;
  };
  return { createElement: make };
}

(async function testRenderIssues() {
  const doc = fakeDoc();
  const box = doc.createElement('div');
  box.classList.add('hidden');
  const copied = [];
  const toasts = [];
  let saved = null;
  const issues = [
    { agent: 'claude-code', kind: 'outdated-default', detail: 'claude-code', suggested: safe },
    { agent: 'runner', kind: 'shell-append', detail: 'pwsh' }
  ];
  const host = {
    t: (key) => '[' + key + ']',
    doc: doc,
    agents: { 'claude-code': { command: 'claude', args: ['--file'], description: 'Mine' } },
    state: undefined,
    copy: async (text) => { copied.push(text); return true; },
    showMessage: (text) => toasts.push(text),
    onDismiss: (state) => { saved = state; }
  };
  AR.renderIssues(box, issues, host);
  assert.strictEqual(box.classList.contains('hidden'), false, 'shown');
  const ul = box.children.find((c) => c.tagName === 'UL');
  assert.strictEqual(ul.children.length, 2, 'one row per issue');
  const copyBtn = ul.children[0].children.find((c) => c.tagName === 'BUTTON');
  assert.ok(copyBtn, 'an outdated definition has a copy button');
  assert.ok(!ul.children[1].children.some((c) => c.tagName === 'BUTTON'), 'a shell warning has none');
  copyBtn.onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, [AR.suggestedYaml('claude-code', safe, host.agents['claude-code'])]);
  assert.deepStrictEqual(toasts, ['[agentIssueCopied]']);

  const hideBtn = box.children.filter((c) => c.tagName === 'BUTTON').pop();
  hideBtn.onclick();
  assert.strictEqual(box.classList.contains('hidden'), true);
  assert.deepStrictEqual(saved, { dismissed: AR.issuesSignature(issues) });

  AR.renderIssues(box, issues, Object.assign({}, host, { state: saved }));
  assert.strictEqual(box.classList.contains('hidden'), true, 'stays hidden for this set');
  assert.strictEqual(box.children.length, 0);
  AR.renderIssues(box, [], host);
  assert.strictEqual(box.classList.contains('hidden'), true, 'nothing to show');

  // agents.yaml text is only ever text
  const nasty = [{ agent: '<img src=x onerror=alert(1)>', kind: 'shell-append', detail: 'bash' }];
  AR.renderIssues(box, nasty, Object.assign({}, host, { t: (k) => (k === 'agentIssueShell' ? '{agent}' : k) }));
  assert.ok(box.textContent.includes('<img src=x onerror=alert(1)>'), 'shown as text');
})().catch((e) => { console.error(e); process.exit(1); });

(function testSettingsPackNeverCarriesAcknowledgements() {
  assert.deepStrictEqual(Array.from(CP.LOCAL_ONLY_KEYS).sort(), ['agentAck', 'agentNotice']);
  const config = { general: { theme: 'olive' }, agentAck: { agy: 'v1:1' }, agentNotice: { shown: 'v1:2' }, other: 1 };
  const all = CP.CONFIG_SECTIONS.map((s) => s.id);
  const exported = CP.splitConfig(config, all);
  assert.strictEqual(exported.agentAck, undefined, 'not exported');
  assert.strictEqual(exported.agentNotice, undefined);
  assert.strictEqual(exported.other, 1, 'other unknown keys still travel');
  assert.deepStrictEqual(CP.sectionsPresent({ agentAck: { a: 'b' } }), [], 'an acknowledgement alone is no section');

  const merged = CP.mergeImported({ agentAck: { mine: 'v1:3' } }, { agentAck: { agy: 'v1:evil' }, agentNotice: { dismissed: 'x' }, general: { theme: 'x' } }, all);
  assert.deepStrictEqual(merged.agentAck, { mine: 'v1:3' }, 'an imported acknowledgement never replaces this machine\'s');
  assert.strictEqual(merged.agentNotice, undefined);
  assert.deepStrictEqual(merged.general, { theme: 'x' }, 'the rest imports as before');
})();

(function testPageWiring() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const at = (file) => html.indexOf('<script src="js/' + file + '?v=');
  assert.ok(at('agent_risk.js') > 0, 'index.html loads agent_risk.js');
  assert.ok(at('agent_risk.js') < at('slot_agent.js') && at('slot_agent.js') < at('app.js'), 'before slot_agent.js and app.js');
  assert.ok(html.includes('id="agent-issues"'), 'Settings has the place for the agent list');
  // Loading the module defines functions and one global, nothing else.
  const src = fs.readFileSync(path.join(__dirname, 'agent_risk.js'), 'utf8');
  assert.ok(!/setTimeout|setInterval|addEventListener|document\.getElementById/.test(src), 'no timers, listeners or DOM lookups');
})();

console.log('agent_risk_test.js: all passed');
