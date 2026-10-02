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
//   C*   (the last block of checks) the answer lands in the right place with the right text: "$&" in an answer / replacement, a restore
//        after Ctrl+Z, a rewrite over another request's waiting text, an empty answer, a cancelled command's late answer, the right
//        pane's failure bar and previews, a pasted table / picture next to text and after a note switch, Ctrl+Shift+V outside the editor
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
// The answer lands in the right place, with the right text (exploratory review 2026-09-30: C1-09/14/15, C4-17, C5-07/08/09, C7-05, C8-04/06/07/14)
// ---------------------------------------------------------------------------------------------------
const HtmlToMd = createRequire(import.meta.url)('../frontend/js/html_to_md.js');
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27 };

check('$: an answer holding "$&", "$$" or "$\'" lands as it is when the editor refuses the insert command', async () => {
  const env = await setup({ note: 'question\n' });
  select(env, 'question');
  const call = await send(env, 'ask', 'show me');
  env.window.document.execCommand = () => false; // a hidden editor: the command is refused and the text is set directly
  const tricky = 'cost $& and $$ and $\' and $` and $1';
  await answer(env, call, tricky);
  assert.ok(noteText(env).includes(tricky), 'the answer is in the note as typed: ' + JSON.stringify(noteText(env)));
  assert.ok(!noteText(env).includes('[AI Generating'), 'and the waiting text is gone');
});

check('$: a value put into a UI string ("CLI error: {err}") is not expanded either', async () => {
  const env = await setup({ note: 'Notes\n[[CMD]]\n' });
  const id = env.bridge.runCommandTask({ tabId: env.tab.id, command: 'whatever', anchorText: '[[CMD]]' });
  assert.ok(id, 'the command task started');
  const tricky = 'failed at $& then $\'';
  env.cliAnswer(env.calls.command[0], { exitCode: 2, error: tricky, output: '' });
  await env.flush();
  assert.ok(env.messages.some((m) => m.includes(tricky)), 'a toast says it as it is: ' + JSON.stringify(env.messages.slice(-3)));
});

check('C4-17: Replace all puts the replacement in as typed ("$&", "$$"); only a regex search expands it', async () => {
  const env = await setup({ note: 'foo bar foo' });
  env.editor.selectionStart = env.editor.selectionEnd = 0;
  env.el('find-input').value = 'foo';
  env.el('replace-input').value = 'Q$&Q$$';
  env.el('find-input').dispatchEvent({ type: 'input' });
  env.el('btn-replace-all').onclick();
  assert.equal(env.editor.value, 'Q$&Q$$ bar Q$&Q$$', 'as Replace (one) would put it');

  const rx = await setup({ note: 'foo bar foo' });
  rx.editor.selectionStart = rx.editor.selectionEnd = 0;
  rx.el('btn-find-regex').onclick(); // regex on
  rx.el('find-input').value = 'fo+';
  rx.el('replace-input').value = '[$&]';
  rx.el('find-input').dispatchEvent({ type: 'input' });
  rx.el('btn-replace-all').onclick();
  assert.equal(rx.editor.value, '[foo] bar [foo]', 'with a regular expression "$&" is still the match');
});

check('C1-15: Ctrl+Z on a waiting rewrite / ask, then the request fails or answers nothing - the note stays as it was', async () => {
  const original = 'Intro\nThe first paragraph was written badly.\nOutro\n';
  for (const [kind, reply, error] of [['rewrite', '', 'boom'], ['rewrite', '  ', ''], ['ask', '', 'boom'], ['ask', '<think>x</think>', '']]) {
    const env = await setup({ note: original });
    select(env, 'The first paragraph was written badly.');
    const call = await send(env, kind, 'improve');
    assert.ok(noteText(env).includes('[AI '), 'it waits');
    env.undo(); // Ctrl+Z: the waiting text goes, the original line is back
    assert.equal(env.editor.value, original, kind + ': undone');
    await answer(env, call, reply, error);
    assert.equal(noteText(env), original, `${kind} / ${JSON.stringify(reply)} / ${error}: nothing was appended`);
    env.key('inline-prompt-input', ESC);
  }
  // an answer that does come is still written, once, at the end (the waiting text is gone, so there is no better place)
  const env = await setup({ note: original });
  select(env, 'The first paragraph was written badly.');
  const call = await send(env, 'rewrite', 'improve');
  env.undo();
  await answer(env, call, 'LATE-ANSWER');
  assert.equal(noteText(env).split('LATE-ANSWER').length, 2, 'once: ' + JSON.stringify(noteText(env)));
});

