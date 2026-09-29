// Unit tests for about_dialog.js (About MD-Memo, UX review I1): the pure helpers, and the dialog driven against a hand-made DOM and a
// host object like the one app.js passes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    try {
      await fn();
      console.log('PASS: ' + name);
    } catch (e) {
      console.error('FAIL: ' + name);
      throw e;
    }
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function settle() { for (let i = 0; i < 8; i++) await wait(0); }

// ---- a minimal DOM: just what the dialog touches ------------------------------------------------------
class FakeEl {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.handlers = {};
    this._text = '';
    this.className = '';
    this.id = '';
    this.disabled = false;
    this.type = '';
    this.title = '';
    const el = this;
    this.classList = {
      _set() { return new Set(el.className.split(/\s+/).filter(Boolean)); },
      _put(s) { el.className = Array.from(s).join(' '); },
      add(...c) { const s = this._set(); c.forEach((x) => s.add(x)); this._put(s); },
      remove(...c) { const s = this._set(); c.forEach((x) => s.delete(x)); this._put(s); },
      contains(c) { return this._set().has(c); }
    };
  }
  // A browser gives up the focus of an element that leaves the page: the page (body) has it then.
  _loseFocusIn() { this.walk((n) => { if (n.doc.activeElement === n) n.doc.activeElement = null; }); }
  set textContent(v) { this.children.forEach((c) => { c._loseFocusIn(); c.parentNode = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    node.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  after(node) {
    const p = this.parentNode;
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    node.parentNode = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }
  remove() { this._loseFocusIn(); if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  get nextSibling() {
    const p = this.parentNode;
    return p ? (p.children[p.children.indexOf(this) + 1] || null) : null;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn); }
  fire(type, ev) {
    const e = Object.assign({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, ev || {});
    (this.handlers[type] || []).slice().forEach((fn) => fn(e));
    return e;
  }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) return this.fire('click'); }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
  find(pred) { let hit = null; this.walk((n) => { if (!hit && pred(n)) hit = n; }); return hit; }
  findAll(pred) { const out = []; this.walk((n) => { if (pred(n)) out.push(n); }); return out; }
  hasClass(c) { return this.classList.contains(c); }
}

function makeDoc() {
  const doc = { activeElement: null, keyListeners: [] };
  doc.createElement = (tag) => new FakeEl(doc, tag);
  doc.root = doc.createElement('div');
  doc.getElementById = (id) => doc.root.find((n) => n.id === id);
  doc.addEventListener = (type, fn, cap) => { if (type === 'keydown') doc.keyListeners.push({ fn, cap }); };
  doc.removeEventListener = (type, fn) => { doc.keyListeners = doc.keyListeners.filter((l) => l.fn !== fn); };
  doc.press = (key) => {
    const ev = { key, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    doc.keyListeners.slice().forEach((l) => l.fn(ev));
    return ev;
  };
  const add = (parent, tag, id, cls) => {
    const el = doc.createElement(tag);
    el.id = id || '';
    el.className = cls || '';
    parent.appendChild(el);
    return el;
  };
  const modal = add(doc.root, 'div', 'about-modal', 'modal-backdrop hidden');
  const card = add(modal, 'div', '', 'modal-card about-card');
  const head = add(card, 'div', '', 'modal-header');
  add(head, 'h3', 'about-title');
  add(head, 'button', 'about-close');
  add(card, 'div', 'about-body', 'modal-body');
  const foot = add(card, 'div', '', 'modal-footer');
  add(foot, 'button', 'about-copy', 'btn-secondary').textContent = 'Copy details';
  add(foot, 'span', 'about-copy-status', 'visually-hidden');
  add(foot, 'button', 'about-done', 'btn-primary');
  return doc;
}

// The English and Japanese tables, evaluated straight from i18n.js, so the tests use the real strings.
const i18nCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '; this.I18N = I18N;', i18nCtx);
const EN = i18nCtx.I18N.en;
const JA = i18nCtx.I18N.ja;
const tOf = (dict) => (key, params) => {
  let s = dict[key] !== undefined ? dict[key] : key;
  Object.keys(params || {}).forEach((k) => { s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]); });
  return s;
};

