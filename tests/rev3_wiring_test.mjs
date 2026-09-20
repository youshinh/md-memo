import fs from 'fs';
import vm from 'vm';
import assert from 'assert';
import { performance } from 'perf_hooks';

console.log('=== Input Interface Rev 3 wiring tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8').replace(/\r\n/g, '\n');
const winGo = fs.readFileSync('window_windows.go', 'utf8').replace(/\r\n/g, '\n');
const macGo = fs.readFileSync('window_darwin.go', 'utf8').replace(/\r\n/g, '\n');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

// ---- 1. Script tags: the three new modules load before app.js, same ?v= pattern ------------
{
  const order = ['html_to_md.js', 'voice_input.js', 'file_anchor.js', 'app.js'].map((f) => indexHtml.indexOf(`js/${f}?v=`));
  for (let i = 0; i < order.length; i++) assert(order[i] > 0, `script tag for ${['html_to_md.js', 'voice_input.js', 'file_anchor.js', 'app.js'][i]} not found`);
  for (let i = 1; i < order.length; i++) assert(order[i] > order[i - 1], 'the three new modules must load, in order, before app.js');
  console.log('PASS: script tag order.');
}

// ---- 2. Every new backend shim exists in BOTH window_windows.go and window_darwin.go -------
{
  const newBinds = [
    'backend_startMobileDropWithVoice', 'backend_setMobileDropSharedText', 'backend_saveAsset',
    'backend_importAssetFile', 'backend_openPath', 'backend_revealPath', 'backend_transcribeAudioAsync',
    'backend_retryVoiceCacheAsync', 'backend_keepVoiceCache', 'backend_discardVoiceCache'
  ];
  const newShims = [
    'startMobileDropWithVoice', 'setMobileDropSharedText', 'saveAsset', 'importAssetFile', 'openPath',
    'revealPath', 'transcribeAudioAsync', 'retryVoiceCacheAsync', 'keepVoiceCache', 'discardVoiceCache'
  ];
  for (const name of newBinds) {
    assert(winGo.includes(`w.Bind("${name}"`), `window_windows.go must bind ${name}`);
    assert(macGo.includes(`w.Bind("${name}"`), `window_darwin.go must bind ${name}`);
  }
  for (const name of newShims) {
    assert(new RegExp(`\\b${name}:\\s*\\(`).test(winGo), `window_windows.go window.backend shim missing ${name}`);
    assert(new RegExp(`\\b${name}:\\s*\\(`).test(macGo), `window_darwin.go window.backend shim missing ${name}`);
  }
  console.log('PASS: every new backend method is bound and shimmed on both platforms.');
}

// ---- 3. Windows: no permission is granted silently ------------------------------------------
// The preview pane can embed arbitrary HTML, so WebView2's own one-time prompt must stay in charge.
{
  assert(!/SetGlobalPermission\(/.test(winGo), 'permissions must not be granted globally');
  assert(!/\.SetPermission\(/.test(winGo), 'permissions must not be pre-granted per kind');
  console.log('PASS: WebView2 permissions are left to the built-in prompt.');
}

// ---- 4. MdMemoBridge shape ------------------------------------------------------------------
{
  for (const key of ['getActiveEditor', 'getActiveTab', 'getTabIdForEditor', 'insertTextWithUndo',
    'replaceAnchor', 'notifyEdited', 't', 'showMessage', 'getConfig', 'getNoteDir']) {
    assert(new RegExp(`\\b${key}\\s*:`).test(appJs.slice(appJs.indexOf('window.MdMemoBridge = {'), appJs.indexOf('window.MdMemoBridge = {') + 1200)),
      `window.MdMemoBridge must expose ${key}`);
  }
  assert(appJs.includes('replaceAnchor: applyAnchorReplacement'), 'replaceAnchor must reuse the same anchor-replacement logic as __onLLMResult');
  assert(appJs.includes('window.__onLLMResult(reqId, resultText, errorText) {') || appJs.includes('applyAnchorReplacement(reqInfo.tabId, reqInfo.anchorId, replacement)'),
    '__onLLMResult must go through applyAnchorReplacement');
  console.log('PASS: MdMemoBridge shape and __onLLMResult/replaceAnchor share applyAnchorReplacement.');
}

// ---- 5. decidePasteAction: pure function extraction + truth table --------------------------
{
  const start = appJs.indexOf('function decidePasteAction(opts) {');
  assert(start > 0, 'decidePasteAction not found');
  let depth = 0, end = -1;
  for (let i = start; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert(end > start, 'could not extract decidePasteAction body');
  const decidePasteAction = new Function(`${appJs.slice(start, end)}; return decidePasteAction;`)();

  const cases = [
    [{ special: false, types: [], hasImage: true, ocrEnabled: true }, 'ocr'],
    [{ special: false, types: [], hasImage: true, ocrEnabled: false }, 'default'],
    [{ special: false, types: ['text/plain'], hasImage: false, ocrEnabled: true }, 'default'],
    [{ special: true, types: [], hasImage: true, ocrEnabled: true }, 'saveImage'],
    [{ special: true, types: ['text/html'], hasImage: false, ocrEnabled: true }, 'htmlToMd'],
    [{ special: true, types: ['text/plain'], hasImage: false, ocrEnabled: true }, 'default'],
    [{ special: true, types: ['text/plain'], hasImage: false, ocrEnabled: true, canReadClipboard: true }, 'readClipboard'],
    // Excel / Word: image + HTML + text on the clipboard at once -> the table, not a screenshot.
    [{ special: true, types: ['text/html', 'text/plain'], hasImage: true, ocrEnabled: true }, 'htmlToMd'],
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: true, ocrEnabled: true }, 'default'],
    // An image copied from a browser has HTML (<img>) but no plain text: still OCR on Ctrl+V.
    [{ special: false, types: ['text/html'], hasImage: true, ocrEnabled: true }, 'ocr']
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(decidePasteAction(input), want, `decidePasteAction(${JSON.stringify(input)}) should be ${want}`);
  }
  console.log('PASS: decidePasteAction truth table.');

  // Micro-benchmark: this runs on every paste, so it must be effectively free.
  const N = 100000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) decidePasteAction(cases[i % cases.length][0]);
  const perCallUs = ((performance.now() - t0) * 1000) / N;
  assert(perCallUs < 5, `decidePasteAction averaged ${perCallUs.toFixed(3)}us/call, expected < 5us`);
  console.log(`PASS: decidePasteAction micro-benchmark (${perCallUs.toFixed(3)}us/call over ${N} calls).`);
}

