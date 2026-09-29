// Regressions of the AI request lifecycle (the ai-lifecycle group of the exploratory review, 2026-09): every check below failed before
// the fix. The real app.js, task_manager.js ... run in one vm context against a hand-made DOM (tests/fixtures/slot_env.mjs); the
// backend is a stand-in that records what the page asks of it. Nothing here starts a process or touches the network.
//
//   B03  several requests of one note that wait at the same time each have a waiting text of their own, so every answer lands in
//        its own place, whatever order the answers come in (rewrite, ask, pasted image)
//   B06  the waiting text of an unanswered request is never written to a file or to the saved session
//   B09  a rewrite / correction replaces the words only: indentation and the line break after a selection stay, in a failure and
//        in a success; Retry stays a rewrite
//   B10  the ask / rewrite bar finds its target again when the note changed between opening it and Enter (or says it is gone)
//   B17  an error text never carries the API key (bar details, toast, note, task list, saved file) and is worded in the UI language
//   B30  a request that ends without changing the note (failure, cancel) leaves the note as unmodified as it was
import { createRequire } from 'node:module';
import { createEnv, assert, I18N } from './fixtures/slot_env.mjs';

// llm_error.js is not part of the shared page fixture; the page finds it as window.LlmError when it is there (the app loads it too)
const LlmError = createRequire(import.meta.url)('../frontend/js/llm_error.js');

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------
class FileReaderStub {
  readAsDataURL(blob) {
    this.result = 'data:' + (blob.type || 'image/png') + ';base64,AAAA';
    Promise.resolve().then(() => { if (this.onloadend) this.onloadend(); });
  }
}

async function setup(opts = {}) {
  const saved = [];
  const sessions = [];
  const vision = [];
  const env = await createEnv({
    language: opts.language || 'en',
    globals: { FileReader: FileReaderStub },
    backend: Object.assign({
      saveFile: async (p, content) => { saved.push({ path: p, content }); },
      saveSession: async (json) => { sessions.push(json); },
      queryVisionAsync: (reqId, prompt, base64, mime) => { vision.push({ reqId, prompt, base64, mime }); }
    }, opts.backend)
  });
  env.window.LlmError = LlmError;
  env.saved = saved;
  env.sessions = sessions;
  env.vision = vision;
  // a note of its own (so the tests do not depend on what the page starts with)
  env.tab = env.bridge.getActiveTab();
  env.tab.path = opts.path || '';
  env.tab.isDirty = !!opts.dirty;
  env.setNote(opts.note === undefined ? '' : opts.note);
  env.tab.content = env.editor.value;
  return env;
}

const noteText = (env) => env.bridge.getTabText(env.tab.id);

function select(env, needle, from = 0) {
  const at = env.editor.value.indexOf(needle, from);
  assert.ok(at !== -1, `the note has no "${needle}"`);
  env.editor.selectionStart = at;
  env.editor.selectionEnd = at + needle.length;
  env.window.document.activeElement = env.editor;
}

function caretAt(env, offset) {
  env.editor.selectionStart = env.editor.selectionEnd = offset;
  env.window.document.activeElement = env.editor;
}

const openBar = (env, kind) => env.key(env.editor, kind === 'rewrite'
  ? { key: 'k', code: 'KeyK', keyCode: 75, ctrlKey: true }
  : { key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true });
const pressEnterInBar = async (env) => {
  env.key('inline-prompt-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
};

// Opens the bar of `kind` on the current selection / line, types the instruction and presses Enter; returns the request sent.
async function send(env, kind, instruction) {
  const before = env.calls.llm.length;
  openBar(env, kind);
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar opened');
  env.el('inline-prompt-input').value = instruction;
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, before + 1, 'one request went out');
  return env.calls.llm[before];
}

async function altC(env) {
  const before = env.calls.llm.length;
  env.key(env.editor, { key: 'c', code: 'KeyC', keyCode: 67, altKey: true });
  await env.flush();
  assert.equal(env.calls.llm.length, before + 1, 'the correction went out');
  return env.calls.llm[before];
}