check('C1-14: a rewrite / correction over a span that holds another request\'s waiting text is refused, and that answer still lands under its line', async () => {
  const env = await setup({ note: 'Line 1\nLine 2\nLine 3\nLine 4\n' });
  select(env, 'Line 2');
  const ask = await send(env, 'ask', 'explain line two');
  const waiting = noteText(env);
  assert.ok(waiting.includes('[AI Generating: explain line two...]'));
  // from "Line 2" to "Line 3": the span holds the waiting text in the middle
  env.editor.selectionStart = waiting.indexOf('Line 2');
  env.editor.selectionEnd = waiting.indexOf('Line 3') + 'Line 3'.length;
  env.window.document.activeElement = env.editor;
  const sent = env.calls.llm.length;
  openBar(env, 'rewrite');
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar opens');
  env.el('inline-prompt-input').value = 'tidy up';
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, sent, 'no request went out');
  assert.equal(noteText(env), waiting, 'the note is as it was');
  assert.equal(env.toast(), I18N.en.rewriteOverWaiting);
  // Alt+C on the waiting line itself
  select(env, '[AI Generating: explain line two...]');
  env.key(env.editor, { key: 'c', code: 'KeyC', keyCode: 67, altKey: true });
  await env.flush();
  assert.equal(env.calls.llm.length, sent, 'no correction either');
  assert.equal(noteText(env), waiting);
  await answer(env, ask, 'ANSWER-2');
  assert.equal(noteText(env), 'Line 1\nLine 2\n\nANSWER-2\n\nLine 3\nLine 4\n');
  // once it has been answered the same span can be rewritten
  select(env, 'Line 2');
  await send(env, 'rewrite', 'tidy up');
});

check('C1-09 / C8-07: an empty, blank or think-only answer is a failure ("returned nothing"), not "inserted"; the note is as it was', async () => {
  for (const reply of ['', '   \n  ', '<think>hmm</think>', '<think>unfinished']) {
    const env = await setup({ note: 'question\n' });
    select(env, 'question');
    const call = await send(env, 'ask', 'answer please');
    await answer(env, call, reply);
    assert.equal(noteText(env), 'question\n', 'ask ' + JSON.stringify(reply) + ': no blank lines left behind');
    assert.ok(!env.hidden('inline-prompt-bar'), 'the bar is back with the failure (Retry)');
    assert.equal(env.el('inline-prompt-error-text').textContent, I18N.en.llmEmptyAnswer);
    assert.ok(!env.messages.includes(I18N.en.llmResponseInserted), 'never "inserted"');
  }
  // a picture whose text could not be read
  for (const reply of ['', '<think>x</think>']) {
    const env = await setup({ note: 'top\n' });
    env.config.general.pasteImageOcr = true;
    env.config.vision.apiKey = 'test-vision-key';
    caretAt(env, env.editor.value.length);
    pasteImage(env);
    await env.flush();
    env.window.__onLLMResult(env.vision[0].reqId, reply, '');
    await env.flush();
    assert.equal(noteText(env), 'top\n', 'image ' + JSON.stringify(reply) + ': the waiting text and its blank lines are gone');
    assert.ok(env.toast().includes(I18N.en.llmEmptyAnswer), env.toast());
    assert.ok(!env.messages.includes(I18N.en.llmResponseInserted));
  }
  // a task that writes its failure into the note says the same there
  const env = await setup({ note: 'Notes\n[[WAIT]]\n' });
  env.bridge.startLlmTask({ tabId: env.tab.id, prompt: 'x', anchorText: '[[WAIT]]' });
  env.llmAnswer(env.calls.llm[0], '', '');
  await env.flush();
  assert.ok(noteText(env).includes(I18N.en.llmEmptyAnswer) && !noteText(env).includes('[[WAIT]]'), noteText(env));
});

