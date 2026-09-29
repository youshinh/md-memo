// Things a note can smuggle into the preview, found by the exploratory UX review (B21, B22):
//   B21  an HTML note's sandboxed script posts {type:'openExternal', url} to the app, which used to open any URL
//        (also vscode: and file:) in the browser with no click at all.
//   B22  linkifyVsCodePaths put the note's folder name into href / title unescaped, so a folder called
//        x"><img src=x onerror=...> ran script when a Markdown note with "src/app.js:12" in it was previewed.
// The functions are cut out of app.js and run against small stand-ins, like the other app.js tests here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const app = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8').replace(/\r\n/g, '\n');
const BS = String.fromCharCode(92);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in app.js`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} is not closed`);
}

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

// ---------------------------------------------------------------------------------------------------
// B21: links reported by the HTML preview frame
// ---------------------------------------------------------------------------------------------------
const activationLine = /const HTML_LINK_ACTIVATION_MS = (\d+);/.exec(app);
assert.ok(activationLine, 'HTML_LINK_ACTIVATION_MS is defined in app.js');
const ACTIVATION_MS = Number(activationLine[1]);

// A window with a clock and a user-activation flag we set by hand; frames are the objects querySelectorAll hands back.
function makeHtmlLinkEnv() {
  const frameWindow = { name: 'preview frame' };
  const opened = [];
  const toasts = [];
  const listeners = [];
  const env = {
    now: 100000,
    active: true,
    frames: [{ contentWindow: frameWindow }],
    frameWindow, opened, toasts, listeners,
    hasBackend: true
  };
  const context = {
    console,
    URL,
    performance: { now: () => env.now },
    navigator: { get userActivation() { return env.userActivation === undefined ? { isActive: env.active } : env.userActivation; } },
    document: { querySelectorAll: (sel) => (sel === '#html-preview-frame' ? env.frames : []) },
    showMessage: (msg) => toasts.push(msg),
    t: (key) => key,
    window: {
      get backend() { return env.hasBackend ? { openExternal: (url) => opened.push(['backend', url]) } : undefined; },
      open: (url) => opened.push(['window.open', url]),
      addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts })
    }
  };
  vm.createContext(context);
  vm.runInContext([
    `const HTML_LINK_ACTIVATION_MS = ${ACTIVATION_MS};`,
    'let lastOwnInputAt = -Infinity;',
    'let ownInputTracked = false;',
    extractFunction(app, 'trackOwnInput'),
    extractFunction(app, 'decideHtmlPreviewLink'),
    extractFunction(app, 'openExternalFromHtmlPreview'),
    'globalThis.__api = { trackOwnInput, decideHtmlPreviewLink, openExternalFromHtmlPreview };'
  ].join('\n'), context);
  env.api = context.__api;
  env.message = (data, source) => env.api.openExternalFromHtmlPreview({ data, source: source === undefined ? env.frameWindow : source });
  return env;
}

check('B21: a link the frame reports after a real click, with no input of our own nearby, is opened in the browser', () => {
  const env = makeHtmlLinkEnv();
  env.message({ type: 'openExternal', url: 'https://example.com/a b?x=1' });
  assert.deepEqual(env.opened, [['backend', 'https://example.com/a%20b?x=1']], 'the address is passed on normalised, once');
  env.message({ type: 'openExternal', url: 'http://example.com/' });
  assert.equal(env.opened.length, 2, 'http works too');
  assert.deepEqual(env.toasts, []);
});

check('B21: a message with no user activation (a script talking on its own) opens nothing and says nothing', () => {
  const env = makeHtmlLinkEnv();
  env.active = false;
  env.message({ type: 'openExternal', url: 'https://evil.example/phish' });
  assert.deepEqual(env.opened, []);
  assert.deepEqual(env.toasts, [], 'no notice: nobody clicked, so nobody is waiting for the link');
  env.userActivation = null; // a webview without the User Activation API is refused as well
  env.message({ type: 'openExternal', url: 'https://evil.example/phish' });
  assert.deepEqual(env.opened, []);
});

