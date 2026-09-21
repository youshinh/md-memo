// The Mobile Drop phone page is a Go string (pkg/dropzone/html.go). This runs its script with
// hand-made DOM / XHR / FileReader stubs to check the parts that decide whether a recording from the
// phone's own recorder app reaches the PC: the session is held open while another app is in front,
// a picked file is copied into memory at once, and an upload that dies is retried or explained.
import fs from 'fs';
import vm from 'vm';
import assert from 'assert/strict';

const goSource = fs.readFileSync('pkg/dropzone/html.go', 'utf8').replace(/\r\n/g, '\n');
const start = goSource.indexOf('<script>') + '<script>'.length;
const end = goSource.indexOf('</script>');
assert.ok(start > 8 && end > start, 'phone page script not found in pkg/dropzone/html.go');
const script = goSource.slice(start, end).replace('__MD_MEMO_TOKEN__', '"tok"');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name}\n  ${e && e.stack ? e.stack : e}`);
  }
}

function makePage({ secure = false } = {}) {
  const elements = new Map();
  const xhrs = [];
  const readers = [];

  function makeElement(id) {
    const cls = new Set();
    const el = {
      id,
      handlers: {},
      style: {},
      textContent: '',
      value: '',
      disabled: false,
      className: '',
      children: [],
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !cls.has(c) : !!force;
          if (on) cls.add(c); else cls.delete(c);
          return on;
        },
      },
      addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
      appendChild(child) { el.children.push(child); return child; },
      setAttribute() {},
      set innerHTML(v) { el.children = []; },
      get innerHTML() { return ''; },
    };
    return el;
  }

  const document = {
    hidden: false,
    handlers: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: () => makeElement('created'),
    querySelectorAll: () => [],
    addEventListener(type, fn) { (document.handlers[type] = document.handlers[type] || []).push(fn); },
  };

  class FakeXHR {
    constructor() { this.upload = { addEventListener() {} }; this.status = 0; this.headers = {}; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
  }
  class FakeFile {
    constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = (opts && opts.type) || ''; this.size = 4; this.isCopy = true; }
  }
  class FakeBlob {
    constructor(parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; this.size = 4; this.isCopy = true; }
  }
  class FakeFormData {
    constructor() { this.entries = []; }
    append(k, v, name) { this.entries.push([k, v, name]); }
  }
  class FakeReader {
    constructor() { readers.push(this); }
    readAsArrayBuffer(file) { this.file = file; }
  }

  const context = vm.createContext({
    document,
    window: { isSecureContext: secure },
    navigator: {},
    location: { protocol: 'http:' },
    XMLHttpRequest: FakeXHR,
    File: FakeFile,
    Blob: FakeBlob,
    FormData: FakeFormData,
    FileReader: FakeReader,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
    console,
  });
  vm.runInContext(script, context);

  const el = (id) => document.getElementById(id);
  const fire = (id, type, ev) => (el(id).handlers[type] || []).forEach((fn) => fn(ev || { target: el(id) }));
  const pending = (prefix) => xhrs.filter((x) => x.url && x.url.startsWith(prefix));
  const pick = (id, file) => {
    const input = el(id);
    input.files = [file];
    (input.handlers.change || []).forEach((fn) => fn({ target: input }));
  };
  const original = (name) => ({ name, size: 107 * 1024, type: 'audio/mp4', lastModified: 1, isCopy: false });
  return { document, el, fire, pick, pending, xhrs, readers, original };
}

check('the page script parses and boots without a browser-only API', () => {
  makePage();
});

check('opening the recorder / picker asks the PC for a longer grace before the page goes to the background', () => {
  const page = makePage();
  for (const id of ['voiceFallbackInput', 'photoInput', 'fileInput']) {
    const before = page.pending('/ping').length;
    page.fire(id, 'click');
    const pings = page.pending('/ping');
    assert.equal(pings.length, before + 1, `${id}: a ping is sent on click, even right after an earlier one`);
    assert.equal(pings[pings.length - 1].url, '/ping?token=tok&grace=120');
    assert.equal(pings[pings.length - 1].method, 'POST');
  }
});

check('a picked recording is copied into memory before it can be sent, and Send waits for the copy', () => {
  const page = makePage();
  const file = page.original('voice.m4a');
  page.pick('voiceFallbackInput', file);
  assert.equal(page.readers.length, 1, 'the file is read immediately');
  assert.equal(page.readers[0].file, file);
  assert.equal(page.el('sendAllBtn').disabled, true, 'Send is disabled while the copy is being made');

  page.fire('sendAllBtn', 'click');
  assert.equal(page.pending('/upload-batch').length, 0, 'pressing Send during the read does nothing');

  page.readers[0].result = new ArrayBuffer(4);
  page.readers[0].onload();
  assert.equal(page.el('sendAllBtn').disabled, false);
  assert.equal(page.el('trayCount').textContent, '1');

  page.fire('sendAllBtn', 'click');
  const upload = page.pending('/upload-batch');
  assert.equal(upload.length, 1);
  const sent = upload[0].body.entries.filter((e) => e[0] === 'file');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].isCopy, true, 'the in-memory copy is uploaded, not the live file handle');
  assert.equal(sent[0][2], 'voice.m4a');
});

check('a file that cannot be read is reported at once instead of failing later as a network error', () => {
  const page = makePage();
  page.pick('voiceFallbackInput', page.original('voice.m4a'));
  page.readers[0].error = new Error('NotReadableError');
  page.readers[0].onerror();
  assert.match(page.el('status').textContent, /ファイルを読み取れませんでした/);
  assert.equal(page.el('trayCount').textContent, '0');
  assert.equal(page.el('sendAllBtn').disabled, false);
});

function readyToSend(page) {
  page.pick('voiceFallbackInput', page.original('voice.m4a'));
  page.readers[0].result = new ArrayBuffer(4);
  page.readers[0].onload();
  page.fire('sendAllBtn', 'click');
}

check('a dropped upload is probed, and retried once when the PC session is still alive', () => {
  const page = makePage();
  readyToSend(page);
  page.pending('/upload-batch')[0].onerror();

  const probes = page.pending('/ping').filter((x) => x.timeout === 4000);
  assert.equal(probes.length, 1, 'one liveness probe with a short timeout');
  probes[0].onload();
  assert.equal(page.pending('/upload-batch').length, 2, 'the same batch is sent again');
  assert.match(page.el('status').textContent, /再送信中/);

  page.pending('/upload-batch')[1].onerror();
  page.pending('/ping').filter((x) => x.timeout === 4000)[1].onload();
  assert.equal(page.pending('/upload-batch').length, 2, 'no third attempt');
  assert.match(page.el('status').textContent, /通信エラー/);
});

check('when the PC session is gone the page says so and does not retry', () => {
  const page = makePage();
  readyToSend(page);
  page.pending('/upload-batch')[0].onerror();
  page.pending('/ping').filter((x) => x.timeout === 4000)[0].onerror();
  assert.equal(page.pending('/upload-batch').length, 1);
  assert.match(page.el('status').textContent, /PCとの接続が切れました/);
  assert.match(page.el('status').textContent, /QR/);
});

check('coming back to the page pings the PC so an active session is not left to expire', () => {
  const page = makePage();
  assert.equal(page.pending('/ping').length, 0);
  page.document.hidden = true;
  page.document.handlers.visibilitychange.forEach((fn) => fn());
  assert.equal(page.pending('/ping').length, 0, 'nothing is sent while the page is hidden');
  page.document.hidden = false;
  page.document.handlers.visibilitychange.forEach((fn) => fn());
  const pings = page.pending('/ping');
  assert.equal(pings.length, 1);
  assert.equal(pings[0].url, '/ping?token=tok');
});

console.log(failures === 0 ? '\nAll mobile drop phone page tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
