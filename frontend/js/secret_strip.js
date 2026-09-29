// MD-Memo: the copy of the settings that this WebView keeps in its own localStorage must not hold
// credentials.
//
// The app keeps two copies of the whole settings object: the file config.json (the real one, written
// through window.backend.saveConfig and read back by syncBackendConfig, which overrides everything
// else on load) and a convenience copy in localStorage['md_notepad_config_v3'] that lets the page
// paint with the right theme and language before the backend answers. The convenience copy used to
// be the whole object, API keys and the Discord bot token included, in plain text, in the WebView's
// profile folder (readable by anything that can read the user's profile, and by a page-side script).
// It now has every secret blanked; config.json is the only place they are kept.
//
// The rule is the one the Go side applies when it exports settings (pkg/configpack/secrets.go,
// StripJSON) and config_pack.js mirrors: a STRING at, or anywhere below, a key whose name contains
// apikey, api_key, api-key, token, secret, password or passwd (case-insensitive) is blanked;
// numbers and booleans stay (autocomplete.maxTokens is a setting, not a credential); user:password@
// in an http(s) URL is removed, and so is the VALUE of a secret query parameter of one (https://host/v1?key=SECRET
// becomes https://host/v1?key=). Keep the word list and the URL rule in step with those two (secret_strip_test.js
// compares all three: the word list, and the URL cases of pkg/configpack/secrets_url_test.go).
//
// Cost model: loading this file only defines functions. Nothing runs until the settings are saved.
(function (global) {
  'use strict';

  const SECRET_WORDS = ['apikey', 'api_key', 'api-key', 'token', 'secret', 'password', 'passwd'];
  const MAX_DEPTH = 64;

  // The key the settings copy is stored under (keep in step with loadLocalConfigSync in app.js), and
  // the one an even older build wrote and the loader still prefers when it exists.
  const LOCAL_KEY = 'md_notepad_config_v3';
  const LEGACY_KEY = 'md_memo_config_v1';

  function isSecretKey(name) {
    const s = String(name === null || name === undefined ? '' : name).toLowerCase();
    for (let i = 0; i < SECRET_WORDS.length; i++) if (s.indexOf(SECRET_WORDS[i]) !== -1) return true;
    return false;
  }

  // user:password@ (or a bare token@) removed from an http(s) URL, the rest left as it is; any other
  // string is returned untouched. Same rule as StripUserinfo in pkg/configpack/secrets.go.
  function stripUserinfo(s) {
    const l = s.toLowerCase();
    let schemeEnd = 0;
    if (l.indexOf('https://') === 0) schemeEnd = 8;
    else if (l.indexOf('http://') === 0) schemeEnd = 7;
    else return s;
    const rest = s.slice(schemeEnd);
    let authEnd = rest.search(/[\/?# \t\r\n]/);
    if (authEnd < 0) authEnd = rest.length;
    const at = rest.slice(0, authEnd).lastIndexOf('@');
    return at < 0 ? s : s.slice(0, schemeEnd) + rest.slice(at + 1);
  }

  // The name of a query parameter that carries a credential (?key=..., &token=...): the few names providers use, plus anything
  // isSecretKey knows. Same rule as IsSecretParam in pkg/configpack/secrets.go.
  function isSecretParam(name) {
    let n = String(name);
    try { n = decodeURIComponent(n.replace(/\+/g, ' ')); } catch (e) { /* keep it as written */ }
    n = n.toLowerCase();
    return n === 'key' || n === 'sig' || n === 'signature' || n === 'auth' || n === 'authorization' || isSecretKey(n);
  }

  // The value of every secret-looking query parameter of an http(s) URL set to repl; the names, the other parameters, their order and
  // the #fragment stay. A value that already is repl, a parameter without "=", and anything that is not an http(s) URL are left
  // alone. Same rule as RedactQuerySecrets in pkg/configpack/secrets.go.
  function redactQuerySecrets(s, repl) {
    const l = s.toLowerCase();
    if (l.indexOf('http://') !== 0 && l.indexOf('https://') !== 0) return s;
    const q = s.indexOf('?');
    if (q < 0) return s;
    let end = s.length;
    const h = s.indexOf('#', q);
    if (h >= 0) end = h;
    const params = s.slice(q + 1, end).split('&');
    let changed = false;
    for (let i = 0; i < params.length; i++) {
      const eq = params[i].indexOf('=');
      if (eq < 0) continue;
      const name = params[i].slice(0, eq);
      if (params[i].slice(eq + 1) !== repl && isSecretParam(name)) {
        params[i] = name + '=' + repl;
        changed = true;
      }
    }
    return changed ? s.slice(0, q + 1) + params.join('&') + s.slice(end) : s;
  }

  // What an http(s) URL holds that must not be kept: user:pass@ and the value of a secret query parameter (StripURLSecrets in Go).
  function stripURLSecrets(s) {
    return redactQuerySecrets(stripUserinfo(s), '');
  }

  function walk(v, underSecret, depth) {
    if (typeof v === 'string') return underSecret ? '' : stripURLSecrets(v);
    if (depth > MAX_DEPTH) return null; // hostile nesting: drop it rather than recurse without end
    if (Array.isArray(v)) {
      return v.map((x) => walk(x === undefined || typeof x === 'function' ? null : x, underSecret, depth + 1));
    }
    if (v !== null && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach((k) => {
        const child = v[k];
        // What JSON.stringify would drop anyway; and __proto__ must never become a real assignment.
        if (k === '__proto__' || child === undefined || typeof child === 'function') return;
        out[k] = walk(child, underSecret || isSecretKey(k), depth + 1);
      });
      return out;
    }
    return v;
  }

  // A deep copy of `config` (any JSON-shaped value) with every secret string blanked. The input is
  // not modified.
  function stripSecrets(config) {
    return walk(config, false, 0);
  }

  // Writes the localStorage copy of the settings without secrets, and removes the legacy copy, whose
  // key the loader prefers and which an old build filled with the keys too. A copy that cannot be
  // written (quota) is removed instead: a stale copy from an older build must not survive with keys
  // in it. Never throws.
  function saveLocalCopy(storage, config) {
    if (!storage) return;
    try {
      storage.setItem(LOCAL_KEY, JSON.stringify(stripSecrets(config)));
    } catch (e) {
      try { storage.removeItem(LOCAL_KEY); } catch (e2) { /* nothing more to do */ }
    }
    try { storage.removeItem(LEGACY_KEY); } catch (e) { /* storage unavailable */ }
  }

  const api = { SECRET_WORDS, LOCAL_KEY, LEGACY_KEY, isSecretKey, isSecretParam, stripUserinfo, redactQuerySecrets, stripURLSecrets, stripSecrets, saveLocalCopy };

  global.SecretStrip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