const answer = async (env, call, text, error = '') => { env.llmAnswer(call, text, error); await env.flush(); };
const hasJapanese = (s) => /[\u3040-\u30ff\u3400-\u9fff]/.test(String(s));

function pasteImage(env) {
  const blob = { type: 'image/png' };
  env.editor.dispatchEvent({
    type: 'paste',
    clipboardData: { types: ['Files'], items: [{ type: 'image/png', getAsFile: () => blob }], getData: () => '' },
    preventDefault() { this.defaultPrevented = true; }
  });
}

// ---------------------------------------------------------------------------------------------------
// B03: a waiting text of its own for every request
// ---------------------------------------------------------------------------------------------------
check('B03: two rewrites of one note in flight - each answer replaces its own paragraph, whichever comes first', async () => {
  for (const order of ['second first', 'first first']) {
    const env = await setup({ note: 'PARA-A first paragraph.\n\nPARA-B second paragraph.\n' });
    select(env, 'PARA-A first paragraph.');
    const one = await send(env, 'rewrite', 'improve');
    select(env, 'PARA-B second paragraph.');
    const two = await send(env, 'rewrite', 'improve');
    assert.ok(noteText(env).includes('[AI Correcting...]') && noteText(env).includes('[AI Correcting... 2]'), 'each has a text of its own: ' + JSON.stringify(noteText(env)));
    if (order === 'second first') { await answer(env, two, 'ANSWER-2'); await answer(env, one, 'ANSWER-1'); }
    else { await answer(env, one, 'ANSWER-1'); await answer(env, two, 'ANSWER-2'); }
    assert.equal(noteText(env), 'ANSWER-1\n\nANSWER-2\n', order);
  }
});

check('B03: a failed rewrite puts back ITS text while the other one still waits; the other one then lands in its own place', async () => {
  const env = await setup({ note: 'alpha line\nbeta line\ngamma line\n' });
  select(env, 'alpha line');
  const one = await send(env, 'rewrite', 'shorter');
  select(env, 'gamma line');
  const two = await send(env, 'rewrite', 'shorter');
  await answer(env, two, '', 'boom');
  assert.equal(noteText(env), '[AI Correcting...]\nbeta line\ngamma line\n', 'gamma is back, alpha still waits');
  await env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });
  await answer(env, one, 'ALPHA-NEW');
  assert.equal(noteText(env), 'ALPHA-NEW\nbeta line\ngamma line\n');
});

check('B03: Alt+C corrections and Ctrl+K rewrites share the numbering: no two waiting texts of a note are alike', async () => {
  const env = await setup({ note: 'first thing\nsecond thing\nthird thing\n' });
  select(env, 'first thing');
  const a = await altC(env);
  select(env, 'second thing');
  const b = await altC(env);
  select(env, 'third thing');
  const c = await send(env, 'rewrite', 'x');
  const waiting = noteText(env).match(/\[AI Correcting[^\]]*\]/g);
  assert.equal(new Set(waiting).size, 3, JSON.stringify(waiting));
  await answer(env, c, 'C');
  await answer(env, a, 'A');
  await answer(env, b, 'B');
  assert.equal(noteText(env), 'A\nB\nC\n');
});

check('B03: two asks with the same instruction - each answer goes under its own question', async () => {
  const env = await setup({ note: 'question one\nquestion two\n' });
  select(env, 'question one');
  const one = await send(env, 'ask', 'translate');
  select(env, 'question two');
  const two = await send(env, 'ask', 'translate');
  await answer(env, two, 'ANSWER-2');
  await answer(env, one, 'ANSWER-1');
  assert.equal(noteText(env), 'question one\n\nANSWER-1\n\nquestion two\n\nANSWER-2\n\n');
});

check('B03: a failed ask restores its own place, not the first same-looking one', async () => {
  const env = await setup({ note: 'question one\nquestion two\n' });
  select(env, 'question one');
  const one = await send(env, 'ask', 'translate');
  select(env, 'question two');
  const two = await send(env, 'ask', 'translate');
  await answer(env, two, '', 'boom');
  assert.equal(noteText(env), 'question one\n\n[AI Generating: translate...]\n\nquestion two\n', 'only the second question lost its waiting text');
  env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });
  await answer(env, one, 'ANSWER-1');
  assert.equal(noteText(env), 'question one\n\nANSWER-1\n\nquestion two\n');
});