const doc = makeDoc();
globalThis.document = doc;
const AD = require('./about_dialog.js');

const INFO = {
  version: '1.10.5', commit: 'a8bfea5', builtAt: '2026-09-30T05:12:34Z', os: 'windows', arch: 'amd64',
  executable: 'C:\\Program Files\\MD-Memo\\md-memo.exe', configDir: 'C:\\Users\\me\\AppData\\Roaming\\md-memo',
  configFile: 'C:\\Users\\me\\AppData\\Roaming\\md-memo\\config.json', scrapDir: 'C:\\Users\\me\\Documents\\md-memo\\scraps', signing: 'unsigned'
};

function makeHost(over) {
  const calls = { external: [], folders: [], copied: [], checks: 0 };
  const state = { status: 'idle', latest: '', current: '', url: '' };
  const host = Object.assign({
    t: tOf(EN),
    language: 'en',
    userAgent: 'Mozilla/5.0 Edg/141.0',
    getVersion: () => '1.10.5',
    getInfo: async () => INFO,
    getUpdateState: () => state,
    checkNow: async () => { calls.checks++; state.status = 'checking'; await wait(1); state.status = 'newer'; state.latest = '1.11.0'; state.current = '1.10.5'; state.url = AD.releaseNotesUrl('1.11.0'); },
    isCheckAtStartup: () => true,
    openExternal: (u) => calls.external.push(u),
    openFolder: async (p) => { calls.folders.push(p); },
    copyText: async (s) => { calls.copied.push(s); return true; }
  }, over || {});
  return { host, calls, state };
}

const body = () => doc.getElementById('about-body');
const modal = () => doc.getElementById('about-modal');
const text = () => body().textContent;
const button = (label) => body().find((n) => n.tagName === 'BUTTON' && n.textContent === label);

// ================================ pure helpers ========================================================
test('releaseNotesUrl: a version becomes its release page; anything odd falls back to the list of releases', () => {
  assert.strictEqual(AD.releaseNotesUrl('1.11.0'), 'https://github.com/youshinh/md-memo/releases/tag/v1.11.0');
  assert.strictEqual(AD.releaseNotesUrl('v1.11.0'), 'https://github.com/youshinh/md-memo/releases/tag/v1.11.0');
  assert.strictEqual(AD.releaseNotesUrl('2.0.0-rc.1'), 'https://github.com/youshinh/md-memo/releases/tag/v2.0.0-rc.1');
  for (const bad of ['', null, undefined, '../../evil', '1.0/../x', 'x y', '1.0\n2', 'javascript:alert(1)', 'a'.repeat(80), '<script>']) {
    assert.strictEqual(AD.releaseNotesUrl(bad), 'https://github.com/youshinh/md-memo/releases', 'not used in a URL: ' + JSON.stringify(bad));
  }
});

test('osLabel and signingKind', () => {
  assert.strictEqual(AD.osLabel('windows', 'amd64'), 'Windows x64');
  assert.strictEqual(AD.osLabel('darwin', 'arm64'), 'macOS arm64');
  assert.strictEqual(AD.osLabel('linux', '386'), 'Linux x86');
  assert.strictEqual(AD.osLabel('plan9', 'mips'), 'plan9 mips');
  assert.strictEqual(AD.osLabel('', ''), 'unknown');
  assert.strictEqual(AD.signingKind('adhoc-not-notarized'), 'adhoc');
  assert.strictEqual(AD.signingKind('unsigned'), 'none');
  assert.strictEqual(AD.signingKind(''), '');
  assert.strictEqual(AD.signingKind(undefined), '');
});

