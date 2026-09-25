// Auto selector: source-level wiring. Nothing here runs the app (tests/auto_selector_flow_test.mjs does): it checks that the pieces are
// connected the way the flow expects - script tags and their order, the bridge, the palette entry, task types, translations, styles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const appJs = read('frontend/js/app.js');
const slotJs = read('frontend/js/slot_agent.js');
const taskJs = read('frontend/js/task_manager.js');
const selectorJs = read('frontend/js/auto_selector.js');
const snippetsJs = read('frontend/js/slot_snippets.js');
const css = read('frontend/css/style.css');
const i18nCode = read('frontend/js/i18n.js');

const context = {};
vm.createContext(context);
vm.runInContext(i18nCode + '; this.I18N = I18N;', context);
const I18N = context.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

function extractFunction(source, name) {
  const marker = new RegExp(`(?:async )?function ${name}\\(`);
  const found = marker.exec(source);
  assert.ok(found, `function ${name} not found`);
  const start = found.index;
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.substring(start, i + 1);
}

// Everything that must not be an emoji: the pictographic blocks, dingbats and the variation selector; the one allowed symbol is the close glyph.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{2714}\u{2716}-\u{27BF}\u{FE0F}]/u;

// ---------------------------------------------------------------------------------------------------
check('index.html: auto_selector.js and slot_snippets.js load after task_manager.js and before slot_agent.js, with the usual ?v= pattern', () => {
  const at = (file) => html.indexOf(`js/${file}?v=`);
  for (const file of ['task_manager.js', 'auto_selector.js', 'slot_snippets.js', 'slot_agent.js', 'app.js']) assert.ok(at(file) > 0, `${file} has a script tag`);
  assert.ok(at('task_manager.js') < at('auto_selector.js'), 'after task_manager.js');
  assert.ok(at('auto_selector.js') < at('slot_snippets.js') && at('slot_snippets.js') < at('slot_agent.js'), 'before slot_agent.js');
  assert.ok(at('slot_agent.js') < at('app.js'));
  assert.match(html, /<script src="js\/auto_selector\.js\?v=\d+\.\d+\.\d+"><\/script>/);
  assert.match(html, /<script src="js\/slot_snippets\.js\?v=\d+\.\d+\.\d+"><\/script>/);
});

check('the two pure modules cost nothing at load and one global each (their own tests measure it); slot_agent.js finds them lazily', () => {
  assert.match(selectorJs, /global\.AutoSelector = api;/);
  assert.match(snippetsJs, /global\.SlotSnippets = api;/);
  assert.match(slotJs, /global\.AutoSelector/, 'read through the window, at use time');
  assert.match(slotJs, /global\.SlotSnippets/);
  assert.match(slotJs, /global\.MdMemoBridge/);
  const top = slotJs.slice(0, slotJs.indexOf('function genReqId'));
  assert.ok(!/AutoSelector\.|SlotSnippets\./.test(top), 'nothing calls the modules while slot_agent.js loads');
});

check('app.js: the bridge offers confirmCommand, runCommandTask, cancelCommandTask and getTabText next to the existing ones', () => {
  const bridge = appJs.slice(appJs.indexOf('window.MdMemoBridge = {'), appJs.indexOf('// Expose test and screenshot automation helpers'));
  for (const name of ['confirmCommand', 'runCommandTask', 'cancelCommandTask', 'getTabText', 'startLlmTask', 'cancelLlmTask', 'openAskBar', 'isLlmConfigured', 'getAutoSelectorConfig', 'replaceAnchor']) {
    assert.match(bridge, new RegExp(`\\b${name}:`), `MdMemoBridge.${name}`);
  }
});