check('C7-05 / C3-11: cancelling a running command with Esc - the host\'s late "cancelled" answer opens no tab and does not bring the bar back', async () => {
  const env = await setup({ note: 'b\na\n' });
  env.key(env.editor, { key: 'e', code: 'KeyE', keyCode: 69, ctrlKey: true });
  assert.ok(!env.hidden('cli-filter-bar'), 'the command bar is open');
  env.el('cli-filter-input').value = 'sort';
  env.key('cli-filter-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.calls.command.length, 1, 'the command runs');
  env.key('cli-filter-input', ESC);
  assert.deepEqual(env.calls.cancelCommand, [env.calls.command[0].reqId], 'the host is told to stop it');
  assert.ok(env.hidden('cli-filter-bar'), 'the bar is closed');
  const activeBefore = env.bridge.getActiveTab().id;
  env.cliAnswer(env.calls.command[0], { exitCode: 130, error: 'Command was cancelled by user', output: '' });
  await env.flush();
  assert.equal(env.bridge.getActiveTab().id, activeBefore, 'no error tab took the screen');
  assert.ok(env.hidden('cli-filter-bar'), 'and the bar stays closed');
  assert.ok(!env.messages.includes(I18N.en.cliErrorTabOpened), 'no "details opened in a new tab"');
});

async function splitWithRightNote(env, rightText) {
  env.window.__testHelper.createTab('right.md', rightText);
  const rightId = env.bridge.getActiveTab().id;
  env.window.__testHelper.createTab('left.md', 'left note\n'); // the left pane shows this one
  await env.window.__testHelper.openSplitEditor(rightId); // the right pane is the one being worked in
  const right = env.el('editor-secondary');
  assert.equal(env.window.__testHelper.getActiveEditor(), right);
  return { rightId, right };
}

check('C5-09: an ask in the right pane that fails brings the bar back with Retry, like the left pane', async () => {
  const env = await setup({ note: 'a note\n' });
  const { rightId, right } = await splitWithRightNote(env, 'beta line one\nbeta line two\n');
  right.focus();
  right.setSelectionRange(0, 13);
  env.key(right, { key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true });
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar opens on the right note');
  env.el('inline-prompt-input').value = 'translate';
  env.key('inline-prompt-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.calls.llm.length, 1, 'the request went out');
  await answer(env, env.calls.llm[0], '', 'boom');
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar is back, not only a toast');
  assert.equal(env.el('inline-prompt-input').value, 'translate', 'with the instruction');
  assert.ok(!env.hidden('inline-prompt-error'), 'and the failure with its Retry');
  assert.equal(env.bridge.getTabText(rightId), 'beta line one\nbeta line two\n', 'the note is as it was');
});

check('C5-07: the right pane shows another note as a preview while its answer arrives - the preview is brought up to date', async () => {
  const env = await setup({ note: 'a note\n' });
  const { rightId, right } = await splitWithRightNote(env, 'beta line one\nbeta line two\n');
  right.focus();
  right.setSelectionRange(0, 13);
  env.key(right, { key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true });
  env.el('inline-prompt-input').value = 'translate';
  env.key('inline-prompt-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  await env.el('btn-secondary-mode').onclick(); // the right pane turns into a preview while the request waits
  await env.flush();
  assert.ok(env.el('secondary-preview-pane').innerHTML.includes('[AI Generating'), 'the preview shows the waiting text');
  await answer(env, env.calls.llm[0], 'BETA-ANSWER');
  await env.flush();
  assert.ok(env.bridge.getTabText(rightId).includes('BETA-ANSWER'), 'the note has the answer');
  const shown = env.el('secondary-preview-pane').innerHTML;
  assert.ok(shown.includes('BETA-ANSWER') && !shown.includes('[AI Generating'), 'and so does the preview: ' + shown);
});

check('C5-08: a result that lands while the full preview (Ctrl+P) is open shows up in it', async () => {
  const env = await setup({ note: 'first line\n' });
  env.key(env.editor, { key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true });
  await env.flush();
  assert.ok(env.el('preview-pane').innerHTML.includes('first line'), 'the preview is open: ' + env.el('preview-pane').innerHTML);
  // what a {{ }} task does when its answer comes: it writes the note and tells the page through the editor's input event
  env.editor.value = 'first line\nRESULT-OF-THE-TASK\n';
  env.editor.dispatchEvent({ type: 'input' });
  env.fireTimers(120);
  await env.flush();
  assert.ok(env.el('preview-pane').innerHTML.includes('RESULT-OF-THE-TASK'), 'the preview is not left stale: ' + env.el('preview-pane').innerHTML);
});

function pasteHtml(env, html, text) {
  env.editor.dispatchEvent({
    type: 'paste',
    clipboardData: { types: ['text/html', 'text/plain'], items: [], getData: (type) => (type === 'text/html' ? html : text) },
    preventDefault() { this.defaultPrevented = true; }
  });
}
const TABLE_HTML = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
const TABLE_MD = '| A | B |\n| --- | --- |\n| 1 | 2 |';

check('C8-14: Ctrl+Shift+V pressed outside the editor does not turn the next Ctrl+V into a "plain" paste', async () => {
  const env = await setup({ note: '' });
  env.window.HtmlToMd = HtmlToMd;
  env.key('find-input', { key: 'V', code: 'KeyV', keyCode: 86, ctrlKey: true, shiftKey: true }); // the find box has the focus
  pasteHtml(env, TABLE_HTML, 'A\tB\n1\t2');
  await env.flush();
  assert.equal(env.editor.value, TABLE_MD, 'Ctrl+V still converts the table: ' + JSON.stringify(env.editor.value));
  // in the editor it still means "as it is": the converter is left out
  const plain = await setup({ note: '' });
  plain.window.HtmlToMd = HtmlToMd;
  plain.key(plain.editor, { key: 'V', code: 'KeyV', keyCode: 86, ctrlKey: true, shiftKey: true });
  pasteHtml(plain, TABLE_HTML, 'A\tB\n1\t2');
  await plain.flush();
  assert.ok(!plain.editor.value.includes('| --- |'), 'Ctrl+Shift+V in the editor pastes it as it is: ' + JSON.stringify(plain.editor.value));
});

check('C8-04: a pasted table keeps apart from the text it was pasted next to', async () => {
  const cases = [
    ['Sales figures', 13, 'Sales figures\n\n' + TABLE_MD, 'at the end of a line'],
    ['Sales figures\n', 14, 'Sales figures\n\n' + TABLE_MD, 'on the empty line under it'],
    ['Intro line.', 0, TABLE_MD + '\n\nIntro line.', 'in front of a line of text'],
    ['Intro line.', 6, 'Intro \n\n' + TABLE_MD + '\n\nline.', 'inside a line'],
    ['', 0, TABLE_MD, 'an empty note']
  ];
  for (const [note, caret, expected, label] of cases) {
    const env = await setup({ note: note });
    env.window.HtmlToMd = HtmlToMd;
    caretAt(env, caret);
    pasteHtml(env, TABLE_HTML, 'A\tB\n1\t2');
    await env.flush();
    assert.equal(env.editor.value, expected, label);
  }
  // a second paste right behind the first
  const twice = await setup({ note: '' });
  twice.window.HtmlToMd = HtmlToMd;
  pasteHtml(twice, TABLE_HTML, '');
  await twice.flush();
  pasteHtml(twice, TABLE_HTML, '');
  await twice.flush();
  assert.equal(twice.editor.value, TABLE_MD + '\n\n' + TABLE_MD, 'two tables are two blocks, not "| 1 | 2 || A | B |"');
});

check('C8-06: switching notes while a pasted picture is being saved - the link goes into the note it was pasted in', async () => {
  const release = [];
  const env = await setup({ note: 'AAA note\n', backend: { saveAsset: () => new Promise((resolve) => release.push(resolve)) } });
  env.window.HtmlToMd = HtmlToMd;
  env.config.general.pasteImageOcr = false; // the picture is kept as a file
  const a = env.tab;
  caretAt(env, env.editor.value.length);
  pasteImage(env);
  await env.flush();
  assert.equal(release.length, 1, 'the save is under way');
  env.window.__testHelper.createTab('b.md', 'BBB note\n'); // the person goes to another note meanwhile
  const b = env.bridge.getActiveTab();
  assert.notEqual(b.id, a.id);
  release[0]({ relPath: './assets/pasted-1.png' });
  await env.flush();
  assert.equal(env.bridge.getTabText(b.id), 'BBB note\n', 'the other note is not touched');
  assert.equal(env.bridge.getTabText(a.id), 'AAA note\n\n![image](./assets/pasted-1.png)', 'the link is in the note the picture was pasted in');
  assert.equal(a.isDirty, true, 'which is modified now');

  // without a switch it lands at the caret, on a line of its own
  const same = await setup({ note: 'AAA note\n', backend: { saveAsset: async () => ({ relPath: './assets/pasted-2.png' }) } });
  same.window.HtmlToMd = HtmlToMd;
  same.config.general.pasteImageOcr = false;
  caretAt(same, same.editor.value.length);
  pasteImage(same);
  await same.flush();
  assert.equal(same.editor.value, 'AAA note\n\n![image](./assets/pasted-2.png)');
});

// ---------------------------------------------------------------------------------------------------
// The ask / rewrite bar, the panels and the tasks (exploratory review 2026-09-30: C1-07 08 11 12 13 16, C3-07 08 09 13 15 19, C5-06,
// C7-10 12). docs/testing/sessions/2026-09-30-c*.md has the reproduction of each.
// ---------------------------------------------------------------------------------------------------
const ctrl = (letter, extra) => Object.assign({ key: letter, code: 'Key' + letter.toUpperCase(), keyCode: letter.toUpperCase().charCodeAt(0), ctrlKey: true }, extra);
const askLabel = (env) => env.el('inline-prompt-target').textContent;
const chars = (n) => I18N.en.askTargetSelection.replace('{count}', String(n));
// The find bar and the note search take a first query from the editor: they ask whether it is on screen and read it through ScrapQuote
// (neither is part of the fixture).
function stubSearchSeed(env) {
  env.editor.getClientRects = () => [{}];
  env.window.ScrapQuote = { searchSeed: () => '', seedFromSelection: () => '', quoteText: () => '' };
}

check('C3-07: one Esc closes one panel - Esc in the find bar or the palette leaves the ask bar, and what is typed in it', async () => {
  const env = await setup({ note: 'some text\n' });
  stubSearchSeed(env);
  select(env, 'some');
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'explain this';
  env.key('inline-prompt-input', ctrl('f')); // the find bar opens, on top of the ask bar
  assert.ok(!env.hidden('find-replace-bar') && !env.hidden('inline-prompt-bar'), 'both are open');
  env.key('find-input', ESC);
  assert.ok(env.hidden('find-replace-bar'), 'Esc closed the find bar');
  assert.ok(!env.hidden('inline-prompt-bar'), 'and only that');
  assert.equal(env.el('inline-prompt-input').value, 'explain this', 'what was typed is still there');

  env.window.__testHelper.openQuickPick(); // the palette
  assert.ok(!env.hidden('quick-pick-modal'), 'the palette is open');
  env.key('quick-pick-input', ESC);
  assert.ok(env.hidden('quick-pick-modal'), 'Esc closed the palette');
  assert.ok(!env.hidden('inline-prompt-bar'), 'and the ask bar is still there');

  env.key('inline-prompt-input', ESC);
  assert.ok(env.hidden('inline-prompt-bar'), 'the next Esc closes the ask bar');
  // the other way round: Esc in the ask bar leaves the open find bar
  select(env, 'some');
  openBar(env, 'ask');
  env.key('inline-prompt-input', ctrl('f'));
  env.key('inline-prompt-input', ESC);
  assert.ok(env.hidden('inline-prompt-bar'), 'Esc in the ask bar closed it');
  assert.ok(!env.hidden('find-replace-bar'), 'and not the find bar behind');
});

check('C3-09: with a dialog open, Ctrl+L / Ctrl+K / Ctrl+E open no bar behind it (and nothing is sent)', async () => {
  const env = await setup({ note: 'some text here\n' });
  select(env, 'some');
  for (const id of ['settings-modal', 'quick-pick-modal', 'goto-line-modal', 'confirm-modal']) {
    env.el(id).classList.remove('hidden');
    openBar(env, 'ask');
    openBar(env, 'rewrite');
    env.key(env.editor, ctrl('e'));
    assert.ok(env.hidden('inline-prompt-bar'), id + ': no ask / rewrite bar');
    assert.ok(env.hidden('cli-filter-bar'), id + ': no command bar');
    env.el(id).classList.add('hidden');
  }
  openBar(env, 'ask');
  assert.ok(!env.hidden('inline-prompt-bar'), 'with no dialog the bar opens as before');
});

check('C3-08: the ask bar and the command bar do not throw away what is typed in the other one', async () => {
  const env = await setup({ note: 'some text here\n' });
  select(env, 'some');
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'explain this';
  env.key(env.editor, ctrl('e'));
  assert.ok(!env.hidden('inline-prompt-bar'), 'Ctrl+E leaves the ask bar with text in it');
  assert.equal(env.el('inline-prompt-input').value, 'explain this');
  assert.ok(env.hidden('cli-filter-bar'), 'and does not open the command bar over it');
  assert.equal(env.toast(), I18N.en.askBarHasText, 'it says why');
  env.el('inline-prompt-input').value = '';
  env.key(env.editor, ctrl('e'));
  assert.ok(env.hidden('inline-prompt-bar') && !env.hidden('cli-filter-bar'), 'an empty ask bar still makes room');

  env.el('cli-filter-input').value = 'sort -r';
  openBar(env, 'ask');
  assert.ok(!env.hidden('cli-filter-bar'), 'Ctrl+L leaves the command bar with a command in it');
  assert.equal(env.el('cli-filter-input').value, 'sort -r');
  assert.ok(env.hidden('inline-prompt-bar'));
  assert.equal(env.toast(), I18N.en.commandBarHasText);
  openBar(env, 'rewrite');
  assert.equal(env.el('cli-filter-input').value, 'sort -r', 'Ctrl+K too');
  env.el('cli-filter-input').value = '';
  openBar(env, 'ask');
  assert.ok(!env.hidden('inline-prompt-bar') && env.hidden('cli-filter-bar'), 'an empty command bar makes room');
});

check('C1-07 / C3-15: Ctrl+L / Ctrl+K in the open bar follow the selection and the mode; what was typed stays', async () => {
  const env = await setup({ note: 'Launch date is still open.\nDocs review moved to Friday.\n' });
  select(env, 'Launch date is still open.');
  const call = await send(env, 'ask', 'make it shorter');
  await answer(env, call, '', 'boom');
  assert.ok(!env.hidden('inline-prompt-error'), 'the bar is back with the failure');
  openBar(env, 'ask');
  assert.ok(!env.hidden('inline-prompt-error'), 'the same key with nothing changed only brings the caret back');
  assert.equal(askLabel(env), chars(26));

  select(env, 'Docs review moved to Friday.'); // another line
  openBar(env, 'ask');
  assert.ok(env.hidden('inline-prompt-error'), 'the old failure is gone');
  assert.equal(env.el('inline-prompt-input').value, 'make it shorter', 'the instruction stays');
  assert.equal(askLabel(env), chars(28), 'the bar is about the new selection');
  const before = env.calls.llm.length;
  await pressEnterInBar(env);
  const sent = env.calls.llm[before];
  assert.ok(sent.prompt.includes('Docs review moved to Friday.') && !sent.prompt.includes('Launch date'), 'Enter sends the new line: ' + sent.prompt);

  // Ctrl+K with the ask bar open turns it into the rewrite bar
  select(env, 'Docs review moved to Friday.');
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'draft';
  openBar(env, 'rewrite');
  assert.equal(env.el('inline-prompt-badge').textContent, I18N.en.badgeRewrite, 'the badge says Rewrite');
  assert.ok(env.el('inline-prompt-bar').classList.contains('inline-prompt-rewrite'));
  assert.equal(env.el('inline-prompt-input').value, 'draft');
  openBar(env, 'rewrite');
  assert.equal(env.el('inline-prompt-badge').textContent, I18N.en.badgeRewrite, 'pressed again it stays');
  openBar(env, 'ask');
  assert.equal(env.el('inline-prompt-badge').textContent, I18N.en.badgeAsk, 'and Ctrl+L turns it back');
});

check('C1-08 / C3-13: a bar left open when another note comes into the pane follows it, so Enter is about that note', async () => {
  const env = await setup({ note: 'alpha line\n' });
  const a = env.tab;
  select(env, 'alpha line');
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'make formal';
  env.window.__testHelper.createTab('b.md', 'beta line\n');
  const b = env.bridge.getActiveTab();
  assert.notEqual(b.id, a.id, 'another note is shown now');
  assert.ok(!env.hidden('inline-prompt-bar'), 'the bar stays open');
  assert.equal(env.el('inline-prompt-input').value, 'make formal', 'with what was typed');
  assert.equal(askLabel(env), I18N.en.askTargetNote, 'and it is about the note on screen now');
  await pressEnterInBar(env);
  assert.equal(env.calls.llm.length, 1);
  assert.ok(env.calls.llm[0].prompt.includes('beta line') && !env.calls.llm[0].prompt.includes('alpha'), env.calls.llm[0].prompt);
  assert.ok(env.bridge.getTabText(b.id).includes('[AI Generating'), 'the waiting text is in the note on screen');
  assert.equal(env.bridge.getTabText(a.id), 'alpha line\n', 'the other note was not touched');

  // a rewrite follows too when the new note has text at the caret; with nothing to rewrite the bar goes instead of staying stale
  const rw = await setup({ note: 'alpha line\n' });
  rw.window.__testHelper.createTab('b.md', 'beta line\nsecond\n');
  const bId = rw.bridge.getActiveTab().id;
  rw.editor.setSelectionRange(4, 4); // the caret rests in the first line of b
  rw.window.__mdMemoRPC.switchTab(rw.tab.id);
  select(rw, 'alpha line');
  openBar(rw, 'rewrite');
  rw.el('inline-prompt-input').value = 'shout';
  rw.window.__mdMemoRPC.switchTab(bId);
  assert.ok(!rw.hidden('inline-prompt-bar'), 'the rewrite bar follows to a note with a line at the caret');
  await pressEnterInBar(rw);
  assert.ok(rw.calls.llm.length === 1 && rw.calls.llm[0].prompt.includes('beta line'), 'the rewrite is about the line of the note on screen');

  const empty = await setup({ note: 'alpha line\n' });
  select(empty, 'alpha line');
  openBar(empty, 'rewrite');
  empty.el('inline-prompt-input').value = 'shout';
  empty.window.__testHelper.createTab('c.md', '');
  assert.ok(empty.hidden('inline-prompt-bar'), 'a note with nothing to rewrite: the old bar is not left behind');
  assert.equal(empty.toast(), I18N.en.aiCorrectionNoText);
});

check('C1-13: "AI settings" in the failure banner keeps the instruction for the way back (once, for that note)', async () => {
  const env = await setup({ note: 'a line to improve\n' });
  env.window.MermaidTone = createRequire(import.meta.url)('../frontend/js/mermaid_tone.js'); // Settings reads its tone
  select(env, 'a line to improve');
  const call = await send(env, 'ask', 'make it punchier and shorter, in a friendly tone');
  await answer(env, call, '', 'boom');
  env.el('btn-inline-prompt-error-settings').onclick();
  assert.ok(env.hidden('inline-prompt-bar'), 'the bar made way for Settings');
  assert.ok(!env.hidden('settings-modal'), 'Settings is open');
  env.el('settings-modal').classList.add('hidden'); // closed again
  select(env, 'a line to improve');
  openBar(env, 'ask');
  assert.equal(env.el('inline-prompt-input').value, 'make it punchier and shorter, in a friendly tone', 'the instruction is back');
  env.key('inline-prompt-input', ESC);
  openBar(env, 'ask');
  assert.equal(env.el('inline-prompt-input').value, '', 'and only once');
});

check('C1-16: a failure that cannot reopen the bar (another bar is open) names the request in its toast', async () => {
  const env = await setup({ note: 'first question\nsecond question\n' });
  select(env, 'first question');
  const first = await send(env, 'ask', 'translate to French');
  select(env, 'second question');
  openBar(env, 'ask'); // typing something else when the first one fails
  env.el('inline-prompt-input').value = 'half typed';
  await answer(env, first, '', 'boom');
  const toast = env.toast();
  assert.ok(toast.includes('translate to French'), 'the toast says which request: ' + toast);
  assert.ok(toast.includes(I18N.en.llmErrOther), 'and what happened: ' + toast);
  assert.equal(env.el('inline-prompt-input').value, 'half typed', 'what is being typed is not touched');
});

check('C1-11: closing a note settles its waiting requests: no task card stays Running, the count drops, the late answer is ignored', async () => {
  const env = await setup({ note: 'a\n' });
  env.window.__testHelper.createTab('b.md', 'b one\nb two\n[[CMD]]\n');
  const tabB = env.bridge.getActiveTab().id;
  select(env, 'b one');
  const ask = await send(env, 'ask', 'translate');
  select(env, 'b two');
  const rewrite = await send(env, 'rewrite', 'shorter');
  const cmdId = env.bridge.runCommandTask({ tabId: tabB, command: 'sleep 5', anchorText: '[[CMD]]' });
  assert.ok(cmdId, 'a command task is under way too');
  assert.ok(!env.hidden('stat-llm-indicator'), 'the status bar counts the waiting requests');
  assert.ok(env.activeTasks().length >= 2, 'and the task list shows running cards');
  env.window.__mdMemoRPC.closeTab(tabB);
  await env.flush();
  if (!env.hidden('confirm-modal')) { // unsaved changes: Don't save
    env.el('confirm-modal-dontsave').onclick();
    await env.flush();
  }
  assert.equal(env.bridge.getTabText(tabB), null, 'the note is closed');
  assert.deepEqual(env.activeTasks(), [], 'no card is left Running');
  assert.ok(env.hidden('stat-llm-indicator'), 'the count is gone');
  assert.equal(env.heldTimerCount(180000), 0, 'and no watchdog is armed for a note that is gone');
  assert.deepEqual(env.calls.cancelCommand, [cmdId], 'the command is stopped');
  await answer(env, ask, 'late answer');
  await answer(env, rewrite, 'late rewrite');
  assert.ok(env.hidden('stat-llm-indicator'));
});

check('C1-12: with the editor hidden behind the full preview, an ask does not type its waiting text into the bar', async () => {
  const env = await setup({ note: 'typed by hand\nsecond line\n' });
  select(env, 'second line');
  openBar(env, 'ask');
  env.el('inline-prompt-input').value = 'summarize';
  env.editor.focus = () => {}; // the preview covers the editor: it cannot take the focus
  await pressEnterInBar(env);
  assert.equal(env.el('inline-prompt-input').value, 'summarize', 'the bar\'s input is not written into');
  assert.ok(noteText(env).includes('[AI Generating: summarize...]'), 'the waiting text is in the note');
  await answer(env, env.calls.llm[0], 'ANSWER');
  assert.equal(env.el('inline-prompt-input').value, 'summarize');
  assert.ok(noteText(env).includes('ANSWER') && !noteText(env).includes('[AI Generating'), 'the answer lands in the note: ' + JSON.stringify(noteText(env)));
});

check('C5-06: the answer\'s highlight is drawn in the pane the person works in (the same note in both panes)', async () => {
  const env = await setup({ note: 'shared line one\nshared line two\n' });
  const flashed = [];
  env.window.GhostDiff = { flash: (editor) => { flashed.push(editor); }, clear() {} };
  await env.window.__testHelper.openSplitEditor(env.tab.id); // the same note on the right, which has the focus now
  const right = env.el('editor-secondary');
  assert.equal(env.window.__testHelper.getActiveEditor(), right);
  right.focus();
  right.setSelectionRange(0, 15);
  env.key(right, ctrl('l'));
  env.el('inline-prompt-input').value = 'translate';
  env.key('inline-prompt-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  flashed.length = 0;
  await answer(env, env.calls.llm[0], 'ANSWER');
  assert.ok(flashed.length > 0, 'the answer is marked');
  assert.ok(flashed.every((ed) => ed === right), 'in the right pane, where the person is working');
  assert.ok(right.value.includes('ANSWER') && env.editor.value.includes('ANSWER'), 'and both panes hold it');

  // the left pane keeps getting the mark when the person works there
  const left = await setup({ note: 'shared line one\nshared line two\n' });
  const flashedLeft = [];
  left.window.GhostDiff = { flash: (editor) => { flashedLeft.push(editor); }, clear() {} };
  await left.window.__testHelper.openSplitEditor(left.tab.id);
  left.window.__mdMemoRPC.switchTab(left.tab.id); // focus back to the left pane
  select(left, 'shared line one');
  const call = await send(left, 'ask', 'translate');
  flashedLeft.length = 0;
  await answer(left, call, 'ANSWER');
  assert.ok(flashedLeft.length > 0 && flashedLeft.every((ed) => ed === left.editor), 'the left pane\'s own work is marked in the left pane');
});

check('C3-19: Enter right after the query changed does not open a line of the older query\'s answer', async () => {
  const opened = [];
  const answers = new Map();
  const found = (file) => [{ filePath: 'C:\\scraps\\' + file, fileName: file, matches: [{ lineNumber: 1, lineText: 'the', snippet: 'the' }] }];
  const env = await setup({
    note: 'x\n',
    backend: {
      searchScraps: (q) => new Promise((resolve) => answers.set(q, resolve)),
      readFileByPath: async (p) => { opened.push(p); return { content: 'x' }; }
    }
  });
  stubSearchSeed(env);
  env.key(env.editor, { key: 'F', code: 'KeyF', keyCode: 70, ctrlKey: true, shiftKey: true });
  assert.ok(!env.hidden('scraps-search-modal'), 'the note search is open');
  const input = env.el('scraps-search-input');
  input.value = 'the';
  input.dispatchEvent({ type: 'input' });
  env.fireTimers(150);
  answers.get('the')(found('2026-09-17.md'));
  await env.flush();
  input.value = 'theqq'; // goes on typing; the answer for this one has not come
  input.dispatchEvent({ type: 'input' });
  env.fireTimers(150);
  env.key('scraps-search-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.deepEqual(opened, [], 'nothing is opened from the answer to "the"');
  answers.get('theqq')(found('2026-09-18.md'));
  await env.flush();
  env.key('scraps-search-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.deepEqual(opened, ['C:\\scraps\\2026-09-18.md'], 'once the answer for the query on screen is there, Enter opens its first line');
});

check('C7-10: closing the command bar while the AI writes a command drops it: the bar opens usable again, the late command is ignored', async () => {
  const generated = [];
  const env = await setup({ note: 'list the files\n', backend: { generateCliCommandAsync: (reqId) => { generated.push(reqId); } } });
  env.key(env.editor, ctrl('e'));
  env.key('cli-filter-input', { key: 'Tab' }); // the AI mode
  env.el('cli-filter-input').value = 'list the files';
  env.key('cli-filter-input', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(generated.length, 1, 'the command is being written');
  assert.equal(env.el('cli-filter-input').disabled, true, 'the input waits');
  env.key('cli-filter-input', ESC);
  assert.ok(env.hidden('cli-filter-bar'), 'Esc closed the bar');
  env.key(env.editor, ctrl('e'));
  assert.ok(!env.hidden('cli-filter-bar'), 'opened again');
  assert.equal(env.el('cli-filter-input').disabled, false, 'the input can be used');
  assert.ok(!/cli-spinner/.test(env.el('cli-filter-badge').innerHTML), 'the badge does not say Thinking');
  env.el('cli-filter-input').value = 'something else';
  env.window.__onCliCommandGenerated(generated[0], 'ls -la', '', { isSafe: true });
  await env.flush();
  assert.equal(env.el('cli-filter-input').value, 'something else', 'the late command is not put into the bar');
});

check('C7-12: a result whose waiting text is gone lands on lines of its own, with one blank line before it', async () => {
  const env = await setup({ note: 'End.' });
  select(env, 'End.');
  const call = await send(env, 'ask', 'continue');
  env.undo(); // Ctrl+Z took the waiting text out
  assert.equal(env.editor.value, 'End.');
  await answer(env, call, 'ANSWER');
  assert.equal(noteText(env), 'End.\n\nANSWER\n', 'not after three or four blank lines');

  const nl = await setup({ note: 'End.\n' });
  select(nl, 'End.');
  const call2 = await send(nl, 'ask', 'continue');
  nl.undo();
  await answer(nl, call2, 'ANSWER');
  assert.equal(noteText(nl), 'End.\n\nANSWER\n', 'the note\'s own last line break counts');

  // what a task writes (a result block that opens with a line break) and plain text, with the waiting text missing
  const block = await setup({ note: 'End.' });
  block.bridge.replaceAnchor(block.tab.id, '[[GONE]]', '\n<!-- md-memo:res -->\nbody\n<!-- /md-memo:res -->');
  assert.equal(noteText(block), 'End.\n\n<!-- md-memo:res -->\nbody\n<!-- /md-memo:res -->\n');
  const plainText = await setup({ note: 'End.' });
  plainText.bridge.replaceAnchor(plainText.tab.id, '[[GONE]]', 'X');
  assert.equal(noteText(plainText), 'End.\n\nX\n', 'a result with no line breaks of its own gets them as before');
  const empty = await setup({ note: '' });
  empty.bridge.replaceAnchor(empty.tab.id, '[[GONE]]', 'X');
  assert.equal(noteText(empty), 'X\n', 'in an empty note it does not start with blank lines');
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