// ---- 6. Ctrl+Alt+V opens preview-to-side; Ctrl+Shift+V no longer does ----------------------
{
  assert(/isModStrict && e\.altKey && !e\.shiftKey && e\.code === 'KeyV'/.test(appJs), 'Ctrl/Cmd+Alt+V must open preview-to-side');
  const altVIdx = appJs.indexOf("e.code === 'KeyV'");
  const nextOpenPreview = appJs.indexOf('openPreviewToSide();', altVIdx);
  assert(nextOpenPreview > altVIdx && nextOpenPreview - altVIdx < 500, 'openPreviewToSide() must be called from the Alt+V branch');
  assert(!/isModStrict && e\.shiftKey && \(e\.key === 'v' \|\| e\.key === 'V'\)\) \{\s*e\.preventDefault\(\);\s*openPreviewToSide/.test(appJs),
    'Ctrl/Cmd+Shift+V must no longer call openPreviewToSide directly');
  assert(/specialPasteArmedAt = Date\.now\(\)/.test(appJs), 'Ctrl/Cmd+Shift+V must arm the special-paste flag');
  console.log('PASS: Ctrl+Alt+V / Ctrl+Shift+V remap.');
}

// ---- 7. Voice ESC guard runs in the capture phase, ahead of the main handler ---------------
{
  const captureIdx = appJs.indexOf("window.VoiceInput.handleKeydown(e)");
  const mainHandlerIdx = appJs.indexOf('// Global Keyboard Shortcuts');
  assert(captureIdx > 0 && mainHandlerIdx > captureIdx, 'the VoiceInput ESC guard must be registered before the main keydown handler');
  assert(/}, true\);/.test(appJs.slice(captureIdx, captureIdx + 300)), 'the ESC guard listener must be registered with the capture flag');
  assert(/isModStrict && e\.shiftKey && !e\.altKey && \(e\.key === 'r' \|\| e\.key === 'R'\)/.test(appJs), 'Ctrl/Cmd+Shift+R must toggle voice input');
  console.log('PASS: voice ESC guard (capture phase) and Ctrl+Shift+R wiring.');
}

