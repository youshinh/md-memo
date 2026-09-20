import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

console.log('=== Mobile Drop (QR sync) frontend tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8').replace(/\r\n/g, '\n');

// ---- wiring that lives outside the extracted section -------------------------------------
assert(/mobileDrop:\s*'Ctrl\+Shift\+U'/.test(appJs), 'Windows default shortcut Ctrl+Shift+U must be registered');
assert(/mobileDrop:\s*'Cmd\+Shift\+U'/.test(appJs), 'macOS default shortcut Cmd+Shift+U must be registered');
assert(/matchShortcut\(e, config\.shortcuts && config\.shortcuts\.mobileDrop\)/.test(appJs), 'the global key handler must dispatch the mobileDrop shortcut');
assert(/\{ key: 'mobileDrop', labelKey: 'shortcutActionMobileDrop' \}/.test(appJs), 'the shortcut must be listed in the settings shortcut editor');
assert(/id: 'cmd_mobile_drop'/.test(appJs), 'the command palette must offer Mobile Drop');
assert(/if \(isMobileDropModalOpen\(\)\) \{\s*cancelMobileDrop\(\);\s*return;\s*\}/.test(appJs), 'Esc must cancel an open Mobile Drop modal (and stop the server)');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;
for (const lang of ['en', 'ja']) {
  for (const key of [
    'shortcutActionMobileDrop', 'cmdPaletteMobileDrop', 'cmdPaletteMobileDropDesc', 'mobileDropTitle', 'mobileDropStarting',
    'mobileDropHint', 'mobileDropExpiresIn', 'mobileDropUnavailable', 'mobileDropReceived', 'mobileDropTimedOut',
    'mobileDropGenericError', 'mobileDropNoActiveTab', 'mobileDropTunnelSwitch', 'mobileDropTunnelConnecting',
    'mobileDropTunnelHint', 'mobileDropTunnelTitle', 'mobileDropCloudflaredMissing', 'mobileDropCopy', 'mobileDropCopied',
    'mobileDropCopyFailed', 'mobileDropToolbarTitle'
  ]) {
    assert(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `I18N.${lang}.${key} must exist`);
  }
  // Consent: the external path must say that the data goes through Cloudflare.
  assert(/Cloudflare/.test(I18N[lang].mobileDropTunnelSwitch), `${lang}: the tunnel button must name Cloudflare`);
  assert(/Cloudflare/.test(I18N[lang].mobileDropTunnelHint), `${lang}: the connected hint must say the data passes through Cloudflare`);
  assert(/Cloudflare/.test(I18N[lang].mobileDropTunnelTitle), `${lang}: the tooltip must say the data passes through Cloudflare`);
}
for (const id of ['mobile-drop-modal', 'mobile-drop-qr', 'mobile-drop-url', 'mobile-drop-countdown', 'mobile-drop-hint',
  'mobile-drop-error', 'btn-mobile-drop-cancel', 'modal-mobile-drop-close', 'btn-mobile-drop-tunnel', 'mobile-drop-tunnel-status',
  'mobile-drop-install', 'mobile-drop-install-cmd', 'btn-mobile-drop-install-copy', 'mobile-drop-install-copy-label']) {
  assert(indexHtml.includes(`id="${id}"`), `index.html must contain #${id}`);
}
assert(/id="btn-mobile-drop-tunnel"[^>]*data-i18n-title="mobileDropTunnelTitle"/.test(indexHtml), 'the tunnel button must carry its explanatory tooltip');

