// Pressing Save / Open more than once while a file dialog was still coming up opened one dialog per press.
//
// The dialogs are shown on the window's own thread. While one is being built or is open, that thread serves nothing
// else, so each further press waits in the host and opens another dialog the moment the previous one is closed. The
// page runs in its own process and is not held up, so it must drop the extra requests itself: one native dialog at a
// time, and a dropped request looks like "cancelled" (undefined) to the caller.
//
// (The Go side gives the dialogs the main window as owner, so real clicks cannot reach the window while one is open;
// this covers the time before the dialog exists, and every call path, whatever the window does.)
import fs from 'fs';
import assert from 'assert';

console.log('=== Native dialog single-flight tests ===');

const src = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');

// --- 1. The helper, extracted from app.js and run against stubs.
const start = src.indexOf('let nativeDialogBusy = false;');
assert(start !== -1, 'app.js must define nativeDialogBusy');
const fnStart = src.indexOf('async function withNativeDialog(', start);
assert(fnStart !== -1, 'app.js must define withNativeDialog');
// The function ends at the first line that is exactly "  }" after its start (its own closing brace).
const fnEnd = src.indexOf('\n  }\n', fnStart);
const code = src.slice(start, fnEnd + 4);

function makeHelper() {
  const messages = [];
  const factory = new Function('showMessage', 't', code + '\nreturn withNativeDialog;');
  return { withNativeDialog: factory((m) => messages.push(m), (k) => k), messages };
}

const deferred = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

// A second request while the first is open is dropped and the backend is called once.
{
  const { withNativeDialog, messages } = makeHelper();
  let calls = 0;
  const d = deferred();
  const first = withNativeDialog(() => { calls++; return d.p; });
  const second = await withNativeDialog(() => { calls++; return Promise.resolve('never'); });
  const third = await withNativeDialog(() => { calls++; return Promise.resolve('never'); });
  assert.strictEqual(second, undefined, 'a dropped request must look like a cancelled dialog');
  assert.strictEqual(third, undefined);
  assert.strictEqual(calls, 1, 'only the first request may reach the backend');
  assert.deepStrictEqual(messages, ['dialogAlreadyOpen', 'dialogAlreadyOpen'], 'the user is told why nothing happened');
  d.resolve({ path: 'C:/a.md' });
  assert.deepStrictEqual(await first, { path: 'C:/a.md' }, 'the first request gets its own result');
  console.log('PASS: extra requests during an open dialog are dropped as "cancelled" and never reach the backend.');
}

// After the dialog closes, the next request goes through.
{
  const { withNativeDialog } = makeHelper();
  assert.strictEqual(await withNativeDialog(async () => 'one'), 'one');
  assert.strictEqual(await withNativeDialog(async () => 'two'), 'two');
  console.log('PASS: the next request goes through once the dialog is closed.');
}

// A failing dialog does not lock the buttons for good.
{
  const { withNativeDialog } = makeHelper();
  await assert.rejects(withNativeDialog(async () => { throw new Error('dialog failed'); }), /dialog failed/);
  assert.strictEqual(await withNativeDialog(async () => 'after error'), 'after error', 'busy must be cleared after an error');
  console.log('PASS: an error from the backend clears the busy state.');
}

// --- 2. Every call that shows a native dialog goes through the helper.
{
  const calls = [...src.matchAll(/window\.backend\.(saveFileAs|exportPlainTextAs|openFolder|openFile)\(/g)];
  assert(calls.length >= 6, 'expected the save / export / open file / open folder call sites, found ' + calls.length);
  const unguarded = calls
    .filter((m) => !src.slice(Math.max(0, m.index - 'withNativeDialog(() => '.length), m.index).endsWith('withNativeDialog(() => '))
    .map((m) => src.slice(0, m.index).split('\n').length);
  assert.deepStrictEqual(unguarded, [], 'these lines open a native dialog without withNativeDialog: ' + unguarded.join(', '));
  console.log('PASS: all ' + calls.length + ' dialog call sites in app.js go through withNativeDialog.');
}

// --- 3. The message exists in both languages.
{
  const i18n = fs.readFileSync('frontend/js/i18n.js', 'utf8');
  assert.strictEqual((i18n.match(/^\s+dialogAlreadyOpen:/gm) || []).length, 2, 'dialogAlreadyOpen must be defined for en and ja');
  console.log('PASS: dialogAlreadyOpen is translated (en, ja).');
}

console.log('\nAll native dialog single-flight tests PASSED!');
