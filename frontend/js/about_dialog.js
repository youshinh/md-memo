// About MD-Memo (UX review I1): the version, the license, the folders that hold settings and notes, links, how this build is
// signed, the update check, and "Copy details" for a bug report.
//
// Cost model: loading this file only defines functions. The dialog shell is static, hidden markup (index.html #about-modal);
// its body is built when the dialog opens and emptied when it closes, so nothing runs at start-up or while typing.
//
// app.js passes a `host` when it opens the dialog:
//   t(key, params)          the UI-language string
//   getVersion()            the version app.js knows (used when the backend cannot say)
//   getInfo()               Promise of the backend's AppInfo (version, commit, builtAt, os, arch, executable, configDir,
//                           configFile, scrapDir, signing), or null when this backend has none
//   getUpdateState()        { status: 'idle'|'checking'|'current'|'newer'|'error', latest, current, url }
//   checkNow()              Promise; runs the update check and updates what getUpdateState returns
//   isCheckAtStartup()      whether the start-up check is on (general.checkUpdates)
//   openExternal(url)       opens a web page in the browser
//   openFolder(path)        Promise; opens a folder in the file manager
//   copyText(text)          Promise of whether the text reached the clipboard
//   language, userAgent     for the details text
(function (global) {
  'use strict';

  const REPO = 'https://github.com/youshinh/md-memo';
  const LINKS = Object.freeze({
    repo: REPO,
    releases: REPO + '/releases',
    issues: REPO + '/issues',
    license: REPO + '/blob/main/LICENSE',
    manual: 'https://youshinh.github.io/md-memo/'
  });

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // The release page of a version. The tag comes from a web response, so it is checked before it becomes part of a URL; anything
  // odd falls back to the list of releases.
  function releaseNotesUrl(version) {
    const v = String(version == null ? '' : version).replace(/^v/i, '').trim();
    return /^[0-9][0-9A-Za-z.+_-]{0,40}$/.test(v) ? REPO + '/releases/tag/v' + v : LINKS.releases;
  }

  // "Windows x64", "macOS arm64" from Go's GOOS / GOARCH.
  function osLabel(os, arch) {
    const names = { windows: 'Windows', darwin: 'macOS', linux: 'Linux' };
    const archs = { amd64: 'x64', '386': 'x86', arm64: 'arm64' };
    const name = names[os] || String(os || 'unknown');
    const a = archs[arch] || String(arch || '');
    return a ? name + ' ' + a : name;
  }

  // Go's signing code -> 'adhoc' (macOS, ad-hoc signed, not notarized) or 'none' (no code signature) or '' (not reported).
  function signingKind(signing) {
    if (signing === 'adhoc-not-notarized') return 'adhoc';
    if (signing === 'unsigned') return 'none';
    return '';
  }

  // The sentence the Updates row shows: { key, params, tone }. tone is 'newer' for the one that deserves attention.
  function updateLine(state, startupOn) {
    const s = state || { status: 'idle' };
    switch (s.status) {
      case 'checking': return { key: 'aboutUpdateChecking', params: {}, tone: '' };
      case 'newer': return { key: 'aboutUpdateNewer', params: { latest: s.latest, current: s.current }, tone: 'newer' };
      case 'current': return { key: 'aboutUpdateCurrent', params: { version: s.current || s.latest }, tone: '' };
      case 'error': return { key: 'aboutUpdateError', params: {}, tone: 'error' };
      default: return { key: startupOn ? 'aboutUpdateIdleOn' : 'aboutUpdateIdleOff', params: {}, tone: '' };
    }
  }

  // The text "Copy details" puts on the clipboard. Always English (the person reading a bug report may not read the reporter's
  // language) and free of anything secret: versions and paths only.
  function buildDetailsText(info, extra) {
    const i = info || {};
    const x = extra || {};
    const lines = ['MD-Memo ' + (i.version || x.version || 'unknown')];
    if (i.commit || i.builtAt) lines.push('Build: ' + [i.commit, i.builtAt].filter(Boolean).join(', '));
    if (i.os) lines.push('OS: ' + osLabel(i.os, i.arch) + ' (' + i.os + '/' + (i.arch || '?') + ')');
    if (x.userAgent) lines.push('WebView: ' + x.userAgent);
    const kind = signingKind(i.signing);
    if (kind === 'adhoc') lines.push('Signing: ad-hoc signed, not notarized (macOS)');
    else if (kind === 'none') lines.push('Signing: not code-signed');
    if (x.language) lines.push('UI language: ' + x.language);
    if (typeof x.checkAtStartup === 'boolean') lines.push('Update check at start-up: ' + (x.checkAtStartup ? 'on' : 'off'));
    if (i.executable) lines.push('Program: ' + i.executable);
    if (i.configDir) lines.push('Settings folder: ' + i.configDir);
    if (i.configFile) lines.push('Settings file: ' + i.configFile);
    if (i.scrapDir) lines.push('Daily notes folder: ' + i.scrapDir);
    return lines.join('\n') + '\n';
  }

  // ---- DOM ----------------------------------------------------------------------------------

  let current = null; // { host, info, keydown } while the dialog is open

  function doc() { return global.document; }
  function byId(id) { return doc().getElementById(id); }

  function make(tag, className, text) {
    const e = doc().createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function link(host, url, text) {
    const a = make('a', 'about-link', text);
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener');
    a.addEventListener('click', function (e) {
      e.preventDefault();
      host.openExternal(url);
    });
    return a;
  }

  function section(host, titleKey) {
    const s = make('div', 'about-section');
    s.appendChild(make('div', 'about-label', host.t(titleKey)));
    return s;
  }

  // The Updates row is built once and then only updated. Rebuilding it on every state change dropped the keyboard focus from "Check now"
  // to the page and made the status line a new element each time, so a screen reader announced nothing. Now the status line is one
  // persistent role=status element whose text changes, the button is never replaced (it is marked aria-disabled while a check runs: a
  // disabled button that has focus loses it), and the release notes button comes and goes beside it.
  function buildUpdates(host, box) {
    box.textContent = '';
    const row = make('div', 'about-row about-update-row');
    const status = make('span', 'about-status');
    status.id = 'about-update-status';
    status.setAttribute('role', 'status');
    row.appendChild(status);
    const actions = make('span', 'about-actions');
    const ui = { status: status, actions: actions, notes: null, check: null, state: null };
    const notes = make('button', 'btn-secondary', host.t('aboutReleaseNotes'));
    notes.type = 'button';
    notes.id = 'about-release-notes';
    notes.addEventListener('click', function () {
      const s = ui.state || {};
      host.openExternal(s.url || releaseNotesUrl(s.latest));
    });
    ui.notes = notes;
    const check = make('button', 'btn-secondary', host.t('aboutCheckNow'));
    check.type = 'button';
    check.id = 'about-check';
    check.addEventListener('click', function () {
      if (check.getAttribute('aria-disabled') === 'true') return;
      runCheck();
    });
    ui.check = check;
    actions.appendChild(check);
    row.appendChild(actions);
    box.appendChild(row);
    box.appendChild(make('p', 'about-note', host.t('aboutUpdatesNote')));
    box._aboutUpdates = ui;
    return ui;
  }

  function renderUpdates(host, box) {
    const ui = box._aboutUpdates || buildUpdates(host, box);
    const state = host.getUpdateState() || { status: 'idle' };
    ui.state = state;
    const line = updateLine(state, host.isCheckAtStartup());
    ui.status.className = 'about-status' + (line.tone ? ' is-' + line.tone : '');
    ui.status.textContent = host.t(line.key, line.params);
    ui.check.setAttribute('aria-disabled', state.status === 'checking' ? 'true' : 'false');
    if (state.status === 'newer') {
      if (!ui.notes.parentNode) ui.actions.insertBefore(ui.notes, ui.check);
    } else if (ui.notes.parentNode) {
      ui.notes.remove();
    }
  }

  async function runCheck() {
    const cur = current;
    if (!cur) return;
    const box = byId('about-updates');
    // Show "Checking..." while the request is out; the state object is app.js's, so it is set there.
    const p = cur.host.checkNow();
    if (box) renderUpdates(cur.host, box);
    try { await p; } catch (e) { /* the state already says what happened */ }
    if (current === cur && box) renderUpdates(cur.host, box);
  }

  function folderRow(host, keyText, path, canOpen) {
    const row = make('div', 'about-row');
    row.appendChild(make('span', 'about-key', keyText));
    const p = make('span', 'about-path', path);
    p.title = path;
    row.appendChild(p);
    if (canOpen) {
      const open = make('button', 'btn-secondary about-open', host.t('aboutOpen'));
      open.type = 'button';
      // Two rows have a button named "Open": say which folder, for a screen reader that lists the buttons by name
      open.setAttribute('aria-label', host.t('aboutOpenFolderAria', { name: keyText }));
      open.addEventListener('click', async function () {
        const old = row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('about-error') ? row.nextSibling : null;
        if (old) old.remove();
        try {
          await host.openFolder(path);
        } catch (e) {
          // The reason comes from the backend in its own language; the dialog says the one thing a person can act on.
          row.after(make('div', 'about-error', host.t('aboutOpenFailed')));
        }
      });
      row.appendChild(open);
    }
    return row;
  }

  function renderBody(host, info) {
    const body = byId('about-body');
    body.textContent = '';
    const version = (info && info.version) || host.getVersion();

    const hero = make('div', 'about-hero');
    const icon = make('img', 'about-icon');
    icon.setAttribute('src', 'app.png');
    icon.setAttribute('alt', '');
    icon.setAttribute('width', '44');
    icon.setAttribute('height', '44');
    hero.appendChild(icon);
    const names = make('div', 'about-names');
    names.appendChild(make('div', 'about-name', 'MD-Memo'));
    names.appendChild(make('div', 'about-version', host.t('aboutVersion', { version: version })));
    const sub = [];
    if (info && info.os) sub.push(osLabel(info.os, info.arch));
    if (info && info.commit) sub.push(host.t('aboutBuild', { commit: info.commit, date: info.builtAt ? String(info.builtAt).slice(0, 10) : '-' }));
    if (sub.length) names.appendChild(make('div', 'about-sub', sub.join(' · ')));
    hero.appendChild(names);
    body.appendChild(hero);

    const updates = section(host, 'aboutSecUpdates');
    const updatesBox = make('div', 'about-updates');
    updatesBox.id = 'about-updates';
    updates.appendChild(updatesBox);
    body.appendChild(updates);
    renderUpdates(host, updatesBox);

    if (info && (info.configDir || info.scrapDir)) {
      const folders = section(host, 'aboutSecFolders');
      if (info.configDir) folders.appendChild(folderRow(host, host.t('aboutFolderSettings'), info.configDir, true));
      if (info.scrapDir) folders.appendChild(folderRow(host, host.t('aboutFolderNotes'), info.scrapDir, true));
      if (info.executable) folders.appendChild(folderRow(host, host.t('aboutFolderProgram'), info.executable, false));
      body.appendChild(folders);
    }

    const license = section(host, 'aboutSecLicense');
    license.appendChild(make('p', 'about-license', host.t('aboutLicenseLine')));
    const links = make('div', 'about-links');
    links.appendChild(link(host, LINKS.repo, host.t('aboutLinkGitHub')));
    links.appendChild(link(host, LINKS.releases, host.t('aboutLinkReleases')));
    links.appendChild(link(host, LINKS.manual, host.t('aboutLinkManual')));
    links.appendChild(link(host, LINKS.issues, host.t('aboutLinkIssues')));
    links.appendChild(link(host, LINKS.license, host.t('aboutLinkLicense')));
    license.appendChild(links);
    // How this build is signed goes under the license: it is the other thing a reviewer looks for, and a section of its own costs a heading's height.
    const kind = signingKind(info && info.signing);
    if (kind) license.appendChild(make('p', 'about-note about-signing', host.t(kind === 'adhoc' ? 'aboutSignAdhoc' : 'aboutSignNone')));
    body.appendChild(license);
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = global.setTimeout(function () { reject(new Error('timeout')); }, ms);
      Promise.resolve(promise).then(function (v) { global.clearTimeout(timer); resolve(v); }, function (e) { global.clearTimeout(timer); reject(e); });
    });
  }

  function wireStatic(modal) {
    if (modal.getAttribute('data-about-wired') === '1') return;
    modal.setAttribute('data-about-wired', '1');
    const close = byId('about-close');
    const done = byId('about-done');
    const copy = byId('about-copy');
    if (close) close.addEventListener('click', function () { closeDialog(); });
    if (done) done.addEventListener('click', function () { closeDialog(); });
    if (copy) copy.addEventListener('click', function () { copyDetails(); });
    // A click on the dim area (not the card) closes it, like the command palette.
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) closeDialog(); });
  }

  let copyTimer = null;

  async function copyDetails() {
    const cur = current;
    const btn = byId('about-copy');
    if (!cur || !btn) return;
    const host = cur.host;
    const text = buildDetailsText(cur.info, {
      version: host.getVersion(),
      userAgent: host.userAgent,
      language: host.language,
      checkAtStartup: host.isCheckAtStartup()
    });
    let ok = false;
    try { ok = !!(await host.copyText(text)); } catch (e) { ok = false; }
    if (current !== cur) return;
    const said = host.t(ok ? 'aboutCopied' : 'aboutCopyFailed');
    btn.textContent = said;
    // The button's own label changes for a moment (what a sighted person sees); a hidden status line says the same to a screen reader.
    const live = byId('about-copy-status');
    if (live) live.textContent = said;
    global.clearTimeout(copyTimer);
    copyTimer = global.setTimeout(function () {
      if (current !== cur) return;
      btn.textContent = host.t('aboutCopyDetails');
      if (live) live.textContent = '';
    }, 2000);
  }

  // Opens the dialog. Resolves to true once it is on screen (false when the markup is missing).
  async function open(host) {
    const modal = byId('about-modal');
    if (!modal || !byId('about-body')) return false;
    if (current) {
      const done = byId('about-done');
      if (done) done.focus();
      return true;
    }
    const cur = { host: host, info: null, keydown: null };
    current = cur; // set first: a second call while the info is being fetched must not open a second dialog
    try {
      cur.info = await withTimeout(Promise.resolve(host.getInfo ? host.getInfo() : null), 1500);
    } catch (e) {
      cur.info = null;
    }
    if (current !== cur) return false;
    try {
      wireStatic(modal);
      renderBody(host, cur.info);
    } catch (e) {
      current = null; // a half-built dialog must not block the next attempt
      throw e;
    }
    cur.keydown = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialog();
      }
    };
    doc().addEventListener('keydown', cur.keydown, true);
    modal.classList.remove('hidden');
    const done = byId('about-done');
    if (done) done.focus();
    // The start-up check may still be running when the dialog opens: asking again joins it (no second request), and the row is
    // redrawn with its answer.
    const at = host.getUpdateState() || {};
    if (at.status === 'checking') {
      Promise.resolve(host.checkNow()).catch(function () { /* the state says what happened */ }).then(function () {
        const box = byId('about-updates');
        if (current === cur && box) renderUpdates(host, box);
      });
    }
    return true;
  }

  function isOpen() { return !!current && !!byId('about-modal') && !byId('about-modal').classList.contains('hidden'); }

  function closeDialog() {
    const cur = current;
    if (!cur) return;
    current = null;
    if (cur.keydown) doc().removeEventListener('keydown', cur.keydown, true);
    global.clearTimeout(copyTimer);
    const modal = byId('about-modal');
    if (modal) modal.classList.add('hidden');
    const body = byId('about-body');
    if (body) body.textContent = '';
    const copy = byId('about-copy');
    if (copy) copy.textContent = cur.host.t('aboutCopyDetails');
    const live = byId('about-copy-status');
    if (live) live.textContent = '';
  }

  const api = {
    open: open,
    close: closeDialog,
    isOpen: isOpen,
    LINKS: LINKS,
    releaseNotesUrl: releaseNotesUrl,
    osLabel: osLabel,
    signingKind: signingKind,
    updateLine: updateLine,
    buildDetailsText: buildDetailsText
  };
  global.AboutDialog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