check('B21: a message that follows our own key or click closely cannot be told from a script, so it asks for a second click', () => {
  const env = makeHtmlLinkEnv();
  env.api.trackOwnInput(); // what rendering the preview does: the input that opened it is fresh
  env.now += ACTIVATION_MS - 1;
  env.message({ type: 'openExternal', url: 'https://evil.example/onload' });
  assert.deepEqual(env.opened, [], 'not opened just after our own input, even though the window has activation');
  assert.deepEqual(env.toasts, ['htmlLinkRetry'], 'the user is told to click again');
  env.now += 2;
  env.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.deepEqual(env.opened, [['backend', 'https://example.com/']], 'once the activation cannot be ours any more it works');
});

check('B21: our own input keeps being tracked (a Ctrl+P or a click restarts the wait), and the listeners are added once', () => {
  const env = makeHtmlLinkEnv();
  env.api.trackOwnInput();
  env.api.trackOwnInput();
  const types = env.listeners.map((l) => l.type).sort();
  assert.deepEqual(types, ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend', 'touchstart'], 'each event type once, however often a preview is drawn');
  assert.ok(env.listeners.every((l) => l.opts && l.opts.capture === true && l.opts.passive === true), 'capture and passive: no cost to typing, no chance to miss an event');
  env.now += ACTIVATION_MS + 500;
  env.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.equal(env.opened.length, 1, 'idle long enough');
  env.listeners.find((l) => l.type === 'keydown').fn(); // a key we handled ourselves
  env.now += 100;
  env.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.equal(env.opened.length, 1, 'a key just now: refused again');
  assert.deepEqual(env.toasts, ['htmlLinkRetry']);
});

check('B21: only an http(s) address is ever opened: vscode:, file:, javascript:, data:, mailto: and relative links are refused', () => {
  const env = makeHtmlLinkEnv();
  for (const url of ['vscode://file/C:/x', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.c',
    '//evil.example/x', 'evil.example/x', '', '  ', 'ftp://evil.example/', BS + BS + 'host' + BS + 'share']) {
    env.message({ type: 'openExternal', url });
  }
  env.message({ type: 'openExternal', url: null });
  env.message({ type: 'openExternal', url: { href: 'https://evil.example/' } });
  assert.deepEqual(env.opened, [], 'nothing got through, whatever the shape of the url');
});

check('B21: only one of our own preview frames may speak: another window, a missing source or a detached frame is ignored', () => {
  const env = makeHtmlLinkEnv();
  env.message({ type: 'openExternal', url: 'https://example.com/' }, { name: 'some other window' });
  env.message({ type: 'openExternal', url: 'https://example.com/' }, null);
  assert.deepEqual(env.opened, [], 'neither another window nor a missing source is believed');
  env.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.equal(env.opened.length, 1, 'the frame itself is');
  const second = makeHtmlLinkEnv();
  second.frames = [{ contentWindow: null }, { contentWindow: second.frameWindow }];
  second.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.equal(second.opened.length, 1, 'with two panes showing HTML the second frame is recognised too');
  const none = makeHtmlLinkEnv();
  none.frames = [];
  none.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.deepEqual(none.opened, [], 'no preview frame on the page: nobody may ask');
});

check('B21: without a backend (a plain browser) the same checks decide, then window.open with noopener is used', () => {
  const env = makeHtmlLinkEnv();
  env.hasBackend = false;
  env.message({ type: 'openExternal', url: 'https://example.com/' });
  assert.deepEqual(env.opened, [['window.open', 'https://example.com/']]);
  env.active = false;
  env.message({ type: 'openExternal', url: 'https://example.com/again' });
  assert.equal(env.opened.length, 1, 'no activation: nothing, in this path as well');
});

check('B21: the wiring stays: the message listener goes through the gate, the preview registers its own input, and the sandbox stays tight', () => {
  // (the first 'message' listener in app.js is inside the helper script string that runs in the frame)
  const listener = app.slice(app.indexOf('// Handle messages from sandboxed HTML preview iframe'));
  const branch = listener.slice(listener.indexOf("'openExternal'"), listener.indexOf("'openExternal'") + 300);
  assert.ok(/openExternalFromHtmlPreview\(e\)/.test(branch), 'the openExternal branch calls the gate');
  assert.ok(!/backend\.openExternal\(e\.data\.url\)/.test(listener.slice(0, 1200)), 'and no longer trusts e.data.url directly');
  assert.ok(/function renderHtmlPreviewTo\([^)]*\) \{\s*targetPane\.classList\.add\('html-mode'\);\s*trackOwnInput\(\);/.test(app), 'rendering an HTML preview starts the input tracking before the page runs');
  const sandbox = /frame\.setAttribute\('sandbox', '([^']*)'\)/.exec(app);
  assert.ok(sandbox, 'the preview frame is sandboxed');
  const flags = sandbox[1].split(/\s+/);
  for (const bad of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups-to-escape-sandbox']) {
    assert.ok(!flags.includes(bad), `the sandbox must not grant ${bad} (with allow-scripts it would let the note out of the frame)`);
  }
});