check('B03: cancelling the second of two identical asks takes out the second one', async () => {
  const env = await setup({ note: 'question one\nquestion two\n' });
  select(env, 'question one');
  const one = await send(env, 'ask', 'translate');
  select(env, 'question two');
  const two = await send(env, 'ask', 'translate');
  env.abort(two.reqId);
  assert.equal(noteText(env), 'question one\n\n[AI Generating: translate...]\n\nquestion two\n');
  await answer(env, one, 'ANSWER-1');
  assert.equal(noteText(env), 'question one\n\nANSWER-1\n\nquestion two\n');
});

check('B03: two pasted images - the texts are not swapped', async () => {
  const env = await setup({ note: 'top\n', dirty: false });
  env.config.general.pasteImageOcr = true;
  env.config.vision.apiKey = 'test-vision-key';
  caretAt(env, env.editor.value.length);
  pasteImage(env);
  await env.flush();
  pasteImage(env);
  await env.flush();
  assert.equal(env.vision.length, 2, 'two images were sent');
  assert.ok(noteText(env).includes('[Transcribing Image (Gemini)...]') && noteText(env).includes('[Transcribing Image (Gemini)... 2]'), JSON.stringify(noteText(env)));
  env.window.__onLLMResult(env.vision[1].reqId, 'TEXT-OF-IMAGE-2', '');
  env.window.__onLLMResult(env.vision[0].reqId, 'TEXT-OF-IMAGE-1', '');
  await env.flush();
  const text = noteText(env);
  assert.ok(text.indexOf('TEXT-OF-IMAGE-1') !== -1 && text.indexOf('TEXT-OF-IMAGE-1') < text.indexOf('TEXT-OF-IMAGE-2'), 'in paste order: ' + JSON.stringify(text));
});

check('B03: a waiting text that a note already holds is not reused', async () => {
  const env = await setup({ note: '[AI Correcting...]\nfix this line\n' });
  select(env, 'fix this line');
  const call = await send(env, 'rewrite', 'x');
  assert.ok(noteText(env).includes('[AI Correcting... 2]'), JSON.stringify(noteText(env)));
  await answer(env, call, 'FIXED');
  assert.equal(noteText(env), '[AI Correcting...]\nFIXED\n');
});

// ---------------------------------------------------------------------------------------------------
// B06: the waiting text never reaches a file or the saved session
// ---------------------------------------------------------------------------------------------------
async function savedNow(env) {
  env.key(env.editor, { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true });
  await env.flush();
  return env.saved[env.saved.length - 1];
}

function lastSession(env) {
  env.fireTimers(500); // the debounced session save
  const json = env.sessions[env.sessions.length - 1];
  return json ? JSON.parse(json) : null;
}

check('B06: a rewrite that is still waiting is saved with the original sentence, in the file and in the session', async () => {
  const original = 'Intro line.\n\nThe quarterly numbers look strong.\n\nTail line.\n';
  const env = await setup({ note: original, path: 'C:\\demo\\a.md' });
  select(env, 'The quarterly numbers look strong.');
  const call = await send(env, 'rewrite', 'shorter');
  assert.ok(noteText(env).includes('[AI Correcting...]'), 'the note on screen shows the waiting text');
  const file = await savedNow(env);
  assert.ok(file, 'a file was written');
  assert.equal(file.content, original, 'the file holds the original sentence: ' + JSON.stringify(file.content));
  // something else makes the page save its session
  env.editor.dispatchEvent({ type: 'input' });
  const session = lastSession(env);
  assert.ok(session, 'the session was saved');
  assert.equal(session.tabs.find((t) => t.id === env.tab.id).content, original, 'and so does the session');
  // the answer comes: saved again, with the answer
  await answer(env, call, 'Numbers look strong.');
  const after = await savedNow(env);
  assert.equal(after.content, 'Intro line.\n\nNumbers look strong.\n\nTail line.\n');
});

