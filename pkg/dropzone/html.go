package dropzone

import (
	"encoding/json"
	"strings"
)

// pageSource is the entire mobile web UI: a single, self-contained page
// with inline CSS and JS (no external CDN — it must work on an offline
// LAN). It is rendered once per Server with the one-time token baked in, so
// the phone never has to type or re-enter it.
const pageSource = `<!DOCTYPE html>
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
  /* The native file inputs stay in the DOM (labels open them) but are not drawn: their own
     "choose file" button reads as a file picker even when it is meant to open the camera. */
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .button-row { display: flex; gap: 8px; }
  .button-row .action { margin: 0; }
  .action {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 12px; font-size: 14px; font-weight: 600;
    border-radius: 6px; background: #5c7a4f; color: #fff; cursor: pointer;
    -webkit-tap-highlight-color: transparent; border: none;
  }
  .action:active { opacity: 0.85; }
  .action.disabled { opacity: 0.5; pointer-events: none; }
  .action svg { width: 18px; height: 18px; flex: none; }
  .action.secondary { background: #7a6f4f; margin-top: 10px; }
  p.note { font-size: 12px; color: #6b6a63; margin: 8px 0 0; line-height: 1.4; }
  textarea {
    width: 100%; font-size: 14px; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #d8d6cc; resize: vertical; font-family: inherit;
  }
  button {
    margin-top: 10px; width: 100%; padding: 10px; font-size: 14px; font-weight: 600;
    border: none; border-radius: 6px; background: #5c7a4f; color: #fff; cursor: pointer;
  }
  button:active { opacity: 0.85; }
  button:disabled { opacity: 0.5; }
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
  .shared-text {
    font-size: 13px; background: #f4f3ef; border: 1px solid #e2e0d8; border-radius: 6px;
    padding: 8px 10px; margin-bottom: 10px; word-break: break-word; white-space: pre-wrap;
    max-height: 90px; overflow-y: auto;
  }
  .tray-list { list-style: none; margin: 0 0 8px; padding: 0; }
  .tray-item {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 13px; padding: 7px 0; border-bottom: 1px solid #ece9e0;
  }
  .tray-item:last-child { border-bottom: none; }
  .tray-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tray-remove {
    margin: 0; width: 26px; height: 26px; flex: none; padding: 0;
    font-size: 14px; line-height: 26px; border-radius: 50%;
    background: #e2e0d8; color: #2b2a26;
  }
  .progress-wrap { height: 6px; border-radius: 3px; background: #e2e0d8; margin-top: 10px; overflow: hidden; }
  .progress-bar { height: 100%; width: 0%; background: #5c7a4f; }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1d1a; color: #e8e6dd; }
    .card { background: #2a2925; border-color: #3c3a34; }
    textarea { background: #201f1c; color: #e8e6dd; border-color: #3c3a34; }
    p.hint, p.note { color: #9a988e; }
    .shared-text { background: #201f1c; border-color: #3c3a34; }
    .tray-item { border-color: #3c3a34; }
    .tray-remove { background: #3c3a34; color: #e8e6dd; }
    .progress-wrap { background: #3c3a34; }
  }
</style>
</head>
<body>
  <h1>MD-Memo — Mobile Drop</h1>
  <p class="hint">PCのアクティブなメモに追記します。送信は一度きり、操作がないと自動的に無効になります。<br>Sends straight into your PC's active note. One submission only — this link expires after a period of inactivity.</p>

  <div id="status" aria-live="polite"></div>
  <div id="spinner" class="spinner hidden"></div>

  <div class="card hidden" id="sharedCard">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>PCからのテキスト / Text from PC</h2>
    <div id="sharedText" class="shared-text"></div>
    <button type="button" id="copySharedBtn" class="action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>タップしてコピー / Tap to copy</span></button>
  </div>

  <div class="card">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>PCへ送信トレイ / Send tray (<span id="trayCount">0</span>)</h2>
    <ul id="trayList" class="tray-list"></ul>
    <p class="note" id="trayEmptyNote">まだ何も追加されていません / Nothing added yet</p>
  </div>

  <div class="card">
    <div class="button-row">
      <label class="action" for="photoInput"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>カメラで撮影 / Take a photo</span></label>
      <label class="action" for="fileInput"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>ファイルを選択（複数可） / Choose files</span></label>
    </div>
    <input type="file" id="photoInput" class="sr-only" accept="image/*" capture="environment">
    <input type="file" id="fileInput" class="sr-only" accept="image/*,.md,.markdown,.txt,.html,.htm,.js,.mjs,.cjs,.ts,.tsx,.jsx,.json,.css,.py,.java,.c,.h,.cpp,.rb,.php,.sh,.yaml,.yml,.xml,.sql,.rs" multiple>
    <p class="note">ライブラリの写真、または .md .txt などのテキストファイル（複数選択可）<br>Photos from your library, or text files such as .md or .txt (multiple selection allowed)</p>
    <button type="button" id="voiceBtn" class="action secondary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg><span id="voiceLabel">押して録音 / Record voice</span></button>
    <div id="voiceFallbackWrap">
      <label class="action secondary" for="voiceFallbackInput"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg><span>音声を録音 / Record voice</span></label>
    </div>
    <input type="file" id="voiceFallbackInput" class="sr-only" accept="audio/*" capture>
  </div>

  <div class="card">
    <h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>テキスト・URL / Text or URL</h2>
    <textarea id="textInput" rows="3" placeholder="メモやURLを貼り付け... / Paste a note or URL..."></textarea>
  </div>

  <button id="sendAllBtn" type="button">まとめてPCへ送信 / Send all</button>
  <div id="progressWrap" class="progress-wrap hidden"><div id="progressBar" class="progress-bar"></div></div>

<script>
(function () {
  "use strict";
  var TOKEN = __MD_MEMO_TOKEN__;
  var statusEl = document.getElementById('status');
  var spinnerEl = document.getElementById('spinner');
  var done = false;
  var tray = [];
  var voiceCounter = 0;
  var lastPingAt = 0;
  var sharedPollId = null;
  var sharedSeenRev = -1;
  var geoLat = null;
  var geoLon = null;

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
    document.querySelectorAll('.action').forEach(function (el) {
      el.classList.add('disabled');
    });
    stopSharedPolling();
  }

  function afterSuccess() {
    setStatus('PCのMD-Memoに送信しました。まもなく反映されます。このページを閉じてください。 / Sent to MD-Memo on your PC — it will appear there shortly. You can close this page now.', 'ok');
    lockUI();
  }

  function afterFailure(msg) {
    setStatus('送信に失敗しました: / Failed to send: ' + msg, 'err');
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function pingActivity() {
    var now = Date.now();
    if (now - lastPingAt < 10000) return;
    lastPingAt = now;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/ping?token=' + encodeURIComponent(TOKEN), true);
    xhr.onerror = function () {};
    xhr.send();
  }

  function renderTray() {
    var list = document.getElementById('trayList');
    list.innerHTML = '';
    for (var i = 0; i < tray.length; i++) {
      (function (idx) {
        var file = tray[idx];
        var li = document.createElement('li');
        li.className = 'tray-item';
        var label = document.createElement('span');
        label.className = 'tray-item-name';
        label.textContent = file.name + ' (' + humanSize(file.size) + ')';
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'tray-remove';
        removeBtn.setAttribute('aria-label', '削除 / Remove ' + file.name);
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', function () {
          if (done) return;
          tray.splice(idx, 1);
          renderTray();
          pingActivity();
        });
        li.appendChild(label);
        li.appendChild(removeBtn);
        list.appendChild(li);
      })(i);
    }
    document.getElementById('trayCount').textContent = String(tray.length);
    document.getElementById('trayEmptyNote').classList.toggle('hidden', tray.length !== 0);
  }

  function addFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      tray.push(fileList[i]);
    }
    renderTray();
    pingActivity();
  }

  document.getElementById('photoInput').addEventListener('change', function (e) {
    if (done) return;
    addFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('fileInput').addEventListener('change', function (e) {
    if (done) return;
    addFiles(e.target.files);
    e.target.value = '';
  });

  // Voice: record in-page when the platform supports it (secure context + MediaRecorder);
  // otherwise fall back to the OS's own recorder via <input capture>. A plain-HTTP LAN page
  // is never a secure context, so the fallback is what phones see there.
  var canRecordInPage = !!(window.isSecureContext && navigator.mediaDevices && window.MediaRecorder);
  var voiceBtn = document.getElementById('voiceBtn');
  var voiceLabel = document.getElementById('voiceLabel');
  var voiceFallbackWrap = document.getElementById('voiceFallbackWrap');
  var voiceFallbackInput = document.getElementById('voiceFallbackInput');
  var mediaRecorder = null;
  var recordedChunks = [];
  var recording = false;
  var recordStartedAt = 0;
  var recordTimerId = null;

  if (canRecordInPage) {
    voiceFallbackWrap.classList.add('hidden');
    voiceFallbackInput.disabled = true;
    voiceBtn.addEventListener('click', function () {
      if (done) return;
      if (!recording) { startRecording(); } else { stopRecording(); }
    });
  } else {
    voiceBtn.classList.add('hidden');
    voiceBtn.disabled = true;
    voiceFallbackInput.addEventListener('change', function (e) {
      if (done) return;
      if (e.target.files && e.target.files.length) {
        addFiles(e.target.files);
      }
      e.target.value = '';
    });
  }

  function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recordedChunks = [];
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        setStatus('録音を開始できません / Cannot start recording', 'err');
        return;
      }
      mediaRecorder.addEventListener('dataavailable', function (e) {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearRecordTimer();
        recording = false;
        voiceLabel.textContent = '押して録音 / Record voice';
        var blob = new Blob(recordedChunks, { type: 'audio/webm' });
        if (blob.size > 0) {
          voiceCounter++;
          var name = 'voice_note_' + voiceCounter + '.webm';
          var file;
          try {
            file = new File([blob], name, { type: 'audio/webm' });
          } catch (e) {
            file = blob;
            file.name = name;
          }
          tray.push(file);
          renderTray();
        }
        pingActivity();
      });
      mediaRecorder.start();
      recording = true;
      recordStartedAt = Date.now();
      updateRecordTimer();
      recordTimerId = setInterval(updateRecordTimer, 500);
      pingActivity();
    }).catch(function () {
      setStatus('マイクを使用できません / Microphone unavailable', 'err');
    });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  function clearRecordTimer() {
    if (recordTimerId) { clearInterval(recordTimerId); recordTimerId = null; }
  }

  function updateRecordTimer() {
    var secs = Math.floor((Date.now() - recordStartedAt) / 1000);
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    var padded = s < 10 ? '0' + s : String(s);
    var label = m + ':' + padded;
    voiceLabel.textContent = '録音中... ' + label + ' / Recording... ' + label;
  }

  // PC -> phone shared text: polled while the page is visible, stopped once the session is
  // over (a successful send) or the page is hidden, and tolerant of 403/network errors once
  // the server has shut itself down.
  function showSharedText(text) {
    var card = document.getElementById('sharedCard');
    var box = document.getElementById('sharedText');
    if (!text) {
      card.classList.add('hidden');
      return;
    }
    box.textContent = text;
    card.classList.remove('hidden');
  }

  function pollShared() {
    if (done) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/shared?token=' + encodeURIComponent(TOKEN), true);
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var data = JSON.parse(xhr.responseText);
        if (data && data.rev !== sharedSeenRev) {
          sharedSeenRev = data.rev;
          showSharedText(data.text || '');
        }
      } catch (e) { /* malformed response: ignore, try again next tick */ }
    };
    xhr.onerror = function () {}; // the server may already be gone; fail silently
    xhr.send();
  }

  function startSharedPolling() {
    if (sharedPollId || done) return;
    pollShared();
    sharedPollId = setInterval(pollShared, 2000);
  }

  function stopSharedPolling() {
    if (sharedPollId) { clearInterval(sharedPollId); sharedPollId = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopSharedPolling();
    } else {
      startSharedPolling();
    }
  });
  startSharedPolling();

  document.getElementById('copySharedBtn').addEventListener('click', function () {
    var text = document.getElementById('sharedText').textContent;
    if (!text) return;
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('コピーしました / Copied', 'ok');
      }).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
    pingActivity();
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setStatus('コピーしました / Copied', 'ok');
    } catch (e) {
      setStatus('コピーできませんでした / Copy failed', 'err');
    }
    document.body.removeChild(ta);
  }

  // Geolocation is attempted only over HTTPS (a Cloudflare Quick Tunnel session): a plain
  // LAN page never even asks, per the spec's HTTPS-only / non-invasive requirement.
  if (location.protocol === 'https:' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function (pos) {
      geoLat = pos.coords.latitude;
      geoLon = pos.coords.longitude;
    }, function () { /* denied or unavailable: send without location */ }, { timeout: 5000 });
  }

  document.getElementById('textInput').addEventListener('input', function () {
    pingActivity();
  });

  function showProgress(show) {
    document.getElementById('progressWrap').classList.toggle('hidden', !show);
    if (!show) updateProgress(0);
  }

  function updateProgress(pct) {
    document.getElementById('progressBar').style.width = pct + '%';
  }

  document.getElementById('sendAllBtn').addEventListener('click', function () {
    if (done) return;
    var text = document.getElementById('textInput').value;
    if (tray.length === 0 && !text.replace(/^\s+|\s+$/g, '')) return;

    var fd = new FormData();
    fd.append('token', TOKEN);
    for (var i = 0; i < tray.length; i++) {
      fd.append('file', tray[i], tray[i].name);
    }
    if (text.replace(/^\s+|\s+$/g, '')) fd.append('text', text);

    showSpinner(true);
    showProgress(true);
    setStatus('送信中... / Sending...', '');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload-batch?token=' + encodeURIComponent(TOKEN), true);
    if (geoLat !== null && geoLon !== null) {
      xhr.setRequestHeader('X-Geo-Lat', String(geoLat));
      xhr.setRequestHeader('X-Geo-Lon', String(geoLon));
    }
    xhr.upload.addEventListener('progress', function (e) {
      if (e.lengthComputable) updateProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.onload = function () {
      showSpinner(false);
      showProgress(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        afterSuccess();
      } else {
        afterFailure('HTTP ' + xhr.status);
      }
    };
    xhr.onerror = function () {
      showSpinner(false);
      showProgress(false);
      afterFailure('network error');
    };
    xhr.send(fd);
  });

  renderTray();
})();
</script>
</body>
</html>
`

// tokenPlaceholder marks where the one-time token goes in pageSource. The page has exactly one
// dynamic value, so a plain substitution does the job; html/template (which this package used
// before) would have added itself, text/template and their start-up work to every launch of the
// app for that single substitution.
const tokenPlaceholder = "__MD_MEMO_TOKEN__"

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
	return strings.Replace(pageSource, tokenPlaceholder, encoded, 1), nil
}
