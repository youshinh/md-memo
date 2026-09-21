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

  // The default split: Ctrl+V makes Markdown (structured HTML -> Markdown, a lone picture -> OCR); Ctrl+Shift+V pastes as it is.
  const cases = [
    [{ special: false, types: [], hasImage: true, ocrEnabled: true }, 'ocr'],
    // OCR off, or no API setup for it: the picture is kept as a file (like Mobile Drop), not dropped silently
    [{ special: false, types: [], hasImage: true, ocrEnabled: false }, 'saveImage'],
    [{ special: false, types: [], hasImage: true, ocrEnabled: true, visionReady: false }, 'saveImage'],
    [{ special: false, types: [], hasImage: true, ocrEnabled: true, visionReady: true }, 'ocr'],
    [{ special: false, types: ['text/html'], hasImage: true, ocrEnabled: false }, 'saveImage'],
    [{ special: false, types: ['text/plain'], hasImage: true, ocrEnabled: false }, 'default'],
    [{ special: false, types: ['text/plain'], hasImage: false, ocrEnabled: true }, 'default'],
    // Ctrl+V: HTML with structure becomes Markdown, HTML without it (or from an editor) stays plain text
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: false, structured: true }, 'htmlToMd'],
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: false, structured: false }, 'default'],
    [{ special: false, types: ['text/html', 'text/plain', 'vscode-editor-data'], hasImage: false, structured: true, editorOrigin: true }, 'default'],
    [{ special: false, types: ['text/plain'], hasImage: false, structured: true }, 'default'],
    // Excel / Word: image + HTML + text on the clipboard at once -> the table, not a screenshot
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: true, ocrEnabled: true, structured: true }, 'htmlToMd'],
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: true, ocrEnabled: true, structured: false }, 'default'],
    // An image copied from a browser has HTML (<img>) but no plain text: still OCR on Ctrl+V.
    [{ special: false, types: ['text/html'], hasImage: true, ocrEnabled: true, structured: true }, 'ocr'],
    // Ctrl+Shift+V pastes as it is: plain text, or a lone picture kept as a file
    [{ special: true, types: [], hasImage: true, ocrEnabled: true }, 'saveImage'],
    [{ special: true, types: ['text/html'], hasImage: true, ocrEnabled: true, structured: true }, 'saveImage'],
    [{ special: true, types: ['text/html'], hasImage: false, structured: true }, 'default'],
    [{ special: true, types: ['text/html', 'text/plain'], hasImage: false, structured: true }, 'default'],
    [{ special: true, types: ['text/html', 'text/plain'], hasImage: true, structured: true }, 'default'],
    [{ special: true, types: ['text/plain'], hasImage: false }, 'default'],
    [{ special: true, types: ['text/plain'], hasImage: false, canReadClipboard: true }, 'default'],
    // Chromium hands Ctrl+Shift+V an event with text/plain only, so a copied picture shows up as an EMPTY clipboard there:
    // without plain text the real clipboard is asked (a picture saved as a file, HTML made Markdown when it stands alone)
    [{ special: true, types: [], hasImage: false, canReadClipboard: true }, 'readClipboard'],
    [{ special: true, types: [], hasImage: false, canReadClipboard: false }, 'default'],
    [{ special: true, types: ['text/html'], hasImage: false, canReadClipboard: true }, 'readClipboard'],
    [{ special: false, types: [], hasImage: false, canReadClipboard: true }, 'default'],
    // The old split (Settings -> General "Ctrl+V turns ... into Markdown" off): Ctrl+V plain, Ctrl+Shift+V converts
    [{ special: false, types: ['text/html', 'text/plain'], hasImage: false, structured: true, htmlAsMarkdown: false }, 'default'],
    [{ special: false, types: [], hasImage: true, ocrEnabled: true, htmlAsMarkdown: false }, 'ocr'],
    [{ special: false, types: [], hasImage: true, ocrEnabled: false, htmlAsMarkdown: false }, 'saveImage'],
    [{ special: true, types: [], hasImage: true, ocrEnabled: true, htmlAsMarkdown: false }, 'saveImage'],
    [{ special: true, types: ['text/html'], hasImage: false, ocrEnabled: true, htmlAsMarkdown: false }, 'htmlToMd'],
    [{ special: true, types: ['text/html', 'text/plain'], hasImage: true, ocrEnabled: true, htmlAsMarkdown: false }, 'htmlToMd'],
    [{ special: true, types: ['text/plain'], hasImage: false, htmlAsMarkdown: false }, 'default'],
    [{ special: true, types: ['text/plain'], hasImage: false, canReadClipboard: true, htmlAsMarkdown: false }, 'readClipboard']
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(decidePasteAction(input), want, `decidePasteAction(${JSON.stringify(input)}) should be ${want}`);
  }
  console.log('PASS: decidePasteAction truth table.');

  // isVisionConfigured mirrors QueryVision in pkg/llm: which image-model setups can answer without an API key
  {
    const s = appJs.indexOf('function isVisionConfigured() {');
    assert(s > 0, 'isVisionConfigured not found');
    let d = 0, e = -1;
    for (let i = s; i < appJs.length; i++) {
      if (appJs[i] === '{') d++;
      else if (appJs[i] === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    const ready = (vision) => new Function('config', `${appJs.slice(s, e)}; return isVisionConfigured();`)({ vision });
    const gem = 'https://generativelanguage.googleapis.com';
    assert.strictEqual(ready({ baseUrl: gem, model: 'gemini-flash-lite-latest', apiKey: '' }), false, 'Gemini without a key');
    assert.strictEqual(ready({ baseUrl: gem, model: 'gemini-flash-lite-latest', apiKey: 'k' }), true, 'Gemini with a key');
    assert.strictEqual(ready({ baseUrl: '', model: '', apiKey: '' }), false, 'an empty setup is Gemini (the default) and needs a key');
    assert.strictEqual(ready({ baseUrl: '', model: '', apiKey: ' ' }), false, 'a blank key is no key');
    assert.strictEqual(ready({ baseUrl: 'http://localhost:11434', model: 'llava', apiKey: '' }), true, 'Ollama needs no key');
    assert.strictEqual(ready({ baseUrl: 'http://192.168.1.5:1234', model: 'gemini-like-name', apiKey: '' }), true, 'a local server is local whatever the model is called');
    assert.strictEqual(ready({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: '' }), false, 'a hosted OpenAI-style service needs a key');
    assert.strictEqual(ready({ baseUrl: 'https://openrouter.ai/api/v1', model: 'x', apiKey: 'k' }), true);
    assert.strictEqual(ready({ baseUrl: 'https://my-gateway.example.com/v1', model: 'llava', apiKey: '' }), true, 'an unknown OpenAI-style host is tried without a key');
    assert.strictEqual(ready(undefined), false, 'no vision config at all falls to the Gemini default');
    console.log('PASS: isVisionConfigured follows the vision rules of pkg/llm.');
  }

  // The paste handler tells the two reasons apart and the settings dialog explains the fallback
  {
    assert(/const why = special \? 'pasteImageSaved' : \(ocrOn \? 'pasteImageSavedNoVision' : 'pasteImageSavedOcrOff'\);\s*await savePastedImage\(e, imageItem, editor, why\);/.test(appJs),
      'a normal paste that falls back to saving says why');
    assert(/visionReady: isVisionConfigured\(\)/.test(appJs), 'the decision gets the vision state');
    assert(/const htmlAsMarkdown = !\(config\.general && config\.general\.pasteHtmlAsMarkdown === false\);/.test(appJs), 'the setting defaults to on (missing = on)');
    assert(/window\.HtmlToMd\.hasStructure\(cd\.getData\('text\/html'\) \|\| ''\)/.test(appJs), 'a plain Ctrl+V asks whether the HTML has structure');
    assert(/editorOrigin: types\.indexOf\('vscode-editor-data'\) !== -1/.test(appJs), 'VS Code content is recognised and left alone');
    assert(/pasteHtmlAsMarkdown: true/.test(appJs), 'the default config turns it on');
    // Ctrl+Shift+V of a picture: the event has no image, the async clipboard is read and the picture kept as a file
    assert(/const imageType = kinds\.find\(\(k\) => k\.indexOf\('image\/'\) === 0\);\s*if \(imageType && !imageBlob\) imageBlob = await clipItem\.getType\(imageType\);/.test(appJs),
      'readClipboard looks for a picture in the async clipboard');
    assert(/await savePastedImageBlob\(imageBlob, editor, 'pasteImageSaved'\);/.test(appJs), 'and saves it like a picture that came in the event');
    assert(/showMessage\(t\('pasteClipboardUnreadable'\), 5000\)/.test(appJs), 'a refused clipboard read says so instead of doing nothing');
    assert(/id="cfg-paste-html-md"/.test(indexHtml) && /cfg-paste-html-md'\);\s*if \(pasteHtmlMdEl\) pasteHtmlMdEl\.checked = config\.general\.pasteHtmlAsMarkdown !== false;/.test(appJs)
      && /config\.general\.pasteHtmlAsMarkdown = savePasteHtmlMdEl\.checked/.test(appJs), 'the setting is in the dialog, loaded and saved');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(i18nJs + '; this.I18N = I18N;', ctx);
    for (const lang of ['en', 'ja']) {
      for (const key of ['pasteImageSavedOcrOff', 'pasteImageSavedNoVision', 'pasteImageOcrHint', 'pasteHtmlMdLabel', 'pasteHtmlMdHint', 'pasteClipboardUnreadable']) {
        assert(ctx.I18N[lang][key] && ctx.I18N[lang][key].length > 10, `${lang}.${key} exists`);
      }
    }
    assert(/data-i18n="pasteImageOcrHint"/.test(indexHtml), 'the checkbox has its explanation');
    console.log('PASS: the paste fallback names its reason and the setting explains it.');
  }

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
  // Voice input is a registry shortcut now (configurable), still checked first in the global handler.
  assert(!/isModStrict && e\.shiftKey && !e\.altKey && \(e\.key === 'r' \|\| e\.key === 'R'\)/.test(appJs), 'the hard-coded Ctrl/Cmd+Shift+R check must be gone');
  const voiceBranch = appJs.indexOf('matchShortcut(e, config.shortcuts && config.shortcuts.voiceInput)');
  const specialPasteArm = appJs.indexOf('specialPasteArmedAt = Date.now();');
  assert(voiceBranch > mainHandlerIdx && voiceBranch < specialPasteArm, 'the voice-input branch keeps its place at the top of the global handler');
  assert(/matchShortcut\(e, config\.shortcuts && config\.shortcuts\.voiceInput\)\) \{\s*e\.preventDefault\(\);\s*if \(window\.VoiceInput\) window\.VoiceInput\.toggle\(\);\s*return;/.test(appJs),
    'the voice-input shortcut must toggle VoiceInput');
  console.log('PASS: voice ESC guard (capture phase) and the configurable voice-input shortcut branch.');
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
    'voiceStopLabel', 'voiceStopTitle',
    'fanchorOpenFailed', 'fanchorRevealFailed', 'fanchorImportFailed', 'fanchorImportUnavailable',
    'fanchorFileTooLarge', 'fanchorDropLabel',
    // voice settings, feedback and the command's toolbar / menu / shortcut entries
    'voiceModelHint', 'voiceApiStyleLabel', 'voiceApiStyleAuto', 'voiceApiStyleInteractions', 'voiceApiStyleGenerateContent',
    'voiceLanguageLabel', 'voiceLanguageHint', 'voiceModeLabel', 'voiceModeSmart', 'voiceModeVerbatim', 'voiceModeHint',
    'voiceVocabularyLabel', 'voiceVocabularyHint', 'voicePromptHint', 'voiceInputTitle', 'voiceStarting',
    'voiceWaitingPermission', 'voiceMicBlocked', 'voiceMicNotFound', 'voiceMicBusy', 'voiceNeedsEditor',
    'ctxVoiceInput', 'shortcutActionVoiceInput', 'mobileDropReceivedFallback'
  ];
  for (const lang of ['en', 'ja']) {
    for (const key of newKeys) {
      assert(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `I18N.${lang}.${key} must exist`);
      assert(!EMOJI.test(I18N[lang][key]), `I18N.${lang}.${key} must not contain an emoji: ${I18N[lang][key]}`);
    }
  }
  console.log('PASS: no emoji in the new i18n strings.');
}