check('B06: the waiting text of an ask is left out of the file, and so is a pasted image\'s', async () => {
  const env = await setup({ note: 'What is 2+2?\n', path: 'C:\\demo\\q.md' });
  select(env, 'What is 2+2?');
  const call = await send(env, 'ask', 'answer briefly');
  assert.ok(noteText(env).includes('[AI Generating: answer briefly...]'));
  assert.equal((await savedNow(env)).content, 'What is 2+2?\n');
  await answer(env, call, '4');
  assert.equal((await savedNow(env)).content, 'What is 2+2?\n\n4\n\n');

  const env2 = await setup({ note: 'top\n', path: 'C:\\demo\\img.md' });
  env2.config.general.pasteImageOcr = true;
  env2.config.vision.apiKey = 'test-vision-key';
  caretAt(env2, env2.editor.value.length);
  pasteImage(env2);
  await env2.flush();
  assert.ok(noteText(env2).includes('[Transcribing Image (Gemini)...]'));
  assert.equal((await savedNow(env2)).content, 'top\n', 'no waiting text, and no blank lines it left behind');
});

check('B06: closing the note while its request waits leaves the original sentence on disk (the late answer is dropped)', async () => {
  const original = 'Keep this sentence.\n';
  const env = await setup({ note: original, path: 'C:\\demo\\keep.md' });
  const other = env.window.__testHelper.createTab('other.md', 'other\n');
  env.window.__mdMemoRPC.switchTab(env.tab.id);
  await env.flush();
  select(env, 'Keep this sentence.');
  const call = await send(env, 'rewrite', 'shorter');
  await savedNow(env); // the autosave of the note with the waiting text in it
  env.window.__mdMemoRPC.closeTab(env.tab.id);
  await env.flush();
  if (!env.hidden('confirm-modal')) { env.el('confirm-modal-dontsave').onclick(); await env.flush(); }
  await answer(env, call, 'LATE ANSWER');
  assert.ok(env.saved.length > 0 && env.saved.every((s) => s.content === original), 'every write of that file held the original: ' + JSON.stringify(env.saved));
  assert.ok(other, 'the other note is still there');
});

check('B06: the session keeps the person\'s text when the app quits with a request in flight', async () => {
  const original = 'Unsaved draft, no file yet.\n';
  const env = await setup({ note: original });
  select(env, 'Unsaved draft, no file yet.');
  await send(env, 'rewrite', 'x');
  env.editor.dispatchEvent({ type: 'input' });
  const session = lastSession(env);
  assert.equal(session.tabs.find((t) => t.id === env.tab.id).content, original);
});

// ---------------------------------------------------------------------------------------------------
// B09: only the words are replaced
// ---------------------------------------------------------------------------------------------------
const LIST = 'Shopping\n- milk\n  - oat milk\n- eggs\n';

check('B09: a failed rewrite of an indented list item leaves the note exactly as it was, and Retry is still a rewrite', async () => {
  const env = await setup({ note: LIST });
  caretAt(env, LIST.indexOf('oat') + 1);
  const call = await send(env, 'rewrite', 'shorter');
  await answer(env, call, '', 'boom');
  assert.equal(noteText(env), LIST, 'the indent is back');
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar is open again');
  assert.equal(env.el('inline-prompt-badge').textContent, I18N.en.badgeRewrite, 'as a rewrite, not an ask');
  const again = env.calls.llm.length;
  env.el('btn-inline-prompt-retry').onclick();
  await env.flush();
  assert.equal(env.calls.llm.length, again + 1, 'Retry sent the request');
  await answer(env, env.calls.llm[again], 'a smaller line');
  assert.equal(noteText(env), 'Shopping\n- milk\n  a smaller line\n- eggs\n', 'the answer replaced the words, inside the indent');
});

check('B09: a selection that ends with a line break keeps it - failure and success', async () => {
  const env = await setup({ note: LIST });
  select(env, '- milk\n');
  const call = await send(env, 'rewrite', 'shorter');
  await answer(env, call, '', 'boom');
  assert.equal(noteText(env), LIST);
  env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });
  select(env, '- milk\n');
  const ok = await send(env, 'rewrite', 'shorter');
  await answer(env, ok, '- milk (2 l)');
  assert.equal(noteText(env), 'Shopping\n- milk (2 l)\n  - oat milk\n- eggs\n', 'the answer did not glue to the next line');
});

