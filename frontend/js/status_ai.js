// The AI item of the status bar. The bar used to carry three separate one-click badges for the AI helpers (Predict, Action,
// Mic: Refine): internal names, a click flipped them with no feedback, and none of them said whether a model was there at
// all. They are now ONE item, "AI: local" / "AI: cloud" / "AI: not set up", and a small popover behind it holds the three
// helpers as real switches with plain names:
//
//   Text prediction   the grey ghost text while typing        (config.autocomplete.enabled)
//   Suggestions       Quick Actions; "only when I press Ctrl+J" is its manual mode   (config.action.enabled / manualOnly)
//   Voice tidy-up     the second stage of voice input          (config.voice.refine.enabled)
//
// Rules (docs/design/panel-template.md, settings-dialog.md): the popover is a panel (bg-modal, 1px border, 8px radius, the one
// panel shadow), its label is bright-accent text with a divider, rows are 36px, switches are 32 x 18, the one button is 28px.
// It opens on click / Enter / Space and closes on Esc, on a press outside and when focus leaves it. When no model can answer,
// the item is amber and a click goes straight to Settings > AI Models instead (there is nothing to switch yet).
//
// Cost: the popover is built the first time it opens, so an unused item costs one text update per config change. Nothing
// listens on the document while it is closed.
//
// This module only draws and reports clicks; the toggles themselves (config, timers, settings check boxes, saving, the toast)
// stay in app.js, which passes them in through init().
(function (global) {
  'use strict';

  const TRIGGER_ID = 'stat-ai';
  const POP_ID = 'status-ai-pop';
  const POP_WIDTH = 320;
  const GAP = 6;
  const MARGIN = 8;

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // The host part of a base URL, lower case, without scheme, credentials, port or path ("" when there is none).
  function hostOf(baseUrl) {
    let s = String(baseUrl == null ? '' : baseUrl).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0];
    s = s.slice(s.lastIndexOf('@') + 1); // the credentials end at the LAST @ (a password may hold one)
    if (s.charAt(0) === '[') {
      const end = s.indexOf(']');
      return end === -1 ? s.slice(1) : s.slice(1, end);
    }
    if (s.indexOf(':') !== s.lastIndexOf(':')) return s; // a bare IPv6 literal
    return s.replace(/:\d*$/, '');
  }

  // True for a model server on this computer or the local network: the same rule as LlmError.isLocal (the ask bar's), used
  // only when that module is not loaded.
  function fallbackIsLocal(baseUrl) {
    const host = hostOf(baseUrl);
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || /\.(local|localhost)$/.test(host)) return true;
    // Only a COMPLETE IPv4 address is tested against the private ranges: 10.evil.example is a public name, not the 10.x network.
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    if (o.some(function (n) { return n > 255; })) return false;
    return o[0] === 127 || o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
  }

  // What the item says about the text model. `configured` is the app's own answer (isLlmConfigured): nothing is guessed here.
  //   { kind: 'unset' }                      no model can answer
  //   { kind: 'local' | 'cloud', model }     where it runs
  function modelState(cfg, configured, isLocalFn) {
    if (!configured) return { kind: 'unset', model: '' };
    const text = (cfg && cfg.text) || {};
    const local = typeof isLocalFn === 'function' ? isLocalFn : fallbackIsLocal;
    return { kind: local(text.baseUrl) ? 'local' : 'cloud', model: String(text.model == null ? '' : text.model).trim() };
  }

  // The three helpers as the popover shows them. Read defensively: an old config file lacks whole groups.
  function optionStates(cfg) {
    const c = cfg || {};
    const suggestOn = !(c.action && c.action.enabled === false);
    return {
      prediction: !!(c.autocomplete && c.autocomplete.enabled),
      suggestions: suggestOn,
      suggestionsManual: suggestOn && !!(c.action && c.action.manualOnly),
      voice: !(c.voice && c.voice.refine && c.voice.refine.enabled === false)
    };
  }

  // How the item looks and what its tooltip says. `predict` is the last text-prediction outcome ({ state: 'error', message }).
  // The keys are i18n keys; the caller translates. `opensSettings` is true when a click should skip the popover.
  function itemView(state, predict) {
    if (state.kind === 'unset') {
      return { level: 'unset', labelKey: 'statAiNotSet', titleKey: 'statAiTitleNotSet', titleVars: {}, opensSettings: true };
    }
    if (predict && predict.state === 'error') {
      return { level: 'error', labelKey: 'statAiError', titleKey: 'statAiTitleError', titleVars: { error: predict.message || '' }, opensSettings: false };
    }
    return {
      level: 'ok',
      labelKey: state.kind === 'local' ? 'statAiLocal' : 'statAiCloud',
      titleKey: state.kind === 'local' ? 'statAiTitleLocal' : 'statAiTitleCloud',
      titleVars: { model: state.model },
      opensSettings: false
    };
  }

  // Where the popover goes: its right edge on the trigger's right edge, just above the status bar, and never off the window.
  // Returns CSS px for `right` and `bottom` of a position:fixed box, and the width it will have.
  function place(triggerRect, viewport, popWidth) {
    const vw = viewport.width;
    const width = Math.min(popWidth, Math.max(0, vw - 2 * MARGIN));
    let right = vw - triggerRect.right;
    if (right < MARGIN) right = MARGIN;
    if (vw - right - width < MARGIN) right = Math.max(MARGIN, vw - width - MARGIN);
    return { right: right, bottom: viewport.height - triggerRect.top + GAP, width: width };
  }

  // A message on one line, at most `max` characters (a provider's error can be several lines of JSON).
  function oneLine(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  // Where Tab goes next among `count` controls of the popover (it wraps: the popover keeps focus until Esc).
  function nextIndex(count, index, delta) {
    if (count <= 0) return -1;
    if (index < 0) return delta < 0 ? count - 1 : 0;
    return (index + delta + count) % count;
  }

  // ---- controller ---------------------------------------------------------------------------

  // create(deps) -> { refresh, open, close, toggle, isOpen, setPredict }
  //   deps.t(key, vars)          translation
  //   deps.getConfig()           the live config object
  //   deps.isConfigured()        can a text model answer? (isLlmConfigured)
  //   deps.getManualKey()        the key that shows suggestions by hand, for the sub-switch label ("Ctrl+J")
  //   deps.actions.prediction / suggestions / suggestionsManual / voice   flip one helper (toast and saving included)
  //   deps.actions.openSettings  open Settings on the AI Models tab
  //   deps.doc / deps.win        test seams
  function create(deps) {
    const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    const win = deps.win || (typeof window !== 'undefined' ? window : null);
    const t = deps.t;
    const trigger = doc && doc.getElementById(TRIGGER_ID);
    if (!trigger) {
      const noop = function () {};
      return { refresh: noop, open: noop, close: noop, toggle: noop, isOpen: function () { return false; }, setPredict: noop, inert: true };
    }
    const isLocalFn = deps.isLocal || (global.LlmError && global.LlmError.isLocal) || null;

    let pop = null;
    let parts = null; // the popover's parts, once built
    let open = false;
    let predict = { state: 'ok', message: '' };
    let view = null;
    let lastKey = '';

    function state() {
      return modelState(deps.getConfig(), !!deps.isConfigured(), isLocalFn);
    }

    function setText(node, text) {
      if (node && node.textContent !== text) node.textContent = text;
    }

    function setAttr(node, name, value) {
      if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
    }

    // ---- the item in the bar

    function drawItem() {
      const st = state();
      view = itemView(st, predict);
      // The words, not just their keys: a change of the UI language changes the words behind the same keys.
      const label = t(view.labelKey);
      const title = t(view.titleKey, view.titleVars);
      const key = [view.labelKey, label, title, open, predict.state === 'busy'].join('|');
      if (key !== lastKey) {
        lastKey = key;
        setText(trigger, label);
        trigger.title = title;
        trigger.classList.toggle('status-ai-unset', view.level === 'unset');
        trigger.classList.toggle('status-ai-error', view.level === 'error');
        setAttr(trigger, 'data-busy', predict.state === 'busy' ? '1' : '0');
        // Not set up: a click opens Settings, so it is a plain button; otherwise it opens the popover.
        if (view.opensSettings) trigger.removeAttribute('aria-haspopup');
        else setAttr(trigger, 'aria-haspopup', 'dialog');
        setAttr(trigger, 'aria-expanded', open ? 'true' : 'false');
      }
      return st;
    }

    // ---- the popover (built on first use)

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    // One row: a button with role=switch that carries the name and a one-line hint, and the switch itself.
    function makeSwitch(id, extraClass) {
      const btn = el('button', 'status-ai-row' + (extraClass ? ' ' + extraClass : ''));
      btn.type = 'button';
      btn.id = id;
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', 'false');
      const text = el('span', 'status-ai-row-text');
      const name = el('span', 'status-ai-row-name');
      name.id = id + '-name';
      const hint = el('span', 'status-ai-row-hint');
      hint.id = id + '-hint';
      text.appendChild(name);
      text.appendChild(hint);
      const track = el('span', 'status-ai-track');
      track.setAttribute('aria-hidden', 'true');
      btn.appendChild(text);
      btn.appendChild(track);
      btn.setAttribute('aria-labelledby', name.id);
      btn.setAttribute('aria-describedby', hint.id);
      return { btn: btn, name: name, hint: hint };
    }

    function build() {
      pop = el('div', 'status-ai-pop hidden');
      pop.id = POP_ID;
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-modal', 'false');
      trigger.setAttribute('aria-controls', POP_ID);

      const head = el('div', 'status-ai-head');
      const label = el('span', 'status-ai-label');
      label.id = POP_ID + '-label';
      // The dialog is named by aria-label (drawPop: "AI options"): a labelledby on the heading "AI" would win over it
      const chip = el('span', 'status-ai-chip');
      head.appendChild(label);
      head.appendChild(chip);

      const body = el('div', 'status-ai-body');
      const prediction = makeSwitch('stat-autocomplete');
      const suggestions = makeSwitch('stat-action');
      const manual = makeSwitch('stat-action-manual', 'status-ai-sub');
      const voice = makeSwitch('stat-voice-refine');
      const error = el('div', 'status-ai-error-line hidden');
      error.setAttribute('role', 'status');
      body.appendChild(prediction.btn);
      body.appendChild(suggestions.btn);
      body.appendChild(manual.btn);
      body.appendChild(voice.btn);
      body.appendChild(error);

      const foot = el('div', 'status-ai-foot');
      const settings = el('button', 'status-ai-settings');
      settings.type = 'button';
      settings.id = 'btn-status-ai-settings';
      const hint = el('span', 'status-ai-esc');
      const kbd = el('kbd', null, 'Esc');
      const hintText = el('span');
      hint.appendChild(kbd);
      hint.appendChild(hintText);
      foot.appendChild(settings);
      foot.appendChild(hint);

      pop.appendChild(head);
      pop.appendChild(body);
      pop.appendChild(foot);
      (doc.body || doc.documentElement).appendChild(pop);

      const actions = deps.actions || {};
      const bind = function (btn, fn) {
        btn.addEventListener('click', function () {
          if (typeof fn === 'function') fn();
          drawPop();
        });
      };
      bind(prediction.btn, actions.prediction);
      bind(suggestions.btn, actions.suggestions);
      bind(manual.btn, actions.suggestionsManual);
      bind(voice.btn, actions.voice);
      settings.addEventListener('click', function () {
        close({ focus: false });
        if (typeof actions.openSettings === 'function') actions.openSettings();
      });
      pop.addEventListener('keydown', onPopKey);
      pop.addEventListener('focusout', onFocusOut);

      parts = { label: label, chip: chip, prediction: prediction, suggestions: suggestions, manual: manual, voice: voice, error: error, settings: settings, hintText: hintText };
    }

    function drawSwitch(row, on, name, hintText) {
      setAttr(row.btn, 'aria-checked', on ? 'true' : 'false');
      row.btn.classList.toggle('is-on', !!on);
      setText(row.name, name);
      setText(row.hint, hintText);
    }

    function drawPop() {
      if (!pop) return;
      const st = state();
      const opts = optionStates(deps.getConfig());
      setText(parts.label, t('aiPopTitle'));
      pop.setAttribute('aria-label', t('aiPopAria'));
      if (st.kind === 'unset') setText(parts.chip, t('askSetupNeeded'));
      else setText(parts.chip, t(st.kind === 'local' ? 'aiPopModelLocal' : 'aiPopModelCloud', { model: st.model }));
      drawSwitch(parts.prediction, opts.prediction, t('aiOptPrediction'), t('aiOptPredictionHint'));
      drawSwitch(parts.suggestions, opts.suggestions, t('aiOptSuggestions'), t('aiOptSuggestionsHint'));
      drawSwitch(parts.manual, opts.suggestionsManual, t('aiOptSuggestionsManual', { key: deps.getManualKey ? deps.getManualKey() : 'Ctrl+J' }), '');
      parts.manual.btn.classList.toggle('hidden', !opts.suggestions);
      parts.manual.hint.classList.add('hidden');
      drawSwitch(parts.voice, opts.voice, t('aiOptVoice'), t('aiOptVoiceHint'));
      if (predict.state === 'error') {
        setText(parts.error, t('aiPopPredictError', { error: predict.message || '' }));
        parts.error.classList.remove('hidden');
      } else {
        parts.error.classList.add('hidden');
      }
      setText(parts.settings, t('askErrSettings'));
      setText(parts.hintText, t('aiPopClose'));
    }

    function controls() {
      if (!pop) return [];
      return Array.prototype.filter.call(pop.querySelectorAll('button'), function (b) {
        return !b.disabled && !b.classList.contains('hidden');
      });
    }

    function onPopKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close({ focus: true });
        return;
      }
      const isTab = e.key === 'Tab';
      if (!isTab && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = controls();
      const at = list.indexOf(doc.activeElement);
      const delta = isTab ? (e.shiftKey ? -1 : 1) : (e.key === 'ArrowDown' ? 1 : -1);
      const next = nextIndex(list.length, at, delta);
      if (next >= 0 && list[next]) {
        e.preventDefault();
        list[next].focus();
      }
    }

    // Focus moved to something outside the popover (Tab cannot: it wraps; a click on another control can).
    function onFocusOut(e) {
      const to = e.relatedTarget;
      if (!open || !to) return; // a click on plain background or the window losing focus: the press handler decides
      if (pop.contains(to) || to === trigger) return;
      close({ focus: false });
    }

    // A press anywhere else closes it (the press itself still goes through). The trigger toggles on its own.
    function onDocPress(e) {
      const target = e.target;
      if (!open || !target) return;
      if ((pop && pop.contains(target)) || trigger.contains(target)) return;
      close({ focus: false });
    }

    // Esc from anywhere while it is open (focus may be back in the note after a click), before the note's own Esc handling.
    function onDocKey(e) {
      if (e.key !== 'Escape' || !open) return;
      e.preventDefault();
      e.stopPropagation();
      close({ focus: doc.activeElement === doc.body || (pop && pop.contains(doc.activeElement)) });
    }

    function onResize() {
      if (open) position();
    }

    function position() {
      if (!pop || !win) return;
      const rect = trigger.getBoundingClientRect();
      const box = place(rect, { width: win.innerWidth, height: win.innerHeight }, POP_WIDTH);
      pop.style.right = box.right + 'px';
      pop.style.bottom = box.bottom + 'px';
      pop.style.width = box.width + 'px';
    }

    function openPop() {
      if (open) return;
      if (state().kind === 'unset') {
        if (deps.actions && typeof deps.actions.openSettings === 'function') deps.actions.openSettings();
        return;
      }
      if (!pop) build();
      drawPop();
      pop.classList.remove('hidden');
      position();
      open = true;
      lastKey = '';
      drawItem();
      doc.addEventListener('pointerdown', onDocPress, true);
      doc.addEventListener('keydown', onDocKey, true);
      if (win && win.addEventListener) win.addEventListener('resize', onResize);
      const first = controls()[0];
      if (first) first.focus();
    }

    function close(opts) {
      if (!open) return;
      open = false;
      if (pop) pop.classList.add('hidden');
      doc.removeEventListener('pointerdown', onDocPress, true);
      doc.removeEventListener('keydown', onDocKey, true);
      if (win && win.removeEventListener) win.removeEventListener('resize', onResize);
      lastKey = '';
      drawItem();
      if (opts && opts.focus && trigger.focus) trigger.focus();
    }

    trigger.addEventListener('click', function () {
      if (open) close({ focus: true });
      else openPop();
    });

    return {
      // Redraw from the config: the label, and the popover if it has been built.
      refresh: function () {
        const st = drawItem();
        if (open && st.kind === 'unset') close({ focus: false });
        drawPop();
      },
      open: openPop,
      close: close,
      toggle: function () { if (open) close({ focus: true }); else openPop(); },
      isOpen: function () { return open; },
      // The last text prediction: 'busy' while a request is out, 'error' with a message, 'ok' otherwise.
      setPredict: function (stateName, message) {
        const next = { state: stateName === 'busy' || stateName === 'error' ? stateName : 'ok', message: oneLine(message, 160) };
        if (next.state === predict.state && next.message === predict.message) return;
        predict = next;
        drawItem();
        drawPop();
      }
    };
  }

  // ---- singleton for the page ---------------------------------------------------------------

  let instance = null;

  const api = {
    hostOf: hostOf,
    fallbackIsLocal: fallbackIsLocal,
    modelState: modelState,
    optionStates: optionStates,
    itemView: itemView,
    place: place,
    nextIndex: nextIndex,
    oneLine: oneLine,
    create: create,
    POP_ID: POP_ID,
    TRIGGER_ID: TRIGGER_ID,
    init: function (deps) {
      instance = create(deps);
      instance.refresh();
      return instance;
    },
    refresh: function () { if (instance) instance.refresh(); },
    setPredict: function (stateName, message) { if (instance) instance.setPredict(stateName, message); },
    open: function () { if (instance) instance.open(); },
    close: function () { if (instance) instance.close({ focus: false }); },
    isOpen: function () { return !!(instance && instance.isOpen()); }
  };

  global.StatusAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
