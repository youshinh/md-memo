// Static server for the documentation screenshots.
//
// Serves frontend/ untouched, except that "/" is an in-memory copy of index.html with a unique
// <title> and the mock backend injected. Nothing under frontend/ is ever modified, and nothing here
// talks to the real MD-Memo (no md-memo.exe, no real config, no real notes).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoot } from './data/demo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const FRONTEND = path.join(REPO, 'frontend');
const MOCK_JS = path.join(HERE, 'mock', 'backend.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Neutral diagram served for /api/image (the route the real app serves local images from).
function demoDiagramSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
<rect width="480" height="270" fill="#f4f3ef"/>
<rect x="24" y="96" width="120" height="78" rx="10" fill="#fff" stroke="#556b2f" stroke-width="3"/>
<rect x="180" y="96" width="120" height="78" rx="10" fill="#fff" stroke="#556b2f" stroke-width="3"/>
<rect x="336" y="96" width="120" height="78" rx="10" fill="#fff" stroke="#556b2f" stroke-width="3"/>
<path d="M144 135h36M300 135h36" stroke="#556b2f" stroke-width="3" fill="none"/>
<path d="M172 127l8 8-8 8M328 127l8 8-8 8" stroke="#556b2f" stroke-width="3" fill="none"/>
<text x="84" y="141" font-family="Segoe UI, sans-serif" font-size="18" text-anchor="middle" fill="#2b2a26">Phone</text>
<text x="240" y="141" font-family="Segoe UI, sans-serif" font-size="18" text-anchor="middle" fill="#2b2a26">QR scan</text>
<text x="396" y="141" font-family="Segoe UI, sans-serif" font-size="18" text-anchor="middle" fill="#2b2a26">Note</text>
<text x="240" y="40" font-family="Segoe UI, sans-serif" font-size="20" font-weight="bold" text-anchor="middle" fill="#2b2a26">Drop flow</text>
</svg>`;
}

// The phone page ships as a Go raw string (pkg/dropzone/html.go: renderPage is unexported), so it is
// read from the source file and given a fake token; no Go code runs and no server is started.
export function renderPhonePage(fakeToken) {
  const src = fs.readFileSync(path.join(REPO, 'pkg', 'dropzone', 'html.go'), 'utf8');
  const marker = 'const pageSource = `';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('pageSource not found in pkg/dropzone/html.go');
  const from = start + marker.length;
  const end = src.indexOf('`', from);
  if (end < 0) throw new Error('unterminated pageSource in pkg/dropzone/html.go');
  const page = src.slice(from, end).replace(/\r\n/g, '\n');
  const literal = JSON.stringify(fakeToken).replace(/<\//g, '<\\/');
  return page.replace('__MD_MEMO_TOKEN__', literal);
}

let phoneLang = 'en';

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function startServer({ title }) {
  const indexTemplate = () => fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '/index.html') {
      const boot = buildBoot(Object.fromEntries(url.searchParams), title);
      boot.qrDataUri = fs.readFileSync(path.join(HERE, 'data', 'qr.txt'), 'utf8').trim();
      const inject =
        '<script>window.__DOCSHOT_BOOT = ' + JSON.stringify(boot).replace(/</g, '\\u003c') + ';</script>\n' +
        '<script src="/__docshot/mock.js"></script>\n';
      let html = indexTemplate();
      html = html.replace(/<title>[^<]*<\/title>/, '<title>' + title + '</title>');
      html = html.replace('<head>', '<head>\n' + inject);
      return send(res, 200, MIME['.html'], html);
    }

    if (pathname === '/__docshot/mock.js') {
      return send(res, 200, MIME['.js'], fs.readFileSync(MOCK_JS));
    }

    if (pathname === '/__docshot/phone') {
      phoneLang = url.searchParams.get('lang') === 'ja' ? 'ja' : 'en';
      // A phone reaches the PC over plain HTTP on the LAN, which is not a secure context: the page
      // then offers the OS voice recorder instead of in-page recording. Reproduce that.
      const flag = '<script>Object.defineProperty(window, "isSecureContext", { value: false });</script>\n';
      const html = renderPhonePage('demo0000demo0000demo0000demo0000').replace('<head>', '<head>\n' + flag);
      return send(res, 200, MIME['.html'], html);
    }

    if (pathname === '/api/image') {
      return send(res, 200, 'image/svg+xml', demoDiagramSvg());
    }

    // The phone page polls these; answering them keeps its "Text from PC" card static and offline.
    if (pathname === '/shared') {
      const text = phoneLang === 'ja' ? 'API 設計を下書きする' : 'Draft the API design';
      return send(res, 200, MIME['.json'], JSON.stringify({ text, rev: 1 }));
    }
    if (pathname === '/ping') return send(res, 200, MIME['.json'], '{}');

    if (pathname.startsWith('/__docshot/')) return send(res, 404, 'text/plain', 'not found');

    const rel = pathname.replace(/^\/+/, '');
    const file = path.resolve(FRONTEND, rel);
    if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'text/plain', 'not found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, type, fs.readFileSync(file));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
