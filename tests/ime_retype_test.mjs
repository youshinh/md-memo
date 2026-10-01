// IME retype (Windows, opt-in): with the setting on, Tab on the IME Guardian's "[Tab: いろ]" suggestion removes the romaji and
// has the OS input method type the same keys again, so the word arrives unconfirmed (kanji candidates on Space) instead of as
// committed hiragana. It cannot be exercised without a real IME, so this test pins what can be: the fall-back rule (the word
// is never lost), and that the page, the bind and the setting are wired the way the flow needs. The flow itself was run in a
// browser against a mock backend (IME reacts / does not react / keys not sent / letters landed as text / setting off).
import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

console.log('=== IME retype tests ===');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(read('frontend/js/ime_guardian.js'), ctx);
assert.strictEqual(typeof ctx.planImeRetypeFallback, 'function', 'ime_guardian.js exports planImeRetypeFallback');
// (copied out of the vm context: objects made there have another prototype, which deepStrictEqual rejects)
const plan = (...a) => { const r = ctx.planImeRetypeFallback(...a); return r && { start: r.start, end: r.end }; };

// 1. The fall-back never loses the word and never touches text the user typed afterwards.
{
  // the IME did not take the keys: the letters are in the text where the romaji was
  assert.deepStrictEqual(plan('abc iro', 4, 'iro', 7), { start: 4, end: 7 }, 'letters that landed as plain text are replaced by the hiragana');
  // the keys never arrived: nothing is at that place and the caret is where the romaji was
  assert.deepStrictEqual(plan('abc ', 4, 'iro', 4), { start: 4, end: 4 }, 'nothing arrived: the hiragana is inserted there');
  assert.deepStrictEqual(plan('', 0, 'iro', 0), { start: 0, end: 0 });
  // the user went on typing, or moved the caret: leave their text alone
  assert.strictEqual(plan('abc irox', 4, 'iro', 8), null, 'text typed after the letters: do not touch it');
  assert.strictEqual(plan('abc xyz', 4, 'iro', 7), null, 'something else is there: do not touch it');
  assert.strictEqual(plan('abc iro', 4, 'iro', 2), null, 'the caret moved away');
  console.log('PASS: the fall-back replaces the letters or inserts the hiragana, and leaves anything else alone.');
}

// 2. The page: opt-in, only where the bind exists, and a composition ends the wait.
{
  const app = read('frontend/js/app.js');
  assert.ok(/imeGuardianRetype: false/.test(app), 'off by default');
  assert.ok(/window\.backend\.retypeWithImeAsync &&\s*platformCapabilities\.nativeImeSwitch !== false/.test(app), 'offered only where the native bind exists');
  assert.ok(/config\.general\.imeGuardianRetype/.test(app), 'the setting is read from config.general');
  assert.ok(/if \(imeRetypeAvailable\(\) && \/\^\[a-zA-Z\]\{1,32\}\$\/\.test\(word \|\| ''\)\)/.test(app), 'only a plain letter word is retyped; anything else is committed as before');
  assert.ok(/startImeRetype\(startPos, endPos, word\.toLowerCase\(\), hiragana\)/.test(app), 'the lowercase word is retyped');
  const compositionStart = app.slice(app.indexOf("editorEl.addEventListener('compositionstart'"));
  assert.ok(/pendingImeRetype\)[^]*clearTimeout\(pendingImeRetype\.timer\)/.test(compositionStart.slice(0, 400)), 'a composition starting ends the wait');
  assert.ok(/window\.__onImeRetypeResult = function \(reqID, errMsg\)/.test(app), 'the Go side can report that the keys were not sent');
  assert.ok(/IME_RETYPE_WAIT_MS = 900/.test(app), 'the wait for a composition is bounded');
  console.log('PASS: opt-in, bind-gated, letters only, and a composition (or a failure) ends the wait.');
}