// ---- 11. config.voice defaults: Gemini 3.5 Transcribe, and every new key with its default -------
{
  const start = appJs.indexOf('    voice: {\n      model:');
  assert(start > 0, 'config.voice defaults not found');
  const end = appJs.indexOf('\n    },', start);
  // JSON round trip: the literal is evaluated in another realm, whose Object/Array prototypes differ.
  const defaults = JSON.parse(JSON.stringify(vm.runInNewContext(`(${appJs.slice(start + '    voice: '.length, end + 6).replace(/,\s*$/, '')})`)));
  assert.deepStrictEqual(defaults, {
    model: 'gemini-3.5-transcribe',
    apiStyle: 'auto',
    baseUrl: '',
    apiKey: '',
    languageCodes: [],
    mode: 'smart',
    customVocabulary: [],
    prompt: 'この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。',
    silence_timeout_sec: 5
  });
  // The old default must not linger anywhere the voice model is named.
  assert(!/voice[^\n]{0,80}gemini-2\.5-flash/.test(appJs), 'app.js must not fall back to gemini-2.5-flash for voice');
  assert(!/id="cfg-voice-model"[^>]*placeholder="gemini-2\.5-flash"/.test(indexHtml), 'the voice model placeholder is the new default');
  assert(/id="cfg-voice-model"[^>]*placeholder="gemini-3\.5-transcribe"/.test(indexHtml));
  // Saved configs merge over these defaults, so a config predating the new keys keeps working.
  assert(/if \(parsed\.voice\) Object\.assign\(config\.voice, parsed\.voice\);/.test(appJs), 'saved voice settings are merged over the defaults');
  console.log('PASS: config.voice defaults (gemini-3.5-transcribe, apiStyle auto, smart mode, empty lists).');
}