check('runCommandTask: registers a task of type command, runs with no input, is cancelled by cancelCommandFilter and forgets the answer of a cancelled command', () => {
  const run = extractFunction(appJs, 'runCommandTask');
  assert.match(run, /type: 'command'/);
  assert.match(run, /runCommandFilterAsync\(reqId, command, ''\)/, 'no stdin');
  assert.match(run, /window\.__cliCallbacks\.set\(reqId,/);
  assert.match(run, /onCancel: \(\) => cancelCommandTask\(reqId\)/);
  assert.match(run, /autoSelCommandNativeOnly/, 'no native runner: a toast, and null');
  const cancel = extractFunction(appJs, 'cancelCommandTask');
  assert.match(cancel, /cancelCommandFilter\(reqId\)/);
  assert.match(cancel, /__cliCallbacks\.delete\(reqId\)/, 'the late answer finds no callback');
  assert.match(cancel, /getTabText\(info\.tabId\)/, 'the anchor is only removed while it is still there (no stray text appended)');
  const confirm = extractFunction(appJs, 'confirmCommand');
  assert.match(confirm, /validateCliCommand/);
  assert.match(confirm, /cliBlockedError/);
  assert.match(confirm, /cliWarningConfirm/);
  assert.match(confirm, /cliCancelled/);
  assert.ok(!/replaceAnchor|insertTextWithUndo|editor/.test(confirm), 'the gate never touches the note');
});

check('the palette has "Insert task snippet", which opens the snippet picker of SlotAgent', () => {
  assert.match(appJs, /id: 'cmd_snippets'/);
  assert.match(appJs, /id: 'cmd_snippets'[\s\S]{0,900}window\.SlotAgent\.openSnippetPicker\(\)/);
  assert.match(appJs, /title: t\('cmdPaletteSnippets'\)/);
  const entry = appJs.slice(appJs.indexOf("id: 'cmd_snippets'"), appJs.indexOf("id: 'cmd_mobile_drop'"));
  assert.match(entry, /<svg class="menu-icon"[^>]*viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.8" stroke-linecap="round" stroke-linejoin="round">/, 'the same line icon as the other entries');
  assert.ok(!EMOJI.test(entry));
});

check('slot_agent.js: the Ctrl+Enter branch ignores an IME confirmation, decides in JS and guards double presses by editor and by marker id', () => {
  const branch = slotJs.slice(slotJs.indexOf("if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {"));
  const body = branch.slice(0, branch.indexOf('return;\n      }') + 20);
  assert.match(body, /e\.isComposing \|\| e\.keyCode === 229/);
  assert.ok(body.indexOf('isComposing') < body.indexOf('preventDefault'), 'the IME case returns before the key is taken');
  assert.match(body, /handleCtrlEnter\(editor\)/);
  assert.match(slotJs, /const triggerInFlight = new WeakMap\(\)/);
  assert.match(slotJs, /const runningTasks = new Map\(\)/);
  assert.ok(!/Math\.abs\(existingMeta\.startOffset - target\.startOffset\)/.test(slotJs), 'the offset-distance heuristic is gone');
  assert.match(slotJs, /if \(target && target\.outputMode === 'below'\)/);
  assert.match(slotJs, /if \(result\.outputMode === 'below'\)/, 'below-mode results are applied directly, never queued for the debounced merge');
});

check('the decision path makes no RPC before it decides (findTaskAt / classify / findEnclosingSlotSpan are synchronous)', () => {
  const flow = extractFunction(slotJs, 'ctrlEnterFlow');
  assert.ok(!/await /.test(flow), 'ctrlEnterFlow has no await at all');
  assert.ok(!/parseSlotsRPC|checkAgentAvailability|validateCliCommand/.test(flow));
  assert.ok(flow.includes('AS.findTaskAt') && flow.includes('findEnclosingSlotSpan') && flow.includes('AS.classify') && flow.includes('AS.inCodeFence'));
  const instruction = extractFunction(slotJs, 'runInstruction');
  assert.ok(!/await /.test(instruction) && !/parseSlotsRPC/.test(instruction), 'and neither has the step that rewrites the line');
});

check('[[ never opens the quick selector: its trigger list is {{ [? 【? [! [>> as before', () => {
  const input = slotJs.slice(slotJs.indexOf("editor.addEventListener('input'"), slotJs.indexOf("editor.addEventListener('compositionend'"));
  assert.ok(!/'\[\['/.test(input) && !/"\[\["/.test(input), 'no [[ trigger in the input handler');
  for (const trigger of ["'{{'", "'[?'", "'【?'", "'[!'", "'[>>'"]) assert.ok(input.includes(`trigger = ${trigger}`), `${trigger} still opens it`);
});

check('the popup builds rows from config text only through escapeHtml, and the list is bounded (it scrolls)', () => {
  const render = extractFunction(slotJs, 'renderSelectorList');
  for (const field of ['p.role', 'p.desc']) assert.ok(render.includes(`escapeHtml(${field})`), `${field} is escaped`);
  assert.ok(!/\$\{p\.(role|desc|label)\}/.test(render), 'no raw interpolation of a preset field');
  assert.match(css, /\.slot-selector-list \{[^}]*max-height: 300px;[^}]*overflow-y: auto;/);
  assert.match(css, /\.slot-item-kind \{/);
});

check('task_manager.js knows the command type: listed like an LLM task, no hover peek, its own cancel', () => {
  assert.match(taskJs, /'slot' \| 'action' \| 'llm' \| 'command'/);
  assert.match(taskJs, /t\.type === 'slot' && window\.backend && window\.backend\.getSlotHoverPeek/, 'only slot tasks are peeked');
  assert.match(taskJs, /task\.type !== 'command' && window\.backend && window\.backend\.cancelSlotAgent/);
  assert.match(taskJs, /data-task-type="\$\{escapeHTML\(task\.type\)\}"/);
});

// ---------------------------------------------------------------------------------------------------
const usedKeys = (source, pattern) => [...new Set([...source.matchAll(pattern)].map((m) => m[1]))];
const slotKeys = usedKeys(slotJs, /(?:tr|notifyNoAction)\(\s*'(autoSel[A-Za-z]*)'/g);
const appKeys = usedKeys(appJs, /\bt\(\s*'((?:autoSel|cmdPaletteSnippets)[A-Za-z]*)'/g);

check('i18n: every string the flow shows exists in English and Japanese with the same placeholders', () => {
  assert.ok(slotKeys.length >= 10, `slot_agent.js uses ${slotKeys.length} autoSel keys`);
  assert.ok(appKeys.includes('autoSelCommandLabel') && appKeys.includes('cmdPaletteSnippets'));
  for (const key of [...slotKeys, ...appKeys, 'cmdPaletteSnippetsDesc', 'autoSelCommandDecorated', 'autoSelAgentDecoratedMissing']) {
    assert.equal(typeof I18N.en[key], 'string', `en.${key}`);
    assert.equal(typeof I18N.ja[key], 'string', `ja.${key}`);
    assert.ok(I18N.en[key].length > 0 && I18N.ja[key].length > 0);
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(placeholders(I18N.en[key]), placeholders(I18N.ja[key]), `${key}: the placeholders are the same in both languages`);
    assert.ok(!EMOJI.test(I18N.en[key]) && !EMOJI.test(I18N.ja[key]), `${key} has no emoji`);
  }
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.ja).sort(), 'en and ja carry the same keys');
  for (const key of ['autoSelAgentDecorated', 'autoSelAgentDecoratedMissing', 'autoSelCommandDecorated']) {
    assert.ok(I18N.en[key].includes('{key}') && I18N.ja[key].includes('{key}'), `${key} names the modifier key (Ctrl / Cmd) through {key}`);
  }
});

check('i18n: the fallback texts in slot_agent.js are English and the placeholders they use are the ones the dictionary uses', () => {
  const calls = [...slotJs.matchAll(/(?:tr|notifyNoAction)\(\s*'(autoSel[A-Za-z]*)',\s*'((?:[^'\\]|\\.)*)'/g)];
  assert.ok(calls.length >= 10);
  for (const [, key, fallback] of calls) {
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(placeholders(fallback), placeholders(I18N.en[key]), `${key}: the fallback text takes the same placeholders`);
  }
});

check('no emoji in the new code, styles and strings (the existing run-button glyph is not part of this feature)', () => {
  const flowStart = slotJs.indexOf('// ---- Auto selector: what Ctrl+Enter does');
  const flowEnd = slotJs.indexOf('function cancelSlotExecution');
  assert.ok(flowStart > 0 && flowEnd > flowStart);
  assert.ok(!EMOJI.test(slotJs.slice(flowStart, flowEnd)), 'the Ctrl+Enter flow');
  const pickerStart = slotJs.indexOf('function snippetsApi');
  const pickerEnd = slotJs.indexOf('function hideQuickSelector');
  assert.ok(!EMOJI.test(slotJs.slice(pickerStart, pickerEnd)), 'the snippet rows');
  assert.ok(!EMOJI.test(selectorJs) && !EMOJI.test(snippetsJs));
  const commandTasks = appJs.slice(appJs.indexOf('// --- Command tasks'), appJs.indexOf('// Vision / Image LLM Query'));
  assert.ok(commandTasks.length > 500 && !EMOJI.test(commandTasks), 'the command task code');
  const kindCss = css.slice(css.indexOf('.slot-item-kind {'), css.indexOf('.slot-item-desc {'));
  assert.ok(!EMOJI.test(kindCss));
  for (const lang of ['en', 'ja']) {
    for (const key of Object.keys(I18N[lang]).filter((k) => /^autoSel|^cmdPaletteSnippets/.test(k))) assert.ok(!EMOJI.test(I18N[lang][key]), `${lang}.${key}`);
  }
});

check('the default agents block of slot_agent.js is untouched by the flow (the parity test owns it) and still comes first', () => {
  assert.ok(slotJs.indexOf('agents: {') < slotJs.indexOf('function genReqId'));
  assert.match(slotJs, /aliases: \["claude", "cc"\]/);
  assert.match(slotJs, /aliases: \["antigravity", "gemini"\]/);
});

check('a long toast cannot squeeze or wrap the status bar: the sides keep their size, the message is cut with an ellipsis and its text is the tooltip', () => {
  const rule = (selector) => {
    const found = css.split('\n').join(' ').match(new RegExp(selector.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(found, `${selector} rule exists`);
    return found[1];
  };
  assert.match(rule('.status-left, .status-right'), /flex-shrink:\s*0/);
  assert.match(rule('.status-left, .status-right'), /white-space:\s*nowrap/);
  const message = rule('#stat-message');
  assert.match(message, /overflow:\s*hidden/);
  assert.match(message, /text-overflow:\s*ellipsis/);
  assert.match(message, /white-space:\s*nowrap/);
  const showMessage = extractFunction(appJs, 'showMessage');
  assert.match(showMessage, /statMessage\.title\s*=\s*msg/, 'the full text is the tooltip');
  assert.match(showMessage, /statMessage\.title\s*=\s*''/, 'and it goes away with the message');
});

check('the preview drops the marker lines of a run, after fenced code is set aside (so a fence is never touched)', () => {
  const render = extractFunction(appJs, 'renderMarkdownContentTo');
  const protect = render.indexOf('codeSnippets.push(match)');
  const strip = render.indexOf('window.AutoSelector.stripMarkers(rawText)');
  assert.ok(protect !== -1 && strip !== -1, 'the renderer calls stripMarkers');
  assert.ok(protect < strip, 'and only after the code was replaced by tokens');
  assert.ok(strip < render.indexOf('Extract Block Math'), 'before the math and markdown passes');
  assert.match(selectorJs, /stripMarkers,/, 'it is part of the public API');
  // HTML comments go first, from the raw text (html_comments.js knows code and leaves the markers to stripMarkers)
  const comments = render.indexOf('window.HtmlComments.removeComments(rawText)');
  assert.ok(comments !== -1 && comments < protect, 'comments are removed before the code is set aside');
});

check('the Auto selector toasts are short enough for the status bar in both languages', () => {
  for (const lang of ['en', 'ja']) {
    for (const key of ['autoSelAgentDecorated', 'autoSelCommandDecorated']) {
      const text = I18N[lang][key].replace(/\{key\}/g, 'Ctrl');
      const width = Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2000 ? 12 : 6.2), 0);
      assert.ok(width <= 440, `${lang}.${key} is about ${Math.round(width)} px wide (limit 440 at 12 px)`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${queue.length} auto selector wiring test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} auto selector wiring tests passed.`);