// 3. The bind: Windows only on the page side, and the setting and its strings exist.
{
  const bind = read('bind_common.go');
  assert.ok(/backend_retypeWithImeAsync", app\.RetypeWithImeAsync/.test(bind), 'the bound method is registered');
  assert.ok(/retypeWithImeAsync: \(reqID, romaji\)/.test(read('window_windows.go')), 'the Windows page backend offers it');
  assert.ok(!/retypeWithIme/.test(read('window_darwin.go')), 'macOS has no such backend function, so the page never offers the setting there');
  const win = read('ime_retype_windows.go');
  assert.ok(/ownsForeground\(\)/.test(win) && win.indexOf('ownsForeground()', win.indexOf('func platformImeRetype')) < win.indexOf('imeRetypeKey(imeRetypeVkImeOn)'),
    'keys go only to our own window: the foreground is checked before anything is sent');
  const html = read('frontend/index.html');
  assert.ok(/<div id="ime-retype-group" class="form-group inline-group hidden"/.test(html) && /<input type="checkbox" id="cfg-ime-retype">/.test(html), 'the switch is in the dialog, hidden until the bind is known');
  const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();
  for (const k of ['imeRetypeLabel', 'imeRetypeHint']) assert.ok(I18N.en[k] && I18N.ja[k], k + ' exists in both languages');
  console.log('PASS: bound on Windows only, foreground-checked, with the switch and its strings in both languages.');
}

// 4. The other direction: English typed with the IME on. The keys of one composition decide, never the kana.
{
  const key = (code, extra) => Object.assign({ code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, capsLock: false }, extra || {});
  const run = (keys, tail) => {
    const log = ctx.newImeKeyLog();
    for (const c of keys) ctx.imeKeyLogPush(log, key('Key' + c.toUpperCase(), { shiftKey: c !== c.toLowerCase() }));
    for (const t of tail || ['Enter']) ctx.imeKeyLogPush(log, key(t));
    return { text: log.text, valid: log.valid };
  };
  assert.deepStrictEqual(run('hello'), { text: 'hello', valid: true }, 'letters are logged; the committing Enter is not part of the word');
  assert.deepStrictEqual(run('World', ['Space', 'Enter']), { text: 'World', valid: true }, 'Shift keeps the capital; a trailing Space (a conversion that found nothing) is allowed');
  assert.strictEqual(run('hel', ['Space']).valid, true);
  {
    const log = ctx.newImeKeyLog();
    for (const c of 'hel') ctx.imeKeyLogPush(log, key('Key' + c.toUpperCase()));
    ctx.imeKeyLogPush(log, key('Space')); ctx.imeKeyLogPush(log, key('KeyL'));
    assert.strictEqual(log.valid, false, 'letters after a Space are not one word');
  }
  for (const bad of ['Backspace', 'Tab', 'ArrowLeft', 'Digit1', 'Minus', 'F7']) assert.strictEqual(run('hel', [bad]).valid, false, bad + ' means the user was editing or converting: drop the log');
  {
    const log = ctx.newImeKeyLog();
    ctx.imeKeyLogPush(log, key('KeyH', { ctrlKey: true }));
    assert.strictEqual(log.valid, false, 'a shortcut is not typing');
    ctx.resetImeKeyLog(log);
    assert.deepStrictEqual({ text: log.text, valid: log.valid, spaced: log.spaced }, { text: '', valid: true, spaced: false });
  }
  {
    const log = ctx.newImeKeyLog();
    ctx.imeKeyLogPush(log, key('KeyH', { capsLock: true }));
    ctx.imeKeyLogPush(log, key('KeyE', { capsLock: true, shiftKey: true }));
    assert.strictEqual(log.text, 'Hel'.slice(0, 1) + 'e', 'Caps Lock upper-cases, Shift with Caps Lock lower-cases');
  }

  const cand = ctx.englishRetypeCandidate;
  for (const [keys, kana] of [['hello', 'へっlお'], ['World', 'Wをrld'], ['thank', 'tはんk'], ['table', 'たblえ'], ['meeting', 'めえちんg'], ['online', 'おんlいね'], ['github', 'ぎtふb'], ['function', 'ふんcちおん']]) {
    assert.strictEqual(cand(keys, kana), keys, keys + ' typed with the IME on is offered back');
  }
  for (const [keys, kana] of [['nihongo', 'にほんご'], ['konnichiha', 'こんにちは'], ['arigatou', 'ありがとう'], ['shinkansen', 'しんかんせん'], ['gakkou', 'がっこう'], ['kyouto', 'きょうと']]) {
    assert.strictEqual(cand(keys, kana), null, keys + ' is Japanese romaji: never offered as English');
  }
  assert.strictEqual(cand('hel', 'へl'), null, 'under four letters: too little to go on');
  assert.strictEqual(cand('hello', 'hello'), null, 'already English');
  assert.strictEqual(cand('hello', ''), null, 'nothing was committed (cancelled)');
  assert.strictEqual(cand('he11o', 'へ11お'), null, 'letters only');
  assert.strictEqual(cand('a'.repeat(40), 'あ'.repeat(40)), null, 'a bound on the length');
  console.log('PASS: the key log keeps one plain run of letters; English that cannot be romaji is offered, Japanese never is.');

  const app = read('frontend/js/app.js');
  assert.ok(/imeGuardianReverse: false/.test(app), 'off by default');
  assert.ok(/if \(e\.isComposing \|\| e\.keyCode === 229\) imeKeyLogPush\(log, e\);/.test(app), 'the keys are logged while the IME has the text (keyCode 229)');
  assert.ok(/offerEnglishRetype\(e && e\.data\)/.test(app), 'the offer is made when the composition ends');
  assert.ok(/if \(keepReverse\) return true;/.test(app), 'checkImeSuggestion keeps the offer alive: its caller clears the ghost whenever it returns false');
  assert.ok(/setIMEMode\(false\)/.test(app), 'accepting switches input to half-width');
  assert.ok(/VK_IME_OFF = 0x1A/.test(read('window_windows.go')), 'Windows really sends the IME-Off key (ImmSetOpenStatus cannot reach WebView2)');
  const html = read('frontend/index.html');
  assert.ok(/<div id="ime-reverse-group" class="form-group inline-group hidden"/.test(html) && /<input type="checkbox" id="cfg-ime-reverse">/.test(html), 'the switch is in the dialog');
  const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();
  for (const k of ['imeReverseLabel', 'imeReverseHint']) assert.ok(I18N.en[k] && I18N.ja[k], k + ' exists in both languages');
  console.log('PASS: wired off by default, kept alive until the caret or text changes, and switches to half-width on Tab.');
}

console.log('\nAll IME retype tests PASSED!');