// ---- 12. Settings UI: model datalist, API style, language, mode, vocabulary, hints ----------------
{
  const voiceStart = indexHtml.indexOf('<!-- Voice Input -->');
  const voiceEnd = indexHtml.indexOf('<!-- Image Generation -->');
  assert(voiceStart > 0 && voiceEnd > voiceStart, 'the Voice input settings group was not found');
  const group = indexHtml.slice(voiceStart, voiceEnd);
  for (const id of ['cfg-voice-model', 'cfg-voice-api-style', 'cfg-voice-language', 'cfg-voice-mode', 'cfg-voice-vocabulary',
    'cfg-voice-silence', 'cfg-voice-prompt', 'voice-model-suggestions']) {
    assert(group.includes(`id="${id}"`), `the Voice input group must contain #${id}`);
  }
  assert(/id="cfg-voice-model"[^>]*list="voice-model-suggestions"/.test(group), 'the model field offers suggestions');
  const suggestions = [...group.slice(group.indexOf('id="voice-model-suggestions"')).matchAll(/<option value="([^"]+)"/g)].slice(0, 3).map((m) => m[1]);
  assert.deepStrictEqual(suggestions, ['gemini-3.5-transcribe', 'gemini-2.5-flash', 'gemini-flash-lite-latest']);
  const selectValues = (id) => [...group.slice(group.indexOf(`id="${id}"`)).split('</select>')[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(selectValues('cfg-voice-api-style'), ['auto', 'interactions', 'generateContent']);
  assert.deepStrictEqual(selectValues('cfg-voice-mode'), ['smart', 'verbatim']);
  assert(/id="cfg-voice-language"[^>]*placeholder="ja-JP, en-US"/.test(group), 'the language field shows the format');
  assert(/<textarea id="cfg-voice-vocabulary"/.test(group), 'the vocabulary is a multi-line field');
  for (const key of ['voiceModelHint', 'voiceLanguageHint', 'voiceModeHint', 'voiceVocabularyHint', 'voicePromptHint']) {
    assert(group.includes(`data-i18n="${key}"`), `the group must show the ${key} hint`);
  }
  assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(group), 'no emoji in the voice settings group');

  // Load / save code for every field.
  const openStart = appJs.indexOf('function openSettings()');
  const saveStart = appJs.indexOf("document.getElementById('btn-save-settings').onclick");
  assert(openStart > 0 && saveStart > openStart);
  const openSrc = appJs.slice(openStart, appJs.indexOf("const cliModelEl = document.getElementById('cfg-cli-model')", openStart));
  const saveSrc = appJs.slice(saveStart, appJs.indexOf('if (!config.cli) config.cli = {};', saveStart));
  for (const id of ['cfg-voice-model', 'cfg-voice-api-style', 'cfg-voice-language', 'cfg-voice-mode', 'cfg-voice-vocabulary']) {
    assert(openSrc.includes(`'${id}'`), `openSettings must load #${id}`);
    assert(saveSrc.includes(`'${id}'`), `Save must read #${id}`);
  }
  assert(/config\.voice\.languageCodes = textToList\(/.test(saveSrc) && /config\.voice\.customVocabulary = textToList\(/.test(saveSrc));
  assert(/listToText\(config\.voice && config\.voice\.languageCodes, ', '\)/.test(openSrc));
  assert(/listToText\(config\.voice && config\.voice\.customVocabulary, '\\n'\)/.test(openSrc));
  assert(/saveVoiceModelEl\.value\.trim\(\) \|\| 'gemini-3\.5-transcribe'/.test(saveSrc), 'an emptied model field falls back to the new default');

  // The text <-> list conversions, run for real.
  const extract = (name) => {
    const s = appJs.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = appJs.indexOf('{', s); i < appJs.length; i++) {
      if (appJs[i] === '{') depth++;
      else if (appJs[i] === '}' && --depth === 0) return appJs.slice(s, i + 1);
    }
    throw new Error(`${name} not found`);
  };
  const { listToText, textToList } = new Function(`${extract('listToText')}\n${extract('textToList')}\nreturn { listToText, textToList };`)();
  assert.strictEqual(listToText(['ja-JP', 'en-US'], ', '), 'ja-JP, en-US');
  assert.strictEqual(listToText(['A', 'B'], '\n'), 'A\nB');
  assert.strictEqual(listToText([], ', '), '');
  assert.strictEqual(listToText(undefined, ', '), '');
  assert.strictEqual(listToText('ja-JP', ', '), 'ja-JP', 'a hand-edited string is shown as it is');
  assert.deepStrictEqual(textToList('ja-JP, en-US', /[\s,、，]+/), ['ja-JP', 'en-US']);
  assert.deepStrictEqual(textToList(' ja-JP,en-US ,, fr-FR\n', /[\s,、，]+/), ['ja-JP', 'en-US', 'fr-FR']);
  assert.deepStrictEqual(textToList('', /[\s,、，]+/), [], 'empty = auto-detect = no field at all');
  assert.deepStrictEqual(textToList('Kubernetes\r\n  BigQuery \n\n田中 太郎\n', /\r?\n/), ['Kubernetes', 'BigQuery', '田中 太郎']);
  console.log('PASS: the voice settings group, its load/save wiring and the text <-> list conversions.');
}

// ---- 13. Mobile Drop uses the one voice-config builder, and can ask for the note folder ---------
{
  const startFn = appJs.slice(appJs.indexOf('async function startMobileDrop()'), appJs.indexOf('function cancelMobileDrop()'));
  assert(startFn.includes('window.VoiceInput.configJSON(config, { timeout: 0 })'), 'Mobile Drop builds the voice config through VoiceInput.configJSON');
  assert(!/Object\.assign\(\{\}, config\.voice/.test(startFn), 'no second, inline voice-config builder');
  assert(/getNoteDir: function \(\) \{\s*return getNoteDir\(\);\s*\}/.test(appJs), 'window.__mdMemoRPC.getNoteDir is what the Go side asks for');
  assert(/mobileDropReceivedFallback', \{ count: kept \}/.test(appJs), 'the received callback reports the kept items');
  console.log('PASS: Mobile Drop shares the voice-config builder and exposes getNoteDir over RPC.');
}

// ---- 14. The voice-input shortcut also fires when an IME turns the key into "Process" ------------
// The old hard-coded check compared e.key only, so an IME-on press (key 'Process', keyCode 229,
// code 'KeyR') did nothing at all. The registry matcher (matchShortcut) also accepts the physical
// key (e.code), which is what makes that press work now; this pins that behaviour for the
// voice-input binding (and, unchanged, every other shortcut).
{
  const extract = (name) => {
    const s = appJs.indexOf(`function ${name}(`);
    assert(s > 0, `${name} not found`);
    let depth = 0;
    for (let i = appJs.indexOf('{', s); i < appJs.length; i++) {
      if (appJs[i] === '{') depth++;
      else if (appJs[i] === '}' && --depth === 0) return appJs.slice(s, i + 1);
    }
    throw new Error(`${name} not closed`);
  };
  const code = `${extract('parseShortcutString')}\n${extract('matchShortcut')}\nglobalThis.__m = matchShortcut;`;
  const build = (isMac) => {
    const ctx = vm.createContext({ console, isMac, shortcutParseCache: new Map() });
    vm.runInContext(code, ctx);
    return (e, shortcut) => Boolean(ctx.__m(e, shortcut)); // matchShortcut may return '' for "no"
  };
  const win = build(false);
  const mac = build(true);
  const ev = (o) => Object.assign({ key: '', code: '', keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o);
  const combo = 'Ctrl+Shift+R';

  // Ordinary delivery.
  assert.strictEqual(win(ev({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }), combo), true);
  assert.strictEqual(win(ev({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }), combo), true);
  // The reported case: a Japanese IME hands the press over as key 'Process' / keyCode 229.
  const process1 = ev({ key: 'Process', keyCode: 229, code: 'KeyR', ctrlKey: true, shiftKey: true });
  assert.strictEqual(win(process1, combo), true, 'an IME-delivered press still matches on the physical key');
  assert.strictEqual(win(ev({ key: 'Unidentified', keyCode: 229, code: 'KeyR', ctrlKey: true, shiftKey: true }), combo), true);
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyR', ctrlKey: true, shiftKey: true, isComposing: true }), combo), true, 'the bound combo wins even mid-composition');
  // ...but both modifiers are required, the physical key must match, and nothing else may fire.
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyR' }), combo), false, 'plain typing through an IME never triggers it');
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyR', shiftKey: true }), combo), false);
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyR', ctrlKey: true }), combo), false);
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyT', ctrlKey: true, shiftKey: true }), combo), false, 'another physical key');
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyR', ctrlKey: true, shiftKey: true, altKey: true }), combo), false, 'an extra Alt');
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, ctrlKey: true, shiftKey: true }), combo), false, 'no physical key reported');
  // An unassigned binding matches nothing, IME or not.
  assert.strictEqual(win(ev({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }), ''), false);
  assert.strictEqual(win(process1, ''), false);
  assert.strictEqual(win(process1, undefined), false);
  // A rebound shortcut is honoured the same way.
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'KeyM', ctrlKey: true, altKey: true }), 'Ctrl+Alt+M'), true);
  assert.strictEqual(win(ev({ key: 'Process', keyCode: 229, code: 'Digit7', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+7'), true);
  // macOS: Cmd (meta) is the modifier.
  assert.strictEqual(mac(ev({ key: 'Process', keyCode: 229, code: 'KeyR', metaKey: true, shiftKey: true }), 'Cmd+Shift+R'), true);
  assert.strictEqual(mac(ev({ key: 'Process', keyCode: 229, code: 'KeyR', ctrlKey: true, shiftKey: true }), 'Cmd+Shift+R'), false, 'physical Ctrl is not Cmd');
  assert.strictEqual(mac(ev({ key: 'R', code: 'KeyR', metaKey: true, shiftKey: true }), 'Cmd+Shift+R'), true);
  console.log('PASS: the voice-input shortcut survives an IME delivering the key as "Process" (modifiers + physical key).');
}

// ---- 15. Toolbar button, right-click item, palette entry and recording state -----------------------
{
  const actionsStart = indexHtml.indexOf('<div id="header-actions">');
  const actions = indexHtml.slice(actionsStart, indexHtml.indexOf('</header>', actionsStart));
  const firstDivider = actions.indexOf('header-divider');
  const btnAt = actions.indexOf('id="btn-voice-input"');
  assert(btnAt > 0 && btnAt < firstDivider, 'the microphone button sits in the first toolbar group, next to Mobile Drop');
  assert(btnAt > actions.indexOf('id="btn-mobile-drop"'), 'it follows the Mobile Drop button');
  assert(/<button id="btn-voice-input" class="btn-header-icon" data-i18n-title="voiceInputTitle"/.test(actions), 'a normal toolbar icon button with a translated tooltip');
  const btnHtml = actions.slice(btnAt, actions.indexOf('</button>', btnAt));
  assert(/<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.8"/.test(btnHtml) && /<rect x="9" y="2" width="6" height="12" rx="3">/.test(btnHtml),
    'the toolbar icon is the line-SVG microphone');
  assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btnHtml), 'no emoji in the button');
  // Same microphone as the command palette entry.
  const paletteIcon = appJs.slice(appJs.indexOf("id: 'cmd_voice_input'"), appJs.indexOf("id: 'cmd_pipe_polish'"));
  assert(paletteIcon.includes('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>'));
  assert(paletteIcon.includes('desc: voiceInputPaletteDesc()'), 'the palette entry names the CURRENT binding');

  const menuStart = indexHtml.indexOf('<div id="context-menu"');
  const menu = indexHtml.slice(menuStart, indexHtml.indexOf('<!-- Settings Modal -->', menuStart));
  assert(menu.length > 100 && menu.includes('id="ctx-settings"'), 'the context menu slice ends at the Settings modal');
  const itemAt = menu.indexOf('<div class="menu-item" id="ctx-voice-input">');
  assert(itemAt > menu.indexOf('id="ctx-command-bar"') && itemAt < menu.indexOf('id="ctx-settings"'), 'the item sits with the AI items, above Settings');
  const item = menu.slice(itemAt, menu.indexOf('</div>', itemAt));
  assert(/class="menu-icon"[^>]*><rect x="9" y="2" width="6" height="12" rx="3"\/>/.test(item), 'a menu-icon line SVG');
  assert(item.includes('data-i18n="ctxVoiceInput"') && item.includes('id="sc-ctx-voice-input"'), 'label and shortcut span like its neighbours');
  assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(item), 'no emoji in the menu item');
  // chrome_layout reads both surfaces from the markup, so neither needs a registry entry.
  const layoutJs = fs.readFileSync('frontend/js/chrome_layout.js', 'utf8');
  assert(/isItem: \(el\) => el\.tagName === 'BUTTON' && !!el\.id/.test(layoutJs) && /classList\.contains\('menu-item'\) && !!el\.id/.test(layoutJs),
    'chrome_layout picks up any id-carrying toolbar button / .menu-item, hidden or reordered through the saved layout');

  assert(/btnVoiceInput\.onclick = \(\) => \{ if \(window\.VoiceInput\) window\.VoiceInput\.toggle\(\); \};/.test(appJs), 'the button toggles voice input');
  assert(/ctxVoiceInput\.onclick = \(\) => \{\s*contextMenu\.classList\.add\('hidden'\);\s*if \(window\.VoiceInput\) window\.VoiceInput\.toggle\(\);/.test(appJs), 'the menu item closes the menu and toggles voice input');
  assert(/window\.VoiceInput\.onStateChange\(\(recording\) => \{\s*if \(btnVoiceInput\) btnVoiceInput\.classList\.toggle\('active', !!recording\);/.test(appJs), 'the button mirrors the recording state');

  // The one-listener hook lives in voice_input.js and only reports transitions.
  const voiceJs = fs.readFileSync('frontend/js/voice_input.js', 'utf8');
  assert(/onStateChange: onStateChange/.test(voiceJs) && /function notifyState\(\)/.test(voiceJs));
  for (const fn of ['start', 'abort', 'onRecorderStop']) {
    const s = voiceJs.indexOf(`function ${fn}(`);
    const body = voiceJs.slice(s, voiceJs.indexOf('\n  }\n', s));
    assert(body.includes('notifyState();'), `${fn}() must report the recording state`);
  }
  assert(/MdMemoBridge = \{[\s\S]{0,1600}isEditorVisible: function \(\) \{ return !isPreviewMode; \}/.test(appJs), 'the bridge tells voice input whether the editor is visible');
  console.log('PASS: toolbar button, right-click item, palette entry and the recording-state hook are wired.');
}

console.log('All rev3 wiring tests passed.');