test('updateLine: one sentence per state; idle depends on the start-up setting', () => {
  assert.deepStrictEqual(AD.updateLine({ status: 'idle' }, true), { key: 'aboutUpdateIdleOn', params: {}, tone: '' });
  assert.deepStrictEqual(AD.updateLine({ status: 'idle' }, false), { key: 'aboutUpdateIdleOff', params: {}, tone: '' });
  assert.deepStrictEqual(AD.updateLine(null, false).key, 'aboutUpdateIdleOff');
  assert.deepStrictEqual(AD.updateLine({ status: 'checking' }, true).key, 'aboutUpdateChecking');
  assert.deepStrictEqual(AD.updateLine({ status: 'current', current: '1.10.5', latest: '1.10.5' }, true), { key: 'aboutUpdateCurrent', params: { version: '1.10.5' }, tone: '' });
  assert.deepStrictEqual(AD.updateLine({ status: 'newer', latest: '1.11.0', current: '1.10.5' }, true), { key: 'aboutUpdateNewer', params: { latest: '1.11.0', current: '1.10.5' }, tone: 'newer' });
  assert.strictEqual(AD.updateLine({ status: 'error' }, true).tone, 'error');
});

test('buildDetailsText: version, OS, WebView, signing, settings and folders, in English, and nothing secret', () => {
  const s = AD.buildDetailsText(INFO, { userAgent: 'Mozilla/5.0 Edg/141.0', language: 'ja', checkAtStartup: false });
  assert.deepStrictEqual(s.trim().split('\n'), [
    'MD-Memo 1.10.5',
    'Build: a8bfea5, 2026-09-30T05:12:34Z',
    'OS: Windows x64 (windows/amd64)',
    'WebView: Mozilla/5.0 Edg/141.0',
    'Signing: not code-signed',
    'UI language: ja',
    'Update check at start-up: off',
    'Program: C:\\Program Files\\MD-Memo\\md-memo.exe',
    'Settings folder: C:\\Users\\me\\AppData\\Roaming\\md-memo',
    'Settings file: C:\\Users\\me\\AppData\\Roaming\\md-memo\\config.json',
    'Daily notes folder: C:\\Users\\me\\Documents\\md-memo\\scraps'
  ]);
  assert.ok(s.endsWith('\n'));
  assert.ok(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(s), 'always English');
  const mac = AD.buildDetailsText({ version: '1.10.5', os: 'darwin', arch: 'arm64', signing: 'adhoc-not-notarized' }, {});
  assert.ok(mac.includes('Signing: ad-hoc signed, not notarized (macOS)'));
  assert.ok(!mac.includes('Build:') && !mac.includes('Settings folder'), 'lines with no data are left out');
  assert.strictEqual(AD.buildDetailsText(null, { version: '1.2.3' }), 'MD-Memo 1.2.3\n', 'an old backend that has no AppInfo still gives the version');
  assert.strictEqual(AD.buildDetailsText(null, null), 'MD-Memo unknown\n');
});

// ================================ the dialog ==========================================================
test('open: builds the version, updates, folders, license, links and the signing note; the shell is shown and Close has focus', async () => {
  const { host } = makeHost();
  assert.strictEqual(await AD.open(host), true);
  assert.ok(!modal().hasClass('hidden'), 'shown');
  assert.ok(AD.isOpen());
  assert.strictEqual(doc.activeElement, doc.getElementById('about-done'));
  const t = text();
  assert.ok(t.includes('MD-Memo'));
  assert.ok(t.includes('Version 1.10.5'));
  assert.ok(t.includes('Windows x64'));
  assert.ok(t.includes('Build a8bfea5, 2026-09-30'), 'the build line has the day, not the time');
  assert.ok(t.includes(EN.aboutUpdateIdleOn));
  for (const k of ['aboutSecUpdates', 'aboutSecFolders', 'aboutSecLicense']) assert.ok(t.includes(EN[k]), k);
  for (const p of [INFO.configDir, INFO.scrapDir, INFO.executable]) assert.ok(t.includes(p), p);
  assert.ok(t.includes(EN.aboutLicenseLine));
  assert.ok(t.includes(EN.aboutSignNone), 'Windows: not code-signed');
  const links = body().findAll((n) => n.hasClass('about-link')).map((n) => n.getAttribute('href'));
  assert.deepStrictEqual(links, [
    'https://github.com/youshinh/md-memo', 'https://github.com/youshinh/md-memo/releases', 'https://youshinh.github.io/md-memo/',
    'https://github.com/youshinh/md-memo/issues', 'https://github.com/youshinh/md-memo/blob/main/LICENSE'
  ]);
  assert.strictEqual(body().find((n) => n.hasClass('about-icon')).getAttribute('alt'), '', 'the icon is decoration');
  assert.strictEqual(body().find((n) => n.id === 'about-update-status').getAttribute('role'), 'status', 'a check result is announced');
  AD.close();
});