// ---------------------------------------------------------------------------------------------------
// B22: linkifyVsCodePaths
// ---------------------------------------------------------------------------------------------------
function linkify(innerHtml, tabPath, cwd) {
  const el = {
    innerHTML: innerHtml,
    querySelector: (sel) => (sel === '.vscode-jump-link' && /class="vscode-jump-link"/.test(el.innerHTML) ? {} : null)
  };
  const container = { querySelectorAll: () => [el] };
  const context = { console, lastPipedCwd: cwd || '' };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(app, 'escapeHtml'),
    extractFunction(app, 'linkifyVsCodePaths'),
    'globalThis.__run = (c, tab) => linkifyVsCodePaths(c, tab);'
  ].join('\n'), context);
  context.__run(container, tabPath === undefined ? null : { path: tabPath });
  return el.innerHTML;
}

// What an HTML parser makes of an attribute value written with the five escapes escapeHtml produces.
const decodeAttr = (v) => v.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const ANCHOR = /^See <a href="([^"]*)" class="vscode-jump-link" title="([^"]*)">src\/app\.js:12<\/a> for details\.$/;

check('B22: a note folder with a quote and a tag in its name cannot break out of the href or the title', () => {
  const dir = '/Users/demo/x"><img src=x onerror=window.__pwn=1>';
  const out = linkify('See src/app.js:12 for details.', dir + '/n.md');
  const m = ANCHOR.exec(out);
  assert.ok(m, 'one well-formed anchor and nothing else: ' + out);
  assert.ok(!/<img/i.test(out), 'no tag from the folder name in the output');
  assert.equal(decodeAttr(m[1]), 'vscode://file/' + dir + '/src/app.js:12', 'the link still points at the real folder once the browser decodes the attribute');
  assert.equal(decodeAttr(m[2]), 'Open in VS Code (' + dir + '/src/app.js:12)');
});

check('B22: the working folder of the last piped command is escaped the same way, and an apostrophe or ampersand survives', () => {
  const cwd = "/tmp/o'brien & sons/<b>";
  const out = linkify('See src/app.js:12 for details.', undefined, cwd);
  const m = ANCHOR.exec(out);
  assert.ok(m, 'well formed: ' + out);
  assert.ok(!/<b>/.test(out) && !/'/.test(m[1]) && !/'/.test(m[2]), 'no raw < > or apostrophe left in an attribute');
  assert.equal(decodeAttr(m[1]), 'vscode://file/' + cwd + '/src/app.js:12');
});

check('B22: ordinary paths are unchanged: a Windows folder with a space, an absolute path, a column, and text with no path', () => {
  const win = 'C:' + BS + 'Users' + BS + 'my name' + BS + 'notes';
  const rel = linkify('See src/app.js:12 for details.', win + BS + 'n.md');
  const m = ANCHOR.exec(rel);
  assert.ok(m, rel);
  assert.equal(m[1], 'vscode://file/C:/Users/my name/notes/src/app.js:12');
  assert.equal(m[2], 'Open in VS Code (C:/Users/my name/notes/src/app.js:12)');

  const abs = linkify('See /opt/app/main.go:7:3 now', '/notes/n.md');
  assert.ok(abs.includes('<a href="vscode://file//opt/app/main.go:7"'), abs);
  assert.ok(abs.includes('>/opt/app/main.go:7</a>:3 now') || abs.includes('main.go:7</a>'), abs);

  assert.equal(linkify('nothing to link here: really', '/notes/n.md'), 'nothing to link here: really');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL: ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err));
  }
}
if (failed) {
  console.log(`\n${failed} of ${queue.length} preview link safety checks FAILED`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} preview link safety checks PASSED!`);