// ---- no emoji: every icon in this app is a line SVG ---------------------------------------
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const lang of ['en', 'ja']) {
  for (const [key, value] of Object.entries(I18N[lang])) {
    if (/^(mobileDrop|cmdPaletteMobileDrop|shortcutActionMobileDrop)/.test(key)) {
      assert(!EMOJI.test(value), `I18N.${lang}.${key} must not contain an emoji: ${value}`);
    }
  }
}
const modalStart = indexHtml.indexOf('<div id="mobile-drop-modal"');
const modalEnd = indexHtml.indexOf('<!-- Quick Pick', modalStart);
assert(modalStart > 0 && modalEnd > modalStart, 'Mobile Drop modal markup not found');
const modalHtml = indexHtml.slice(modalStart, modalEnd).replace(/\u2715/g, ''); // the shared close-button glyph, used by every modal
assert(!EMOJI.test(modalHtml), 'the Mobile Drop modal must not contain emoji');
assert(/<svg class="mobile-drop-icon"/.test(modalHtml), 'the tunnel button carries a line SVG icon');
assert(/id: 'cmd_mobile_drop',[\s\S]{0,240}iconSvg: '<svg class="menu-icon"/.test(appJs), 'the palette entry has a line icon like its neighbours');
console.log('PASS: no emoji in the Mobile Drop UI (line SVG icons only).');

// ---- the Mobile Drop section itself, run against mocks -----------------------------------
const start = appJs.indexOf('  // --- Mobile Drop QR Sync');
const end = appJs.indexOf('  // --- Toolbar / right-click menu layout');
assert(start > 0 && end > start, 'Mobile Drop section not found in app.js');
const sectionSrc = appJs.slice(start, end);

function mockEl() {
  const classes = new Set();
  return {
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle(c, force) { if (force) classes.add(c); else classes.delete(c); }
    },
    textContent: '', src: '', disabled: false, offsetWidth: 0, onclick: null,
    addEventListener() {}
  };
}

const factory = new Function(
  'els', 'getActiveEditor', 'getActiveTab', 'showMessage', 't', 'insertTextWithUndo', 'onEditorInput', 'config', 'window',
  'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'document', 'navigator', 'editorEl', 'editorSecondary',
  `
  const { mobileDropModal, mobileDropLoading, mobileDropContent, mobileDropErrorEl, mobileDropQrImg, mobileDropUrlEl,
    mobileDropCountdownEl, mobileDropHintEl, mobileDropSharedPreviewEl, modalMobileDropClose, btnMobileDropCancel, btnMobileDropTunnel,
    mobileDropTunnelStatusEl, mobileDropInstallEl, mobileDropInstallCmdEl, btnMobileDropInstallCopy,
    mobileDropInstallCopyLabelEl, btnMobileDrop } = els;
  ${sectionSrc}
  return { startMobileDrop, cancelMobileDrop, requestMobileDropTunnel, isMobileDropModalOpen };
  `
);

