// a11y.js gives focus back when a dialog closes, one animation frame later. A dialog that is opened AGAIN before that frame (a key held
// down, a fast double press) has its focus where it put it: the late frame must not take it to the editor. (Found by the deep search
// dialog's smoke flow, which opens the same dialog twice in a row: 1 run in 6 lost the focus of Cancel to the editor.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const a11yCode = fs.readFileSync('frontend/js/a11y.js', 'utf8');

function page() {
  const classes = new Set(['hidden']);
  const inside = new Set();
  const backdrop = {
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c)
    },
    contains: (el) => inside.has(el),
    querySelector: () => null,
    firstElementChild: null
  };
  const body = { tag: 'body' };
  const editor = { id: 'editor', isConnected: true, focus() { doc.activeElement = editor; editor.focused++; }, focused: 0 };
  const cancel = { id: 'cancel', focus() { doc.activeElement = cancel; } };
  inside.add(cancel);
  const doc = {
    body,
    activeElement: body,
    documentElement: { lang: 'en', getAttribute: () => null, setAttribute() {} },
    querySelectorAll: (sel) => (sel === '.modal-backdrop' ? [backdrop] : []),
    getElementById: (id) => (id === 'editor' ? editor : null),
    addEventListener() {}
  };
  const observers = [];
  const frames = [];
  const ctx = {
    document: doc,
    I18N: {},
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }
  };
  vm.createContext(ctx);
  vm.runInContext(a11yCode, ctx); // the page file initialises itself when it loads
  assert.equal(observers.length, 1, 'one observer for the one dialog');
  const open = () => { backdrop.classList.remove('hidden'); observers[0].cb(); };
  const close = () => { backdrop.classList.add('hidden'); observers[0].cb(); };
  const runFrames = () => { while (frames.length) frames.shift()(); };
  return { doc, editor, cancel, body, open, close, runFrames };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

check('a dialog that closes and leaves focus on <body> gives it back to the editor, one frame later', () => {
  const p = page();
  p.open();
  p.close();
  assert.equal(p.editor.focused, 0, 'not at once: after the frame');
  p.runFrames();
  assert.equal(p.editor.focused, 1);
});

check('focus that is already on something else is left alone', () => {
  const p = page();
  const box = { id: 'search-box' };
  p.open();
  p.close();
  p.doc.activeElement = box; // the dialog handed focus to a field of the panel behind it
  p.runFrames();
  assert.equal(p.editor.focused, 0);
  assert.equal(p.doc.activeElement, box);
});

check('a dialog opened again before the frame keeps its own focus (the late frame is for the close that has been undone)', () => {
  const p = page();
  p.open();
  p.close();
  p.open();
  p.cancel.focus(); // what the dialog does when it appears
  p.runFrames();
  assert.equal(p.editor.focused, 0, 'the editor must not take the focus from the open dialog');
  assert.equal(p.doc.activeElement, p.cancel);
  // and the close that really ends it still gives the focus back
  p.close();
  p.doc.activeElement = p.body;
  p.runFrames();
  assert.equal(p.editor.focused, 1);
});

if (failed) {
  console.log(failed + ' test(s) failed');
  process.exit(1);
}
console.log('all passed');