check('B09: Alt+C keeps the indentation and the line break, on success and on a failure', async () => {
  const env = await setup({ note: LIST });
  caretAt(env, LIST.indexOf('oat') + 1);
  const fail = await altC(env);
  await answer(env, fail, '', 'boom');
  assert.equal(noteText(env), LIST);
  const ok = await altC(env);
  await answer(env, ok, '- oat drink');
  assert.equal(noteText(env), 'Shopping\n- milk\n  - oat drink\n- eggs\n');
  select(env, '- milk\n');
  const third = await altC(env);
  await answer(env, third, '- milk!');
  assert.equal(noteText(env), 'Shopping\n- milk!\n  - oat drink\n- eggs\n');
});

// ---------------------------------------------------------------------------------------------------
// B10: the bar finds its target again
// ---------------------------------------------------------------------------------------------------
check('B10: typing in the note while the bar is open - the rewrite still hits the words that were selected', async () => {
  const env = await setup({ note: 'AAA BBB CCC' });
  select(env, 'BBB');
  openBar(env, 'rewrite');
  env.el('inline-prompt-input').value = 'make it loud';
  env.editor.value = 'XX' + env.editor.value; // typed at the very start
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, 1);
  await answer(env, env.calls.llm[0], 'LOUD');
  assert.equal(noteText(env), 'XXAAA LOUD CCC');
});

check('B10: an answer landing above while the bar is open - the second question still goes under ITS line', async () => {
  const env = await setup({ note: 'line one\nline two\nline three' });
  caretAt(env, 3);
  const one = await send(env, 'ask', 'q1');
  caretAt(env, noteText(env).length);
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'q2';
  const long = 'ANSWER-ONE-IS-A-LOT-LONGER-THAN-THE-WAITING-TEXT-IT-REPLACES-SO-EVERYTHING-BELOW-MOVES';
  await answer(env, one, long);
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, 2);
  await answer(env, env.calls.llm[1], 'ANSWER-2');
  assert.equal(noteText(env), `line one\n\n${long}\n\nline two\nline three\n\nANSWER-2\n`);
});

check('B10: the words were edited meanwhile - nothing is sent, nothing is overwritten, and the person is told', async () => {
  const env = await setup({ note: 'AAA BBB CCC' });
  select(env, 'BBB');
  openBar(env, 'rewrite');
  env.el('inline-prompt-input').value = 'make it loud';
  env.editor.value = 'AAA BxB CCC';
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, 0, 'no request');
  assert.equal(noteText(env), 'AAA BxB CCC', 'the note is untouched');
  assert.ok(env.hidden('inline-prompt-bar'), 'the bar is closed');
  assert.equal(env.toast(), I18N.en.askTargetMoved);
});

check('B10: Retry after a failure, when an answer landed above meanwhile, is about the same words', async () => {
  const env = await setup({ note: 'top line\nmiddle line\nbottom line\n' });
  select(env, 'top line');
  const first = await send(env, 'ask', 'q1');
  select(env, 'bottom line');
  const second = await send(env, 'ask', 'q2');
  await answer(env, first, 'A-LONG-ANSWER-THAT-MOVES-EVERYTHING');
  caretAt(env, noteText(env).indexOf('middle') + 2); // the caret has moved elsewhere: Retry has to be about the words that failed
  await answer(env, second, '', 'boom');
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar is back');
  const before = env.calls.llm.length;
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, before + 1);
  await answer(env, env.calls.llm[before], 'A2');
  assert.equal(noteText(env), 'top line\n\nA-LONG-ANSWER-THAT-MOVES-EVERYTHING\n\nmiddle line\nbottom line\n\nA2\n\n');
});

