// body.zen-active dims the header and the status bar once the user starts typing. It used to be taken
// off by a fixed 2.8 s timer after the last keystroke, so every short pause (thinking, waiting for a
// suggestion) brought the chrome back and the next keystroke dimmed it again: dark, normal, dark, normal.
// It must now stay on for as long as a note editor is the focused element, and end when focus leaves them.
// The real section of app.js runs here, against a hand-made document.
import fs from 'fs';
import assert from 'assert';

console.log('=== Zen dimming (body.zen-active) tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const start = appJs.indexOf('  // --- Zen Mode (Distraction-Free Focus) ---\n');
const end = appJs.indexOf('  function toggleZenMode()');
assert(start > 0 && end > start, 'zen section not found in app.js');
const zenSrc = appJs.slice(start, end);

// The regression itself: an idle timer that lets go of the dimming mid-writing must not come back.
assert(!/\b2800\b/.test(zenSrc), 'no fixed 2.8 s idle timer that un-dims in the middle of writing');

function mockEditor(name) {
  const listeners = {};
  return {
    name,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn()); }
  };
}

function setup() {
  const classes = new Set();
  const editorEl = mockEditor('primary');
  const editorSecondary = mockEditor('secondary');
  const document = {
    activeElement: editorEl,
    body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } }
  };
  const timers = [];
  const factory = new Function('editorEl', 'editorSecondary', 'document', 'setTimeout',
    `${zenSrc}\n return { triggerZenModeActive };`);
  const api = factory(editorEl, editorSecondary, document, (fn) => { timers.push(fn); return timers.length; });
  return {
    api, classes, editorEl, editorSecondary, document, timers,
    runTimers() { while (timers.length) timers.shift()(); }
  };
}

// 1. Typing dims, and nothing time-based ever takes it off again.
{
  const s = setup();
  s.api.triggerZenModeActive();
  assert(s.classes.has('zen-active'), 'typing turns the dimming on');
  assert.strictEqual(s.timers.length, 0, 'no timer is armed to turn it off again');
  s.runTimers();
  s.api.triggerZenModeActive(); // more typing after a pause
  assert(s.classes.has('zen-active'), 'still on after a pause and more typing (no dark/normal/dark flicker)');
  console.log('PASS: dimming starts on typing and has no idle expiry.');
}

// 2. Focus leaving the editors ends it (a click on the header, a dialog ...).
{
  const s = setup();
  s.api.triggerZenModeActive();
  s.document.activeElement = { name: 'header button' };
  s.editorEl.fire('blur');
  assert(s.classes.has('zen-active'), 'blur alone does not decide: the check waits for the focus change to settle');
  s.runTimers();
  assert(!s.classes.has('zen-active'), 'focus went to something that is not a note editor: dimming ends');
  console.log('PASS: dimming ends when focus leaves the note editors.');
}

// 3. Moving between the two panes of a split view must not blink it off.
{
  const s = setup();
  s.api.triggerZenModeActive();
  s.document.activeElement = s.editorSecondary;
  s.editorEl.fire('blur');
  s.runTimers();
  assert(s.classes.has('zen-active'), 'focus went to the other pane: still dimmed');
  s.document.activeElement = s.editorEl;
  s.editorSecondary.fire('blur');
  s.runTimers();
  assert(s.classes.has('zen-active'), 'and back again: still dimmed');
  console.log('PASS: switching panes keeps the dimming.');
}

// 4. A blur with the editor still being the active element (the whole window lost focus) keeps it.
{
  const s = setup();
  s.api.triggerZenModeActive();
  s.editorEl.fire('blur'); // document.activeElement is still the editor
  s.runTimers();
  assert(s.classes.has('zen-active'), 'window blur leaves the note editor active: nothing to undo');
  console.log('PASS: a window blur does not end it.');
}

// 5. The permanent Zen Mode owns the header/status bar itself: the transient state is not layered on.
{
  const s = setup();
  s.classes.add('zen-mode');
  s.api.triggerZenModeActive();
  assert(!s.classes.has('zen-active'), 'zen-mode on: zen-active is not added');
  console.log('PASS: full Zen Mode is left alone.');
}

console.log('\nAll zen dimming tests PASSED!');