function setup({ backend = {}, withTab = true } = {}) {
  const els = Object.fromEntries([
    'mobileDropModal', 'mobileDropLoading', 'mobileDropContent', 'mobileDropErrorEl', 'mobileDropQrImg', 'mobileDropUrlEl',
    'mobileDropCountdownEl', 'mobileDropHintEl', 'mobileDropSharedPreviewEl', 'modalMobileDropClose', 'btnMobileDropCancel', 'btnMobileDropTunnel',
    'mobileDropTunnelStatusEl', 'mobileDropInstallEl', 'mobileDropInstallCmdEl', 'btnMobileDropInstallCopy',
    'mobileDropInstallCopyLabelEl', 'btnMobileDrop'
  ].map((k) => [k, mockEl()]));
  els.mobileDropModal.classList.add('hidden');
  els.mobileDropContent.classList.add('hidden');
  els.mobileDropErrorEl.classList.add('hidden');
  els.mobileDropTunnelStatusEl.classList.add('hidden');
  els.mobileDropInstallEl.classList.add('hidden');
  els.mobileDropSharedPreviewEl.classList.add('hidden');

  const listeners = {};
  const editor = {
    value: 'existing note', selection: null, scrollTop: 0, scrollHeight: 999, focused: 0,
    selectionStart: 0, selectionEnd: 0,
    setSelectionRange(a, b) { this.selection = [a, b]; this.selectionStart = a; this.selectionEnd = b; },
    focus() { this.focused++; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    }
  };
  const tab = { id: 'tab-1' };
  const calls = { messages: [], inserted: [], edits: [], intervals: [], timeouts: [], cleared: 0 };
  // Clipboard environment: the async API can be made to fail, then the legacy execCommand path,
  // and finally the command is selected for a manual Ctrl+C.
  const clip = { written: [], asyncOk: true, legacyOk: true, legacyCopies: 0, selected: false, focusRestored: 0 };
  const scratchEls = [];
  const document = {
    activeElement: { focus() { clip.focusRestored++; } },
    body: { appendChild: (el) => scratchEls.push(el), removeChild: (el) => scratchEls.splice(scratchEls.indexOf(el), 1) },
    createElement: () => ({ style: {}, value: '', setAttribute() {}, select() {} }),
    execCommand: (cmd) => { if (cmd === 'copy') { clip.legacyCopies++; return clip.legacyOk; } return false; },
    createRange: () => ({ selectNodeContents() { clip.selected = true; } })
  };
  const navigator = {
    clipboard: { writeText: async (text) => { if (!clip.asyncOk) throw new Error('denied'); clip.written.push(text); } }
  };
  const win = { backend, getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  const config = { vision: { baseUrl: 'https://v.example', apiKey: 'k' }, voice: {} };
  const api = factory(
    els, () => (withTab ? editor : null), () => (withTab ? tab : null),
    (msg, ms) => calls.messages.push([msg, ms]), (key) => key,
    (text, ed) => { calls.inserted.push([text, ed]); editor.value += text; },
    (...args) => calls.edits.push(args), config, win,
    (fn, ms) => { calls.timeouts.push({ fn, ms }); return calls.timeouts.length; },
    (fn, ms) => { calls.intervals.push({ fn, ms }); return calls.intervals.length; },
    () => { calls.cleared++; },
    () => { calls.cleared++; }, document, navigator, editor, null
  );
  return { api, els, editor, tab, calls, win, clip, scratchEls, listeners };
}

const info = { url: 'http://192.168.1.5:8765/?token=abc', qrDataUri: 'data:image/png;base64,AAA', idleTimeoutSeconds: 60 };
const flush = (calls) => { const t = calls.timeouts.splice(0); t.forEach(({ fn }) => fn()); };

// 1. Starting shows the QR modal, passes the vision config, and starts the countdown.
{
  let visionArg = null;
  const s = setup({ backend: { startMobileDrop: async (cfg) => { visionArg = cfg; return info; }, cancelMobileDrop() {}, requestMobileDropTunnel() {} } });
  await s.api.startMobileDrop();
  assert(s.api.isMobileDropModalOpen(), 'modal must be open');
  assert.deepStrictEqual(JSON.parse(visionArg), { baseUrl: 'https://v.example', apiKey: 'k' }, 'the vision config goes to the backend for OCR');
  assert(!s.els.mobileDropContent.classList.contains('hidden') && s.els.mobileDropLoading.classList.contains('hidden'), 'content replaces the spinner');
  assert.strictEqual(s.els.mobileDropQrImg.src, info.qrDataUri);
  assert.strictEqual(s.els.mobileDropUrlEl.textContent, info.url, 'the plain URL is shown as a fallback for the QR');
  assert.strictEqual(s.els.mobileDropCountdownEl.textContent, '60');
  assert.strictEqual(s.calls.intervals.length, 1, 'countdown ticks once a second');
  assert(!s.els.btnMobileDropTunnel.classList.contains('hidden'), 'the tunnel button is offered when the backend supports it');

  // a second press while open must not start another session
  await s.api.startMobileDrop();
  assert.strictEqual(s.calls.intervals.length, 1, 'starting again while open is a no-op');
  console.log('PASS: starting shows the QR, the URL fallback and the countdown.');
}

// 2. A backend without tunnel support hides the button; startup failures are shown.
{
  const s = setup({ backend: { startMobileDrop: async () => info } });
  await s.api.startMobileDrop();
  assert(s.els.btnMobileDropTunnel.classList.contains('hidden'), 'no tunnel button without backend support');

  const failing = setup({ backend: { startMobileDrop: async () => { throw new Error('no LAN-reachable network interface'); } } });
  await failing.api.startMobileDrop();
  assert(!failing.els.mobileDropErrorEl.classList.contains('hidden'), 'the error view must be visible');
  assert(/no LAN-reachable/.test(failing.els.mobileDropErrorEl.textContent));
  assert(failing.els.mobileDropContent.classList.contains('hidden'));

  const unavailable = setup({ backend: {} });
  await unavailable.api.startMobileDrop();
  assert.strictEqual(unavailable.els.mobileDropErrorEl.textContent, 'mobileDropUnavailable');
  console.log('PASS: missing tunnel support and startup failures are handled.');
}

// 3. Cancelling stops the server, but only when the modal was open.
{
  let cancels = 0;
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop: () => { cancels++; } } });
  await s.api.startMobileDrop();
  s.api.cancelMobileDrop();
  assert.strictEqual(cancels, 1, 'closing the modal must stop the server');
  assert(!s.api.isMobileDropModalOpen());
  s.api.cancelMobileDrop();
  assert.strictEqual(cancels, 1, 'cancelling a closed modal is a no-op');
  console.log('PASS: cancel stops the server exactly once.');
}

