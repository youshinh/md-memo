package dropzone

import (
	"bytes"
	"encoding/json"
	"html/template"
	"strings"
)

// pageTemplate is the entire mobile web UI: a single, self-contained page
// with inline CSS and JS (no external CDN — it must work on an offline
// LAN). It is rendered once per Server with the one-time token baked in, so
// the phone never has to type or re-enter it.
var pageTemplate = template.Must(template.New("dropzone").Parse(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>MD-Memo Mobile Drop</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 40px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
    background: #f4f3ef; color: #2b2a26;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.hint { font-size: 13px; color: #6b6a63; margin: 0 0 20px; line-height: 1.5; }
  .card {
    background: #fff; border: 1px solid #e2e0d8; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 14px;
  }
  .card h2 { font-size: 14px; margin: 0 0 10px; }
  .card h2 svg { width: 16px; height: 16px; vertical-align: -3px; margin-right: 6px; }
  input[type="file"] { width: 100%; font-size: 13px; }
  textarea {
    width: 100%; font-size: 14px; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #d8d6cc; resize: vertical; font-family: inherit;
  }
  button {
    margin-top: 10px; width: 100%; padding: 10px; font-size: 14px; font-weight: 600;
    border: none; border-radius: 6px; background: #5c7a4f; color: #fff; cursor: pointer;
  }
  button:active { opacity: 0.85; }
  #status { min-height: 20px; font-size: 13px; margin-bottom: 14px; }
  #status.ok { color: #2f7a3c; }
  #status.err { color: #b3392b; }
  .spinner {
    width: 22px; height: 22px; border-radius: 50%;
    border: 3px solid #d8d6cc; border-top-color: #5c7a4f;
    animation: spin 0.7s linear infinite; margin: 0 auto;
  }
  .hidden { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1d1a; color: #e8e6dd; }
    .card { background: #2a2925; border-color: #3c3a34; }
    textarea { background: #201f1c; color: #e8e6dd; border-color: #3c3a34; }
    p.hint { color: #9a988e; }
  }
</style>
</head>
<body>
  <h1>MD-Memo — Mobile Drop</h1>
  <p class="hint">PCのアクティブなメモに追記します。送信は一度きり、60秒操作がないと自動的に無効になります。<br>Sends straight into your PC's active note. One submission only — this link expires after 60s of inactivity.</p>

  <div id="status"></div>
  <div id="spinner" class="spinner hidden"></div>

  <div class="card">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>写真を撮る / Take or choose a photo</h2>
    <input type="file" id="photoInput" accept="image/*" capture="environment">
  </div>

  <div class="card">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>テキスト・URL / Text or URL</h2>
    <textarea id="textInput" rows="4" placeholder="メモやURLを貼り付け... / Paste a note or URL..."></textarea>
    <button id="sendTextBtn" type="button">送信 / Send</button>
  </div>

  <div class="card">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>ファイル / File</h2>
    <input type="file" id="fileInput" accept=".md,.markdown,.txt,.html,.htm,.js,.mjs,.cjs,.ts,.tsx,.jsx,.json,.css,.py,.java,.c,.h,.cpp,.rb,.php,.sh,.yaml,.yml,.xml,.sql,.rs">
  </div>

<script>
(function () {
  "use strict";
  var TOKEN = {{.TokenJSON}};
  var statusEl = document.getElementById('status');
  var spinnerEl = document.getElementById('spinner');
  var done = false;

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = cls || '';
  }

  function showSpinner(show) {
    spinnerEl.classList.toggle('hidden', !show);
  }

  function lockUI() {
    done = true;
    document.querySelectorAll('input, button, textarea').forEach(function (el) {
      el.disabled = true;
    });
  }

  function afterSuccess() {
    setStatus('PCのMD-Memoに送信しました。まもなく反映されます。このページを閉じてください。 / Sent to MD-Memo on your PC — it will appear there shortly. You can close this page now.', 'ok');
    lockUI();
  }

  function afterFailure(msg) {
    setStatus('送信に失敗しました: / Failed to send: ' + msg, 'err');
  }

  function sendFile(inputEl) {
    if (done || !inputEl.files || !inputEl.files.length) return;
    var file = inputEl.files[0];
    var fd = new FormData();
    fd.append('token', TOKEN);
    fd.append('file', file, file.name);
    showSpinner(true);
    setStatus('送信中... / Sending...', '');
    fetch('/upload?token=' + encodeURIComponent(TOKEN), { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        afterSuccess();
      })
      .catch(function (err) { afterFailure(err.message); })
      .finally(function () { showSpinner(false); });
  }

  document.getElementById('photoInput').addEventListener('change', function (e) { sendFile(e.target); });
  document.getElementById('fileInput').addEventListener('change', function (e) { sendFile(e.target); });

  document.getElementById('sendTextBtn').addEventListener('click', function () {
    if (done) return;
    var text = document.getElementById('textInput').value;
    if (!text.trim()) return;
    showSpinner(true);
    setStatus('送信中... / Sending...', '');
    fetch('/upload-text?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'text=' + encodeURIComponent(text)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        afterSuccess();
      })
      .catch(function (err) { afterFailure(err.message); })
      .finally(function () { showSpinner(false); });
  });
})();
</script>
</body>
</html>
`))

// pageData is the template context for pageTemplate.
type pageData struct {
	// TokenJSON is the one-time token, already JSON/JS-string-encoded so it
	// can be dropped straight into `var TOKEN = {{.TokenJSON}};` safely.
	TokenJSON template.JS
}

// jsStringLiteral encodes s as a valid, self-contained JavaScript string
// literal (double-quoted JSON), additionally escaping "</" so the token can
// never be used to prematurely close the surrounding <script> tag. The
// token itself is always server-generated hex, but this keeps the helper
// safe for any input.
func jsStringLiteral(s string) (string, error) {
	encoded, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(string(encoded), "</", "<\\/"), nil
}

// renderPage renders the mobile web UI with the given one-time token baked
// in as a JS string literal.
func renderPage(token string) (string, error) {
	encoded, err := jsStringLiteral(token)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := pageTemplate.Execute(&buf, pageData{TokenJSON: template.JS(encoded)}); err != nil {
		return "", err
	}
	return buf.String(), nil
}