test('close: Close, the x button, the Esc key (which the rest of the app must not see) and the dim area all close it and empty the body', async () => {
  const { host } = makeHost();
  for (const how of ['done', 'x', 'esc', 'backdrop']) {
    await AD.open(host);
    assert.ok(AD.isOpen(), how);
    assert.strictEqual(doc.keyListeners.length, 1, 'one Esc listener while open');
    if (how === 'done') doc.getElementById('about-done').click();
    if (how === 'x') doc.getElementById('about-close').click();
    if (how === 'esc') {
      const ev = doc.press('Escape');
      assert.ok(ev.defaultPrevented && ev.stopped, 'Esc is swallowed');
    }
    if (how === 'backdrop') modal().fire('mousedown', { target: modal() });
    assert.ok(modal().hasClass('hidden'), how);
    assert.ok(!AD.isOpen());
    assert.strictEqual(body().children.length, 0, 'nothing is kept while closed');
    assert.strictEqual(doc.keyListeners.length, 0, 'the Esc listener is removed');
  }
  await AD.open(host);
  modal().fire('mousedown', { target: doc.getElementById('about-done') });
  assert.ok(AD.isOpen(), 'a click inside the card does not close it');
  doc.press('a');
  assert.ok(AD.isOpen(), 'other keys are left alone');
  AD.close();
  AD.close(); // closing twice is harmless
});

test('open twice at once shows one dialog; a backend without AppInfo still shows the version; a hanging backend does not hang the dialog', async () => {
  const { host } = makeHost();
  const first = AD.open(host);
  const second = AD.open(host);
  assert.strictEqual(await first, true);
  await second;
  assert.strictEqual(doc.keyListeners.length, 1, 'no second listener');
  AD.close();

  const none = makeHost({ getInfo: async () => null, getVersion: () => '1.9.0' });
  await AD.open(none.host);
  assert.ok(text().includes('Version 1.9.0'), 'falls back to the version app.js knows');
  assert.ok(!text().includes(EN.aboutSecFolders), 'no folders section without AppInfo');
  assert.ok(!text().includes(EN.aboutSignNone) && !text().includes(EN.aboutSignAdhoc), 'no signing note when the backend does not say');
  AD.close();

  const slow = makeHost({ getInfo: () => new Promise(() => {}) });
  const t0 = Date.now();
  await AD.open(slow.host);
  assert.ok(Date.now() - t0 < 3000 && AD.isOpen(), 'gives up on the backend after 1.5 s');
  AD.close();
});

test('the macOS build says ad-hoc signed and not notarized, in either language', async () => {
  for (const [dict, lang] of [[EN, 'en'], [JA, 'ja']]) {
    const { host } = makeHost({ t: tOf(dict), language: lang, getInfo: async () => Object.assign({}, INFO, { os: 'darwin', arch: 'arm64', signing: 'adhoc-not-notarized' }) });
    await AD.open(host);
    assert.ok(text().includes(dict.aboutSignAdhoc), lang);
    assert.ok(!text().includes(dict.aboutSignNone), lang);
    assert.ok(text().includes('macOS arm64'));
    AD.close();
  }
});