// ---------------------------------------------------------------------------------------------------
// B30: a request that ends without changing the note
// ---------------------------------------------------------------------------------------------------
check('B30: a failed ask leaves an unmodified note unmodified, and closing it does not ask to save', async () => {
  const env = await setup({ note: 'Welcome to the note.\n', dirty: false });
  select(env, 'Welcome to the note.');
  const call = await send(env, 'ask', 'translate');
  assert.equal(env.tab.isDirty, true, 'while it waits the note shows the waiting text');
  await answer(env, call, '', 'boom');
  assert.equal(noteText(env), 'Welcome to the note.\n');
  assert.equal(env.tab.isDirty, false, 'identical text: not modified');
  env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });
});

check('B30: a cancelled ask and a failed rewrite / correction do the same', async () => {
  const env = await setup({ note: 'One line here.\n', dirty: false });
  select(env, 'One line here.');
  const ask = await send(env, 'ask', 'translate');
  env.abort(ask.reqId);
  assert.equal(noteText(env), 'One line here.\n');
  assert.equal(env.tab.isDirty, false, 'cancel');

  select(env, 'One line here.');
  const rewrite = await send(env, 'rewrite', 'shorter');
  await answer(env, rewrite, '', 'boom');
  assert.equal(env.tab.isDirty, false, 'failed rewrite');
  env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });

  select(env, 'One line here.');
  const fix = await altC(env);
  await answer(env, fix, '', 'boom');
  assert.equal(env.tab.isDirty, false, 'failed correction');
});

check('B30: a note that was modified before stays modified; so does one the person changed while the request waited', async () => {
  const env = await setup({ note: 'Line A.\nLine B.\n', dirty: true });
  select(env, 'Line A.');
  const call = await send(env, 'ask', 'translate');
  await answer(env, call, '', 'boom');
  assert.equal(env.tab.isDirty, true, 'it was modified before');
  env.key('inline-prompt-input', { key: 'Escape', code: 'Escape', keyCode: 27 });

  const clean = await setup({ note: 'Line A.\nLine B.\n', dirty: false });
  select(clean, 'Line A.');
  const waiting = await send(clean, 'ask', 'translate');
  clean.editor.value = clean.editor.value + 'typed meanwhile\n';
  await answer(clean, waiting, '', 'boom');
  assert.equal(clean.tab.isDirty, true, 'the person typed: it is modified');
});

check('B30: an answer that arrives is a change, of course', async () => {
  const env = await setup({ note: 'Line A.\n', dirty: false });
  select(env, 'Line A.');
  const call = await send(env, 'ask', 'translate');
  await answer(env, call, 'Zeile A.');
  assert.equal(env.tab.isDirty, true);
});

// ---------------------------------------------------------------------------------------------------
// B17: no key in an error, and the error in the UI language
// ---------------------------------------------------------------------------------------------------
const KEY = 'AIzaSyFAKEKEY_1234567890abcdefghijk';
const GO_ERROR = 'Gemini接続エラー: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=' + KEY +
  '": dial tcp 142.250.1.1:443: connectex: A connection attempt failed';

function cloudSetup(env) {
  env.config.text.baseUrl = 'https://generativelanguage.googleapis.com';
  env.config.text.model = 'gemini-flash-lite-latest';
  env.config.text.apiKey = KEY;
  env.config.general.cloudConsent = { 'generativelanguage.googleapis.com': '2026-09-01' };
}

check('B17: the ask bar\'s Details, its sentence and the note carry no key', async () => {
  const env = await setup({ note: 'Launch date is still open.\n', path: 'C:\\demo\\sync.md' });
  cloudSetup(env);
  select(env, 'Launch date is still open.');
  const call = await send(env, 'ask', 'make it shorter');
  await answer(env, call, '', GO_ERROR);
  const detail = env.el('inline-prompt-error-detail').textContent;
  const summary = env.el('inline-prompt-error-text').textContent;
  assert.ok(!detail.includes(KEY) && !/key=AIza/.test(detail), 'Details: ' + detail);
  assert.ok(!summary.includes(KEY), summary);
  assert.ok(!hasJapanese(summary), 'the sentence is English: ' + summary);
  assert.equal(noteText(env), 'Launch date is still open.\n');
  assert.ok(!(await savedNow(env)).content.includes(KEY));
});