// 4. A received submission is appended to the END of the active note through the normal edit path.
{
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop() {} } });
  await s.api.startMobileDrop();
  s.win.__onMobileDropReceived({ content: '\n\n## Mobile Drop\n\nhello\n' });

  assert(!s.api.isMobileDropModalOpen(), 'the modal closes on receipt');
  assert.deepStrictEqual(s.editor.selection, [13, 13], 'the caret goes to the end of the note first');
  assert.strictEqual(s.calls.inserted.length, 1);
  assert.strictEqual(s.calls.inserted[0][0], '\n\n## Mobile Drop\n\nhello\n');
  assert.strictEqual(s.calls.edits.length, 1, 'the normal input bookkeeping (dirty flag, autosave, ...) runs');
  assert.strictEqual(s.calls.edits[0][0], s.editor);
  assert.strictEqual(s.calls.edits[0][1], s.tab);
  assert.strictEqual(s.calls.edits[0][2], true, 'no ghost-text autocomplete after a paste');
  assert.strictEqual(s.editor.scrollTop, 999, 'scrolled to the new content');
  assert.strictEqual(s.calls.messages.at(-1)[0], 'mobileDropReceived');

  const noTab = setup({ withTab: false });
  noTab.win.__onMobileDropReceived({ content: 'x' });
  assert.strictEqual(noTab.calls.inserted.length, 0, 'nothing is inserted without an active note');
  assert(noTab.calls.messages.some(([m]) => m === 'mobileDropNoActiveTab'), 'the user is told to open a note first');
  console.log('PASS: content is appended to the end of the active note via the normal edit path.');
}

// 5. Timeout only reports when the modal is showing; errors reopen the error view.
{
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop() {} } });
  s.win.__onMobileDropTimeout();
  assert.strictEqual(s.calls.messages.length, 0, 'a late timeout after the modal was closed says nothing');

  await s.api.startMobileDrop();
  s.win.__onMobileDropTimeout();
  assert(!s.api.isMobileDropModalOpen());
  assert.strictEqual(s.calls.messages.at(-1)[0], 'mobileDropTimedOut');

  s.win.__onMobileDropError({ message: 'Gemini API Keyが設定されていません' });
  assert(!s.els.mobileDropErrorEl.classList.contains('hidden'));
  assert.strictEqual(s.els.mobileDropErrorEl.textContent, 'Gemini API Keyが設定されていません');
  console.log('PASS: timeout and error callbacks.');
}