test('Check now: shows "Checking...", then the answer; a newer version brings the release notes button', async () => {
  const { host, calls, state } = makeHost();
  await AD.open(host);
  assert.strictEqual(button(EN.aboutReleaseNotes), null, 'no notes button before an update is known');
  button(EN.aboutCheckNow).click();
  assert.strictEqual(calls.checks, 1);
  assert.ok(text().includes(EN.aboutUpdateChecking), 'the state is shown at once');
  assert.strictEqual(button(EN.aboutCheckNow).getAttribute('aria-disabled'), 'true', 'and the button waits');
  button(EN.aboutCheckNow).click();
  assert.strictEqual(calls.checks, 1, 'a click while it waits does nothing');
  await settle();
  assert.ok(text().includes('Version 1.11.0 is available. You have 1.10.5.'));
  assert.strictEqual(button(EN.aboutCheckNow).getAttribute('aria-disabled'), 'false');
  assert.ok(body().find((n) => n.id === 'about-update-status').hasClass('is-newer'));
  button(EN.aboutReleaseNotes).click();
  assert.deepStrictEqual(calls.external, ['https://github.com/youshinh/md-memo/releases/tag/v1.11.0']);
  host.checkNow = async () => { state.status = 'error'; };
  button(EN.aboutCheckNow).click();
  await settle();
  assert.ok(text().includes(EN.aboutUpdateError));
  assert.strictEqual(button(EN.aboutReleaseNotes), null, 'the notes button goes with the newer state');
  AD.close();
});

test('Check now from the keyboard: the button keeps focus, and the status line is one element that says "Checking..." and then the answer (screen readers hear both)', async () => {
  const { host } = makeHost();
  await AD.open(host);
  const check = doc.getElementById('about-check');
  const status = doc.getElementById('about-update-status');
  assert.strictEqual(status.getAttribute('role'), 'status');
  check.focus();
  const seen = [];
  const watch = () => seen.push(status.textContent);
  check.fire('click'); // what Enter or Space does on a button
  watch();
  await wait(0); // while the request is out
  assert.strictEqual(doc.activeElement, check, 'focus is still on Check now while it checks');
  await settle();
  watch();
  assert.strictEqual(doc.activeElement, check, 'and after the answer');
  assert.strictEqual(doc.getElementById('about-check'), check, 'the button is the same element');
  assert.strictEqual(doc.getElementById('about-update-status'), status, 'so is the status line (a new element would not be announced)');
  assert.deepStrictEqual(seen, [EN.aboutUpdateChecking, 'Version 1.11.0 is available. You have 1.10.5.']);
  assert.ok(body().find((n) => n.id === 'about-release-notes'), 'the release notes button appeared beside it');
  assert.strictEqual(doc.activeElement, check, 'without moving focus');
  AD.close();
});

test('opened while the start-up check is still running: the row says "Checking..." and is redrawn with the answer', async () => {
  const state = { status: 'checking', latest: '', current: '', url: '' };
  let calls = 0;
  const { host } = makeHost({
    getUpdateState: () => state,
    checkNow: async () => { calls++; await wait(2); state.status = 'current'; state.current = '1.10.5'; state.latest = '1.10.5'; }
  });
  await AD.open(host);
  assert.ok(text().includes(EN.aboutUpdateChecking));
  assert.strictEqual(button(EN.aboutCheckNow).getAttribute('aria-disabled'), 'true', 'no second request from the button while one runs');
  await settle();
  await wait(5);
  assert.strictEqual(calls, 1, 'joined the running check once');
  assert.ok(text().includes('You are on the latest version (1.10.5).'));
  assert.strictEqual(button(EN.aboutCheckNow).getAttribute('aria-disabled'), 'false');
  AD.close();
});

test('Check now answered after the dialog was closed touches nothing', async () => {
  const { host } = makeHost({ checkNow: () => new Promise((r) => setTimeout(r, 5)) });
  await AD.open(host);
  button(EN.aboutCheckNow).click();
  AD.close();
  await wait(20);
  assert.strictEqual(body().children.length, 0);
  assert.ok(modal().hasClass('hidden'));
});

test('a check failing with an exception is shown from the state, not thrown', async () => {
  const { host, state } = makeHost({ checkNow: async () => { state.status = 'error'; throw new Error('offline'); } });
  await AD.open(host);
  button(EN.aboutCheckNow).click();
  await settle();
  assert.ok(text().includes(EN.aboutUpdateError));
  AD.close();
});