check('B17: a task without a restore (Auto selector, image) writes a plain sentence, in the UI language, and no key', async () => {
  for (const language of ['en', 'ja']) {
    const env = await setup({ language, note: 'Notes\n[[WAIT]]\n', path: 'C:\\demo\\t.md' });
    cloudSetup(env);
    const id = env.bridge.startLlmTask({ tabId: env.tab.id, prompt: 'summarize', anchorText: '[[WAIT]]' });
    assert.ok(id);
    env.llmAnswer(env.calls.llm[0], '', GO_ERROR);
    await env.flush();
    const text = noteText(env);
    assert.ok(!text.includes(KEY) && !/key=/.test(text), language + ': ' + text);
    assert.ok(text.includes('[' + I18N[language].llmError), language + ': the line is marked as an error: ' + text);
    assert.equal(hasJapanese(text.replace(I18N.ja.llmError, '')), language === 'ja' ? true : false, language + ' words: ' + text);
    assert.ok(!text.includes('Gemini接続エラー'), 'the raw Go text is not written into the note');
    const toast = env.toast();
    assert.ok(!toast.includes(KEY) && !/key=/.test(toast), 'toast: ' + toast);
    assert.ok(!(await savedNow(env)).content.includes(KEY), 'the file');
    // the task list keeps a redacted one-line detail
    const tasks = env.taskManager.getActiveTasks();
    assert.equal(tasks.length, 0);
  }
});

check('B17: a pasted image that fails writes no key into the note', async () => {
  const env = await setup({ note: 'top\n' });
  cloudSetup(env);
  env.config.general.pasteImageOcr = true;
  env.config.vision.apiKey = KEY;
  caretAt(env, env.editor.value.length);
  pasteImage(env);
  await env.flush();
  env.window.__onLLMResult(env.vision[0].reqId, '', GO_ERROR);
  await env.flush();
  assert.ok(!noteText(env).includes(KEY) && !/key=/.test(noteText(env)), noteText(env));
  assert.ok(noteText(env).includes('[' + I18N.en.llmError), noteText(env));
  assert.ok(!hasJapanese(noteText(env)), noteText(env));
});

check('B17: an error the classifier does not know keeps its own text, redacted (a key given in the settings too)', async () => {
  const env = await setup({ note: 'Notes\n[[WAIT]]\n' });
  env.config.text.apiKey = 'my-secret-token-value';
  env.bridge.startLlmTask({ tabId: env.tab.id, prompt: 'x', anchorText: '[[WAIT]]' });
  env.llmAnswer(env.calls.llm[0], '', 'weird failure for my-secret-token-value at ?key=abc123def456&alt=json');
  await env.flush();
  assert.ok(!noteText(env).includes('my-secret-token-value') && !/abc123def456/.test(noteText(env)), noteText(env));
  assert.ok(noteText(env).includes('weird failure'), 'what is left is still readable: ' + noteText(env));
});

check('LlmError.redact: query keys, Google keys, bearer tokens and given secrets go; ordinary text stays', async () => {
  const r = (s, secrets) => LlmError.redact(s, secrets);
  assert.equal(r('Post "https://x.example/v1?key=SECRET123&alt=json": EOF'), 'Post "https://x.example/v1?key=***&alt=json": EOF');
  assert.equal(r('failed at ?api_key=abc&x=1'), 'failed at ?api_key=***&x=1');
  assert.ok(!r('bad AIzaSyFAKEKEY_1234567890abcdefghijk here').includes('AIza'));
  assert.equal(r('Authorization: Bearer abcdefgh12345678'), 'Authorization: Bearer ***');
  assert.equal(r('the key hunter2hunter2 was refused', ['hunter2hunter2']), 'the key *** was refused');
  assert.equal(r('max_tokens=200 and a monkey=1'), 'max_tokens=200 and a monkey=1', 'names that only end like a key parameter are left alone');
  assert.equal(r('APIエラー (401): {"error":"nope"}'), 'APIエラー (401): {"error":"nope"}');
  assert.equal(r(''), '');
  assert.equal(r(undefined), '');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err));
  }
}
console.log(failed ? `${failed} of ${queue.length} AI request fix test(s) FAILED.` : `All ${queue.length} AI request fix tests passed.`);
process.exit(failed ? 1 : 0);