// 6. The Cloudflare tunnel switch: connecting -> ready (QR swap + longer countdown) or error (retry).
{
  let tunnelRequests = 0;
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop() {}, requestMobileDropTunnel: () => { tunnelRequests++; } } });
  await s.api.startMobileDrop();

  s.els.btnMobileDropTunnel.onclick();
  assert.strictEqual(tunnelRequests, 1);
  assert(s.els.btnMobileDropTunnel.disabled, 'the button is disabled while connecting');
  assert.strictEqual(s.els.mobileDropTunnelStatusEl.textContent, 'mobileDropTunnelConnecting');
  s.els.btnMobileDropTunnel.onclick();
  assert.strictEqual(tunnelRequests, 1, 'a second click while connecting is ignored');

  s.win.__onMobileDropTunnelError({ message: 'cloudflaredが見つかりません。' });
  assert(!s.els.btnMobileDropTunnel.disabled, 'after an error the user can try again');
  assert(s.els.mobileDropTunnelStatusEl.classList.contains('error'));
  assert.strictEqual(s.els.mobileDropTunnelStatusEl.textContent, 'cloudflaredが見つかりません。');
  s.els.btnMobileDropTunnel.onclick();
  assert.strictEqual(tunnelRequests, 2, 'retrying asks the backend again');

  const tunnelInfo = { url: 'https://abc.trycloudflare.com/?token=abc', qrDataUri: 'data:image/png;base64,BBB', idleTimeoutSeconds: 90 };
  s.win.__onMobileDropTunnelReady(tunnelInfo);
  assert(s.els.btnMobileDropTunnel.classList.contains('hidden'), 'the switch is done: the button goes away');
  assert.strictEqual(s.els.mobileDropHintEl.textContent, 'mobileDropTunnelHint', 'the hint now says the data goes through Cloudflare');
  assert(s.els.mobileDropQrImg.classList.contains('swapping'), 'the QR fades out first');
  flush(s.calls);
  assert.strictEqual(s.els.mobileDropQrImg.src, tunnelInfo.qrDataUri, 'then the tunnel QR replaces it');
  assert.strictEqual(s.els.mobileDropUrlEl.textContent, tunnelInfo.url);
  assert.strictEqual(s.els.mobileDropCountdownEl.textContent, '90', 'the countdown restarts from the tunnel timeout');
  assert(!s.els.mobileDropQrImg.classList.contains('swapping'));

  s.api.cancelMobileDrop();
  assert(!s.els.btnMobileDropTunnel.classList.contains('hidden') && !s.els.btnMobileDropTunnel.disabled, 'closing resets the tunnel UI for the next session');
  assert.strictEqual(s.els.mobileDropHintEl.textContent, 'mobileDropHint');
  console.log('PASS: tunnel switch (connecting, error + retry, ready, reset).');
}

// 7. Late tunnel callbacks after the modal was closed are ignored, and never restart the countdown.
{
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop() {}, requestMobileDropTunnel() {} } });
  await s.api.startMobileDrop();
  const intervalsBefore = s.calls.intervals.length;

  s.win.__onMobileDropTunnelReady({ url: 'https://x.trycloudflare.com/?token=t', qrDataUri: 'data:,', idleTimeoutSeconds: 90 });
  s.api.cancelMobileDrop(); // closed during the QR fade
  flush(s.calls);
  assert.strictEqual(s.calls.intervals.length, intervalsBefore, 'a closed modal must not get a running countdown');

  const hintBefore = s.els.mobileDropHintEl.textContent;
  s.win.__onMobileDropTunnelReady({ url: 'https://y.trycloudflare.com', idleTimeoutSeconds: 90 });
  s.win.__onMobileDropTunnelError({ message: 'late' });
  assert.strictEqual(s.els.mobileDropHintEl.textContent, hintBefore, 'late tunnel callbacks change nothing');
  assert(s.els.mobileDropTunnelStatusEl.classList.contains('hidden'));
  console.log('PASS: late tunnel callbacks are ignored.');
}

// 7b. The toolbar button starts the same flow as the shortcut.
{
  let started = 0;
  const s = setup({ backend: { startMobileDrop: async () => { started++; return info; }, cancelMobileDrop() {} } });
  assert.strictEqual(typeof s.els.btnMobileDrop.onclick, 'function', 'the toolbar button is wired');
  s.els.btnMobileDrop.onclick();
  await Promise.resolve();
  assert.strictEqual(started, 1, 'clicking the toolbar button starts Mobile Drop');
  assert(s.api.isMobileDropModalOpen());
  console.log('PASS: the toolbar button opens Mobile Drop.');
}