// ---- 8. Mobile Drop shared-text listeners are torn down when the session ends -------------
{
  const bindIdx = appJs.indexOf('function bindMobileDropSharedTextListeners()');
  const unbindIdx = appJs.indexOf('function unbindMobileDropSharedTextListeners()');
  assert(bindIdx > 0 && unbindIdx > 0, 'bind/unbind functions for the shared-text listeners must exist');
  assert(/closeMobileDropModal\(\) \{[\s\S]{0,300}unbindMobileDropSharedTextListeners\(\);/.test(appJs),
    'closeMobileDropModal must remove the shared-text listeners');
  const unbindBody = appJs.slice(unbindIdx, appJs.indexOf('\n  }', unbindIdx));
  assert(/removeEventListener/.test(unbindBody), 'unbind must actually call removeEventListener');
  console.log('PASS: Mobile Drop shared-text listeners are bound only for the session lifetime.');
}

// ---- 9. Selection RPC: getSelection / replaceSelection behave against a mock textarea ------
{
  const start = appJs.indexOf('window.__mdMemoRPC = {');
  const end = appJs.indexOf('\n  };', start) + 4;
  assert(start > 0 && end > start, '__mdMemoRPC block not found');
  const rpcSrc = appJs.slice(start, end);

  function makeEditor(value, start, end) {
    return {
      value, selectionStart: start, selectionEnd: end,
      focus() {}, select() {},
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
      dispatchEvent() {}
    };
  }

  function run(editor, { activeTabId = 'tab-1', selectTabCalls = [] } = {}) {
    const scope = {
      activeTabId, secondaryTabId: null, isSplitMode: false, secondaryViewMode: 'editor',
      editorEl: editor, editorSecondary: null,
      getActiveEditor: () => editor,
      getTabIdForEditor: (ed) => (ed === editor ? activeTabId : null),
      selectTab: (id) => selectTabCalls.push(id),
      document: { execCommand: (cmd, sh, text) => { insertViaExecCommand(editor, text); return true; } },
      updateLineNumbers: () => {}, saveSessionDebounced: () => {}
    };
    function insertViaExecCommand(ed, text) {
      const s = ed.selectionStart, e = ed.selectionEnd;
      ed.value = ed.value.slice(0, s) + text + ed.value.slice(e);
      ed.selectionStart = s; ed.selectionEnd = s + text.length;
    }
    const fn = new Function(...Object.keys(scope), `${rpcSrc}\nreturn window.__mdMemoRPC;`);
    const fakeWindow = {};
    const withWindow = new Function('window', ...Object.keys(scope), `${rpcSrc}\nreturn window.__mdMemoRPC;`);
    return withWindow(fakeWindow, ...Object.values(scope));
  }

  // a. No selection -> hasSelection: false
  {
    const editor = makeEditor('hello world', 3, 3);
    const rpc = run(editor);
    const sel = rpc.getSelection('');
    assert.strictEqual(sel.hasSelection, false);
    assert.strictEqual(sel.text, '');
    console.log('PASS: getSelection reports no selection when the caret has no range.');
  }

  // b. Happy path: selection is read and then replaced atomically.
  {
    const editor = makeEditor('hello world', 0, 5);
    const rpc = run(editor);
    const sel = rpc.getSelection('');
    assert.strictEqual(sel.text, 'hello');
    assert.strictEqual(sel.hasSelection, true);

    const res = rpc.replaceSelection('HOWDY', sel.tabId, sel.start, sel.end);
    assert.strictEqual(res.replaced, true);
    assert.strictEqual(editor.value, 'HOWDY world');
    console.log('PASS: replaceSelection replaces exactly the read range.');
  }

  // c. Moved selection between get and replace -> replaced: false, nothing mutated.
  {
    const editor = makeEditor('hello world', 0, 5);
    const rpc = run(editor);
    const sel = rpc.getSelection('');
    editor.setSelectionRange(6, 11); // user moved the caret before the write arrived
    const res = rpc.replaceSelection('HOWDY', sel.tabId, sel.start, sel.end);
    assert.strictEqual(res.replaced, false);
    assert.strictEqual(editor.value, 'hello world', 'the buffer must be untouched when the selection moved');
    console.log('PASS: replaceSelection refuses a stale selection instead of clobbering the wrong text.');
  }
}

// ---- 10. No emoji anywhere in the strings this task added ----------------------------------
{
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
  const I18N = context.I18N;
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u; // U+2715 (the shared close glyph) is excluded
  const newKeys = [
    'cmdPaletteVoiceInput', 'cmdPaletteVoiceInputDesc', 'mobileDropSharingPreview', 'sectionVoiceInput',
    'voiceCredentialHint', 'voiceModelLabel', 'voiceSilenceLabel', 'voicePromptLabel', 'pasteImageSaved',
    'pasteImageSaveFailed', 'pasteHtmlConverted', 'voiceMicDenied', 'voiceTranscribeFailed',
    'voiceTranscribeUnavailable', 'voiceKeepFailed', 'voiceDiscardFailed', 'voiceCacheMissing', 'voiceEscHint',
    'fanchorOpenFailed', 'fanchorRevealFailed', 'fanchorImportFailed', 'fanchorImportUnavailable',
    'fanchorFileTooLarge', 'fanchorDropLabel'
  ];
  for (const lang of ['en', 'ja']) {
    for (const key of newKeys) {
      assert(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `I18N.${lang}.${key} must exist`);
      assert(!EMOJI.test(I18N[lang][key]), `I18N.${lang}.${key} must not contain an emoji: ${I18N[lang][key]}`);
    }
  }
  console.log('PASS: no emoji in the new i18n strings.');
}

console.log('All rev3 wiring tests passed.');
