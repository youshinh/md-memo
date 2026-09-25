// HTML comments and Ctrl+/ in the app: load order, the shortcut in every table it has to be in, the palette entry,
// the general.commentStyle setting (default, Settings select, load and save), and the texts in both languages.
// Source-level checks; the behaviour itself is run in frontend/js/html_comments_test.js, comment_toggle_test.js,
// slot_agent_test.js and tests/auto_selector_flow_test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appJs = read('frontend/js/app.js');
const html = read('frontend/index.html');
const slotAgentJs = read('frontend/js/slot_agent.js');
const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(read('frontend/js/i18n.js') + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

function extractBlock(source, marker, open, close) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} not found`);
  const from = source.indexOf(open, start);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + marker);
}

check('index.html: html_comments.js loads before the modules that ask it, comment_toggle.js before app.js', () => {
  const at = (file) => html.indexOf(`src="js/${file}?v=`);
  for (const file of ['html_comments.js', 'comment_toggle.js', 'auto_selector.js', 'slot_agent.js', 'app.js']) assert.ok(at(file) > 0, file);
  assert.ok(at('html_comments.js') < at('auto_selector.js') && at('html_comments.js') < at('slot_agent.js'));
  assert.ok(at('html_comments.js') < at('comment_toggle.js') && at('comment_toggle.js') < at('app.js'));
});

check('the shortcut: in both default tables, in the Line group of the settings, dispatched in the editor only, IME-safe', () => {
  const win = extractBlock(appJs, 'const DEFAULT_SHORTCUTS_WIN = {', '{', '}');
  const mac = extractBlock(appJs, 'const DEFAULT_SHORTCUTS_MAC = {', '{', '}');
  assert.match(win, /commentToggle: 'Ctrl\+\/'/);
  assert.match(mac, /commentToggle: 'Cmd\+\/'/);
  const groups = extractBlock(appJs, 'const SHORTCUT_GROUPS = [', '[', ']');
  const line = groups.slice(groups.indexOf("titleKey: 'shortcutGroupLine'"));
  assert.match(line.slice(0, line.indexOf('titleKey', 10)), /\{ key: 'commentToggle', labelKey: 'shortcutActionCommentToggle' \}/);
  const editorBlock = appJs.slice(appJs.indexOf('if (isEditorActive) {'), appJs.indexOf('// Escape priority order'));
  const at = editorBlock.indexOf('config.shortcuts.commentToggle');
  assert.ok(at !== -1, 'dispatched inside if (isEditorActive)');
  const branch = editorBlock.slice(at, editorBlock.indexOf('return;\n      }', at));
  assert.match(branch, /e\.isComposing \|\| e\.keyCode === 229/);
  assert.match(branch, /executeToggleComment\(activeEl\)/);
});

check('the palette entry shows the current binding and toggles the active editor', () => {
  const entry = appJs.slice(appJs.indexOf("id: 'cmd_comment_toggle'"), appJs.indexOf("id: 'cmd_export_plain'"));
  assert.match(entry, /paletteDescWithShortcut\('cmdPaletteCommentToggleDesc', 'commentToggle'\)/);
  assert.match(entry, /executeToggleComment\(getActiveEditor\(\)\)/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(entry), 'a line icon, no emoji');
});

check('the toggle is one insertTextWithUndo over the replaced lines, then the selection it computed', () => {
  const fn = extractBlock(appJs, 'function executeToggleComment(', '{', '}');
  const select = fn.indexOf('editor.setSelectionRange(r.start, r.end)');
  const insert = fn.indexOf('insertTextWithUndo(r.replacement, editor)');
  const after = fn.indexOf('editor.setSelectionRange(r.selStart, r.selEnd)');
  assert.ok(select !== -1 && select < insert && insert < after);
  assert.equal(fn.split('insertTextWithUndo(').length - 1, 1, 'one edit');
  assert.match(fn, /commentStyle === 'block' \? 'block' : 'line'/, 'unknown values mean the default');
});

check('general.commentStyle: default line, a select in Settings, loaded and saved like the theme', () => {
  assert.match(appJs, /commentStyle: 'line',/);
  const select = html.slice(html.indexOf('<select id="cfg-comment-style"'), html.indexOf('</select>', html.indexOf('<select id="cfg-comment-style"')));
  assert.match(select, /<option value="line" data-i18n="commentStyleLine">/);
  assert.match(select, /<option value="block" data-i18n="commentStyleBlock">/);
  assert.ok(html.indexOf('id="cfg-comment-style"') > html.indexOf('data-i18n="sectionEditor"'), 'in the Editor section');
  const open = appJs.slice(appJs.indexOf("document.getElementById('cfg-theme');"), appJs.indexOf("function restoreLiveConfigFromSnapshot"));
  assert.match(open, /commentStyleSelect\.value = config\.general\.commentStyle === 'block' \? 'block' : 'line'/);
  assert.match(appJs, /config\.general\.commentStyle = commentStyleSaveSelect\.value === 'block' \? 'block' : 'line'/);
});

check('slot_agent.js asks html_comments.js only through a guard and only when the text has "<!--"', () => {
  const ranges = extractBlock(slotAgentJs, 'function commentRanges(', '{', '}');
  const caret = extractBlock(slotAgentJs, 'function caretInComment(', '{', '}');
  for (const fn of [ranges, caret]) {
    assert.match(fn, /global\.HtmlComments/);
    assert.match(fn, /indexOf\('<!--'\) !== -1/);
  }
});

check('every new text is there in English and Japanese, without emoji, and the toasts fit the status bar', () => {
  const keys = ['shortcutActionCommentToggle', 'cmdPaletteCommentToggle', 'cmdPaletteCommentToggleDesc', 'commentStyleLabel', 'commentStyleLine',
    'commentStyleBlock', 'commentStyleHint', 'commentToggleSkipped', 'commentToggleNothing', 'commentToggleUnclosed', 'commentToggleTerminator',
    'commentToggleMarker', 'commentToggleOverlap', 'commentToggleUnsafe', 'commentNoRun'];
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}]/u;
  for (const lang of ['en', 'ja']) {
    for (const key of keys) {
      assert.equal(typeof I18N[lang][key], 'string', `${lang}.${key}`);
      assert.ok(!emoji.test(I18N[lang][key]), `${lang}.${key} has no emoji`);
    }
    assert.match(I18N[lang].cmdPaletteCommentToggleDesc, /\(\{sc\}\)$/, 'the binding goes at the end, like the other palette entries');
    assert.match(I18N[lang].commentToggleSkipped, /\{lines\}/);
    for (const key of ['commentToggleSkipped', 'commentToggleNothing', 'commentToggleUnclosed', 'commentToggleTerminator', 'commentToggleMarker',
      'commentToggleOverlap', 'commentToggleUnsafe', 'commentNoRun']) {
      const text = I18N[lang][key].replace('{lines}', '12, 13');
      const width = Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2000 ? 12 : 6.2), 0);
      assert.ok(width <= 440, `${lang}.${key} is about ${Math.round(width)} px wide (limit 440 at 12 px)`);
    }
  }
});

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
  console.error(`\n${failed} of ${queue.length} html comments wiring test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} html comments wiring tests passed.`);