// 8. cloudflared missing: say so in the UI language, offer the install command with a Copy button,
//    and clear it again when the user retries or closes the modal.
{
  const command = 'winget install --id Cloudflare.cloudflared -e';
  const s = setup({ backend: { startMobileDrop: async () => info, cancelMobileDrop() {}, requestMobileDropTunnel() {} } });
  await s.api.startMobileDrop();
  assert(s.els.mobileDropInstallEl.classList.contains('hidden'), 'no install box until it is needed');

  s.els.btnMobileDropTunnel.onclick();
  s.win.__onMobileDropTunnelError({ message: 'cloudflaredが見つかりません。', code: 'cloudflared_missing', installCommand: command });
  assert.strictEqual(s.els.mobileDropTunnelStatusEl.textContent, 'mobileDropCloudflaredMissing', 'worded in the UI language, not the backend text');
  assert(!s.els.mobileDropInstallEl.classList.contains('hidden'), 'the install command is offered');
  assert.strictEqual(s.els.mobileDropInstallCmdEl.textContent, command);
  assert(!s.els.btnMobileDropTunnel.disabled, 'the button can be pressed again after installing');

  // 1) the async clipboard API
  await s.els.btnMobileDropInstallCopy.onclick();
  assert.deepStrictEqual(s.clip.written, [command]);
  assert.strictEqual(s.els.mobileDropInstallCopyLabelEl.textContent, 'mobileDropCopied');
  flush(s.calls);
  assert.strictEqual(s.els.mobileDropInstallCopyLabelEl.textContent, 'mobileDropCopy', 'the label goes back after a moment');

  // 2) the async API refuses (webview, no user gesture): the legacy execCommand path takes over
  s.clip.asyncOk = false;
  await s.els.btnMobileDropInstallCopy.onclick();
  assert.strictEqual(s.clip.legacyCopies, 1);
  assert.strictEqual(s.els.mobileDropInstallCopyLabelEl.textContent, 'mobileDropCopied');
  assert.strictEqual(s.scratchEls.length, 0, 'the scratch textarea is removed again');
  assert.strictEqual(s.clip.focusRestored, 1, 'focus goes back to where it was');
  assert(!s.clip.selected);

  // 3) nothing works: the command is selected so Ctrl+C can be used
  s.clip.legacyOk = false;
  await s.els.btnMobileDropInstallCopy.onclick();
  assert(s.clip.selected, 'falls back to selecting the command');
  assert.strictEqual(s.els.mobileDropInstallCopyLabelEl.textContent, 'mobileDropCopyFailed');

  // Retrying hides the box; other failures never show it; a code without a command is not enough
  s.els.btnMobileDropTunnel.onclick();
  assert(s.els.mobileDropInstallEl.classList.contains('hidden'), 'retrying hides the install box');
  s.win.__onMobileDropTunnelError({ message: 'timed out' });
  assert(s.els.mobileDropInstallEl.classList.contains('hidden'), 'other failures do not offer an install command');
  assert.strictEqual(s.els.mobileDropTunnelStatusEl.textContent, 'timed out');
  s.win.__onMobileDropTunnelError({ message: 'x', code: 'cloudflared_missing' });
  assert(s.els.mobileDropInstallEl.classList.contains('hidden'));

  // Closing the modal resets it for the next session
  s.win.__onMobileDropTunnelError({ code: 'cloudflared_missing', installCommand: 'brew install cloudflared' });
  assert(!s.els.mobileDropInstallEl.classList.contains('hidden'));
  s.api.cancelMobileDrop();
  assert(s.els.mobileDropInstallEl.classList.contains('hidden'));
  assert.strictEqual(s.els.mobileDropInstallCmdEl.textContent, '');
  console.log('PASS: a missing cloudflared offers a copyable install command (async clipboard, legacy copy, manual select).');
}

console.log('\nAll Mobile Drop frontend tests PASSED!');
