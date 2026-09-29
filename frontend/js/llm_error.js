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

  // "http://localhost:11434/v1" -> "localhost:11434"; a bare host stays as it is.
  function hostOf(baseUrl) {
    const s = String(baseUrl == null ? '' : baseUrl).trim();
    if (!s) return '';
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    return m ? m[1] : s.replace(/\/.*$/, '');
  }

  // True for a model server on this computer or the local network: no key is needed there and "is it running?" is the question.
  function isLocal(baseUrl) {
    const host = hostOf(baseUrl).replace(/:\d+$/, '').toLowerCase();
    if (!host) return true; // nothing configured falls back to the local default
    if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }

  // One line, at most `max` characters: providers answer with multi-line JSON.
  function oneLine(errorText, max) {
    const s = String(errorText == null ? '' : errorText).replace(/\s+/g, ' ').trim();
    const limit = max || 300;
    return s.length > limit ? s.substring(0, limit) + '…' : s;
  }

  const api = { classify: classify, hostOf: hostOf, isLocal: isLocal, oneLine: oneLine };
  global.LlmError = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
