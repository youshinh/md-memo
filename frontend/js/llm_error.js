// Turns the raw failure of an AI request into something a person can act on. The Go client answers with one line such as
//   "ローカルLLM/API接続エラー (http://localhost:11434): Post ...: dial tcp 127.0.0.1:11434: connectex: ..."  or
//   "APIエラー (401): {"error": ...}"
// which used to be written into the note as it was. Here it is sorted into a few kinds; app.js words each kind in the UI
// language and offers Retry / AI settings, and keeps the raw line behind a "Details" fold.
(function (global) {
  'use strict';

  // kind: 'conn' (cannot reach the server), 'auth' (401 / 403 / a rejected key), 'model' (404 / model not found),
  // 'timeout', 'rate' (429 / quota), 'server' (5xx), 'other'. status is the HTTP status when the line carries one.
  function classify(errorText) {
    const s = String(errorText == null ? '' : errorText);
    const m = s.match(/\((\d{3})\)/) || s.match(/\bstatus(?: code)?[:= ]+(\d{3})\b/i);
    const status = m ? parseInt(m[1], 10) : null;

    if (status === 401 || status === 403 || /api key|apikey|unauthori[sz]ed|invalid[_ ]?key|permission denied|forbidden/i.test(s)) {
      return { kind: 'auth', status: status };
    }
    if (status === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/i.test(s)) {
      return { kind: 'rate', status: status };
    }
    if (status === 404 || /model.{0,40}not found|not found.{0,40}model|no such model|unknown model/i.test(s)) {
      return { kind: 'model', status: status };
    }
    if (status !== null && status >= 500 && status <= 599) {
      return { kind: 'server', status: status };
    }
    if (/timeout|timed out|deadline exceeded|タイムアウト|秒以内|終わりませんでした/i.test(s)) {
      return { kind: 'timeout', status: status };
    }
    if (/接続エラー|connectex|connection refused|actively refused|dial tcp|no such host|network is unreachable|connection reset|unexpected eof|\bEOF\b|refused/i.test(s)) {
      return { kind: 'conn', status: status };
    }
    return { kind: 'other', status: status };
  }

  // The authority of a base URL split the way the sender (Go's net/url) splits it: it ends at the first / ? or #, the user part
  // ends at the LAST @ (a password may hold one), and the port is the digits after the last colon. A bare "host:port/path" has no
  // scheme. Returns { host (lower case, IPv6 in brackets), port } or null when there is no usable host. It reads the text itself
  // (no URL object) so the answer is the same in every page and test, and "10.evil.example" or "10.0.0.1@evil.example" cannot
  // pass for an address: only a whole dotted-decimal IPv4 is one.
  function parseBase(baseUrl) {
    let rest = String(baseUrl == null ? '' : baseUrl).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#][\s\S]*$/, '');
    if (rest.indexOf('\\') !== -1) return null; // a browser reads "\" as "/", Go rejects it: nobody agrees, so it is never local
    const at = rest.lastIndexOf('@');
    if (at !== -1) rest = rest.slice(at + 1);
    let host = rest;
    let port = '';
    if (rest.charAt(0) === '[') {
      const close = rest.indexOf(']');
      if (close === -1) return null;
      host = rest.slice(0, close + 1);
      const after = rest.slice(close + 1);
      if (after !== '') {
        if (!/^:\d*$/.test(after)) return null;
        port = after.slice(1);
      }
      if (!/^\[[0-9a-f:.]+\]$/i.test(host)) return null;
    } else {
      const colon = rest.lastIndexOf(':');
      if (colon !== -1) {
        host = rest.slice(0, colon);
        port = rest.slice(colon + 1);
        if (!/^\d*$/.test(port)) return null;
      }
      if (!/^[^\s:@\\\[\]]+$/.test(host)) return null;
    }
    return { host: host.toLowerCase(), port: port };
  }

  // "http://localhost:11434/v1" -> "localhost:11434". Lower case, and never with the user:password@ part: this text is shown in
  // the bar, in messages and in the list of allowed hosts, and used as the key of an allowed host.
  function hostOf(baseUrl) {
    const s = String(baseUrl == null ? '' : baseUrl).trim();
    if (!s) return '';
    const p = parseBase(s);
    if (p) return p.host + (p.port ? ':' + p.port : '');
    // Not an address that can be read: still no credentials in what comes back.
    const rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#][\s\S]*$/, '');
    return rest.slice(rest.lastIndexOf('@') + 1);
  }

  // True for a model server on this computer or the local network: no key is needed there and "is it running?" is the question.
  // The host has to BE local: "localhost", a name ending in .local / .localhost, ::1, or a complete IPv4 address in 127/8, 10/8,
  // 172.16/12 or 192.168/16. A name that only starts like an address (10.evil.example) or hides one in the user part
  // (http://10.0.0.1@evil.example) is a public host. What cannot be read is treated as public.
  function isLocal(baseUrl) {
    if (!String(baseUrl == null ? '' : baseUrl).trim()) return true; // nothing configured falls back to the local default
    const p = parseBase(baseUrl);
    if (!p) return false;
    const host = p.host;
    if (host === 'localhost' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    return o[0] === 127 || o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
  }

  // One line, at most `max` characters: providers answer with multi-line JSON.
  function oneLine(errorText, max) {
    const s = String(errorText == null ? '' : errorText).replace(/\s+/g, ' ').trim();
    const limit = max || 300;
    return s.length > limit ? s.substring(0, limit) + '…' : s;
  }

  // The error text with anything that is a secret taken out. A cloud request that fails carries the address it called, and that
  // address holds the API key (Gemini: ".../models/x:generateContent?key=AIza..."); a server may also echo a token back. The text
  // ends up in the note, in toasts, in the task list and in the ask bar's Details, and from the note on the disk, so every place
  // that shows an error goes through here first. `secrets` are further exact strings to remove (the keys in the settings).
  const KEY_PARAM = /([?&;](?:key|api[_-]?key|apikey|access[_-]?token|token)=)[^&\s"'<>)\]]+/gi;
  const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{16,}/g;
  const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
  const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
  function redact(errorText, secrets) {
    let s = String(errorText == null ? '' : errorText);
    if (Array.isArray(secrets)) {
      for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 6) s = s.split(secret).join('***');
      }
    }
    return s.replace(KEY_PARAM, '$1***').replace(GOOGLE_KEY, '***').replace(BEARER, '$1***').replace(SK_KEY, '***');
  }

  const api = { classify: classify, hostOf: hostOf, isLocal: isLocal, oneLine: oneLine, redact: redact };
  global.LlmError = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