test('Open folder: asks the host for that path; a failure is one plain sentence under the row and clears on the next try', async () => {
  let fail = true;
  const { host, calls } = makeHost({ openFolder: async (p) => { calls.folders.push(p); if (fail) throw new Error('見つかりません'); } });
  await AD.open(host);
  const opens = body().findAll((n) => n.hasClass('about-open'));
  assert.strictEqual(opens.length, 2, 'settings and daily notes; the program has no Open button');
  opens[1].click();
  await settle();
  assert.deepStrictEqual(calls.folders, [INFO.scrapDir]);
  const errs = () => body().findAll((n) => n.hasClass('about-error'));
  assert.strictEqual(errs().length, 1);
  assert.strictEqual(errs()[0].textContent, EN.aboutOpenFailed, "the backend's own wording (Japanese) is not shown in the English UI");
  fail = false;
  opens[1].click();
  await settle();
  assert.strictEqual(errs().length, 0, 'the old sentence goes when it works');
  AD.close();
});

test('Copy details: puts the text on the clipboard, says so on the button for a moment, and says when it could not', async () => {
  const { host, calls } = makeHost();
  await AD.open(host);
  doc.getElementById('about-copy').click();
  await settle();
  assert.strictEqual(calls.copied.length, 1);
  assert.ok(calls.copied[0].startsWith('MD-Memo 1.10.5\n'));
  assert.ok(calls.copied[0].includes('WebView: Mozilla/5.0 Edg/141.0'));
  assert.ok(calls.copied[0].includes('Update check at start-up: on'));
  assert.strictEqual(doc.getElementById('about-copy').textContent, EN.aboutCopied);
  assert.strictEqual(doc.getElementById('about-copy-status').textContent, EN.aboutCopied, 'a screen reader is told through the status line');
  assert.strictEqual(doc.getElementById('about-copy-status').getAttribute('role'), null, 'the live region itself is in the page markup (index.html), not made here');
  AD.close();
  assert.strictEqual(doc.getElementById('about-copy-status').textContent, '', 'and it is cleared when the dialog closes');
  assert.strictEqual(doc.getElementById('about-copy').textContent, EN.aboutCopyDetails, 'the label is back when it closes');

  const bad = makeHost({ copyText: async () => false });
  await AD.open(bad.host);
  doc.getElementById('about-copy').click();
  await settle();
  assert.strictEqual(doc.getElementById('about-copy').textContent, EN.aboutCopyFailed);
  assert.strictEqual(doc.getElementById('about-copy-status').textContent, EN.aboutCopyFailed);
  AD.close();

  const throws = makeHost({ copyText: async () => { throw new Error('denied'); } });
  await AD.open(throws.host);
  doc.getElementById('about-copy').click();
  await settle();
  assert.strictEqual(doc.getElementById('about-copy').textContent, EN.aboutCopyFailed);
  AD.close();
});

test('links open through the host (never navigate the app window)', async () => {
  const { host, calls } = makeHost();
  await AD.open(host);
  const a = body().find((n) => n.hasClass('about-link'));
  const ev = a.fire('click');
  assert.ok(ev.defaultPrevented, 'the click does not navigate');
  assert.deepStrictEqual(calls.external, ['https://github.com/youshinh/md-memo']);
  AD.close();
});

test('the Japanese dialog reads Japanese: no English sentence is left in the strings it shows', async () => {
  const { host } = makeHost({ t: tOf(JA), language: 'ja' });
  await AD.open(host);
  const t = text();
  for (const k of ['aboutVersion', 'aboutSecUpdates', 'aboutSecFolders', 'aboutSecLicense', 'aboutUpdateIdleOn', 'aboutUpdatesNote', 'aboutCheckNow', 'aboutFolderSettings', 'aboutFolderNotes']) {
    assert.ok(t.includes(JA[k].replace('{version}', '1.10.5')), k);
  }
  AD.close();
});

pending.then(() => console.log('All about dialog tests PASSED!'), (e) => { console.error(e); process.exit(1); });
