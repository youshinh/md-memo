// MD-Memo: Lessons - turn a finished agent run that went wrong into a short rule the person approves, kept in a file that the backend puts in
// front of that agent's instruction from the next run on. docs/design/lessons-2026-10.md section 7.
//
//  - The backend does the work: the excerpt that is sent and the secrets blanked out in it, the model, the checks of the proposed rules and the
//    file (window.backend.lessonPlan / lessonRun / cancelLesson / lessonSave / lessonsInfo). This file is the page's side: the request, the
//    states of the dialog, what the person edits, and the sentences.
//  - Nothing happens on its own. The dialog opens when the Lessons button of a task card is pressed, and nothing leaves this PC before
//    "Create a proposal" is pressed (and, for a cloud host, the box under it is ticked). Saving is a second press, on rules the person has read.
//  - Pure functions first (no DOM, nothing runs at load): the request, the dialog as a state machine (reduce), the rules the person edits,
//    the sentences. The dialog itself, which needs the DOM, is built only when it opens, over the hidden markup of index.html. The file is
//    loaded on the first use (app.js), so a person who never uses lessons pays nothing for it.
//  - The same panel is the small picker of the palette command "Open the lessons file" (openPicker).
(function (global) {
  'use strict';

  const MAX_RULE_CHARS = 300;  // one rule, in characters (the backend drops a longer line)
  const MAX_SAVE_RULES = 5;    // rules saved at a time
  const NOTE_MAX_CHARS = 500;  // the person's note
  const PREVIEW_CHARS = 160;   // how much of the instruction the dialog shows

  // The words an error starts with when the screen has to act on it (the same promise as the Deep search: the first word is the code).
  const KNOWN_CODES = ['model_not_configured', 'consent_required', 'plan_expired', 'cancelled', 'too_many'];

  // ---- small helpers ---------------------------------------------------------------------------------------------

  function chars(s) {
    return Array.from(String(s == null ? '' : s));
  }

  function charCount(s) {
    return chars(s).length;
  }

  function clip(s, n) {
    const a = chars(s);
    return a.length <= n ? a.join('') : a.slice(0, n).join('');
  }

  function count(n) {
    const v = Math.floor(Number(n));
    return isFinite(v) && v > 0 ? v : 0;
  }

  // The agent as the dialog calls it: the agents.yaml key when the card knows it, else the name on the card; a leading "@" (how a task is
  // written) is not part of the name.
  function agentName(task) {
    const t = task || {};
    return String(t.agentKey || t.agent || '').replace(/^@+/, '').trim();
  }

  // The start of the instruction on one line.
  function instructionPreview(text) {
    const one = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const a = chars(one);
    return a.length > PREVIEW_CHARS ? a.slice(0, PREVIEW_CHARS).join('') + '…' : one;
  }

  // ---- the request -----------------------------------------------------------------------------------------------

  // What window.backend.lessonPlan is given: what the card holds, as it is (the backend cuts it to its limits and blanks out the secrets),
  // and the note the person wrote. lang is the language the rules are written in.
  function request(task, note, lang) {
    const t = task || {};
    const code = Math.trunc(Number(t.exitCode));
    return {
      agent: agentName(t),
      instruction: String(t.instruction == null ? '' : t.instruction),
      output: String(t.output == null ? '' : t.output),
      error: String(t.error == null ? '' : t.error),
      exit_code: isFinite(code) ? code : 0,
      note: String(note == null ? '' : note).trim(),
      lang: lang === 'ja' ? 'ja' : 'en'
    };
  }

  // ---- the plan (what would be sent, and to whom) ---------------------------------------------------------------

  // The backend's answer to lessonPlan, or null when it is not one. Anything not said to be local is a cloud destination, and a consent that
  // is not said to be given is not given: a field that is missing never opens the way to send.
  function normalizePlan(raw) {
    let p = raw;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch (e) { p = null; }
    }
    if (!p || typeof p !== 'object') return null;
    const d = p.destination && typeof p.destination === 'object' ? p.destination : {};
    const s = p.sent && typeof p.sent === 'object' ? p.sent : {};
    const l = p.lessons && typeof p.lessons === 'object' ? p.lessons : {};
    return {
      planId: typeof p.plan_id === 'string' ? p.plan_id : '',
      agent: String(p.agent == null ? '' : p.agent),
      model: String(d.model == null ? '' : d.model),
      host: String(d.host == null ? '' : d.host),
      local: d.local === true,
      consentKey: String(d.consent_key || d.host || ''),
      consentGiven: d.consent_given === true,
      sent: { instruction: count(s.instruction_chars), output: count(s.output_chars), error: count(s.error_chars), note: count(s.note_chars), masked: count(s.masked) },
      lessons: { exists: l.exists === true, count: count(l.count) },
      modelConfigured: p.model_configured !== false
    };
  }

  // A host that is not this PC and has not been allowed yet: the box under the destination has to be ticked.
  function needsConsent(plan) {
    return !!plan && !plan.local && !plan.consentGiven;
  }

  function sameDestination(a, b) {
    return !!a && !!b && a.host === b.host && a.model === b.model && a.local === b.local;
  }

  // The lines of the "what will be sent" part, in the language of t. noteText is the box as it is now (it is part of what is sent).
  function planLines(plan, noteText, t, lang) {
    const fmt = function (n) { return Number(n || 0).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US'); };
    const noteChars = Math.min(charCount(String(noteText == null ? '' : noteText).trim()), NOTE_MAX_CHARS);
    return {
      sent: t('lessonsSent', { instruction: fmt(plan.sent.instruction), output: fmt(plan.sent.output), error: fmt(plan.sent.error) }),
      note: noteChars > 0 ? t('lessonsSentNote', { n: fmt(noteChars) }) : '',
      masked: plan.sent.masked > 0 ? t(plan.sent.masked === 1 ? 'lessonsMaskedOne' : 'lessonsMasked', { n: fmt(plan.sent.masked) }) : '',
      dest: plan.local ? t('lessonsDestLocal', { model: plan.model }) : t('lessonsDestCloud', { model: plan.model, host: plan.host }),
      destKind: plan.local ? 'local' : 'cloud',
      consent: needsConsent(plan) ? t('lessonsConsent', { host: plan.host }) : '',
      existing: plan.lessons.count > 0 ? t('lessonsExisting', { agent: plan.agent, n: fmt(plan.lessons.count) }) : ''
    };
  }

  // ---- the rules the person edits ------------------------------------------------------------------------------

  // One rule as a line: line breaks and tabs become spaces, the ends are trimmed, at most 300 characters.
  function cleanRule(text) {
    return clip(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), MAX_RULE_CHARS).trim();
  }

  // '' or 'marks': the rule holds a comment mark ("<!--" or "-->"), which would end the line's source comment in the file; the backend does
  // not keep such a rule, so the dialog says so and leaves it out.
  function ruleProblem(text) {
    return /<!--|-->/.test(String(text == null ? '' : text)) ? 'marks' : '';
  }

  // The rules to save from the dialog's rows [{ text, checked }]: the ticked ones, cleaned; empty ones, ones with a comment mark and repeats
  // (the same words in any case) left out; at most five.
  function chosenRules(rows) {
    const out = [];
    const seen = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || row.checked !== true || out.length >= MAX_SAVE_RULES) return;
      const text = cleanRule(row.text);
      if (!text || ruleProblem(text)) return;
      const key = text.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(text);
    });
    return out;
  }

  // The rules the model proposed, as rows: strings only, cleaned, empty ones and repeats dropped, all ticked.
  function proposedRows(list) {
    const rows = [];
    const seen = {};
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (typeof item !== 'string') return;
      const text = cleanRule(item);
      const key = text.toLowerCase();
      if (!text || seen[key]) return;
      seen[key] = true;
      rows.push({ text: text, checked: true });
    });
    return rows;
  }

  // ---- errors ----------------------------------------------------------------------------------------------------

  // The code a backend error starts with, when it is one the screen acts on; 'canceled' is read as 'cancelled'. '' for a sentence meant to be read.
  function errorCode(err) {
    const m = /^[a-z_]+/.exec(String((err && err.message) || err || ''));
    const code = m ? (m[0] === 'canceled' ? 'cancelled' : m[0]) : '';
    return KNOWN_CODES.indexOf(code) >= 0 ? code : '';
  }

  // What follows the code in the message ("consent_required: api.example.com" -> "api.example.com").
  function afterCode(err) {
    const m = /^[a-z_]+\s*[:：]?\s*([\s\S]*)$/.exec(String((err && err.message) || err || ''));
    return m ? m[1].split('\n')[0].trim() : '';
  }

  // The sentence for an error { kind: 'plan' | 'run' | 'save', code, detail } in the language of t. ctx.host names the cloud host.
  function errorText(error, t, ctx) {
    const e = error || {};
    const c = ctx || {};
    if (e.code === 'model_not_configured') return t('lessonsNoModel');
    if (e.code === 'consent_required') return t('lessonsConsentRequired', { host: c.host || e.detail || '' });
    if (e.code === 'plan_expired') return t('lessonsExpired');
    if (e.code === 'cancelled') return t('lessonsCanceled');
    if (e.code === 'too_many') return t('lessonsTooMany');
    const key = e.kind === 'plan' ? 'lessonsPlanFailed' : e.kind === 'save' ? 'lessonsSaveFailed' : 'lessonsFailed';
    return t(key, { message: e.detail || '?' });
  }

  // The status line after a save: the result is { path, count (in the file), added }. Nothing added = every rule was on file already.
  function savedText(result, agent, rules, t) {
    const r = result && typeof result === 'object' ? result : {};
    const added = r.added === undefined ? rules : count(r.added);
    return added > 0 ? t('lessonsSaved', { agent: agent, n: added }) : t('lessonsSavedNothing', { agent: agent });
  }

  // ---- the dialog as a state machine ------------------------------------------------------------------------------
  // phase: 'planning' (the backend works out what would be sent) -> 'ready' (the person looks, writes a note, ticks the box for a cloud
  // host, presses Create) -> 'running' (the model works; cancellable) -> 'result' (rules to edit and save) | 'none' (nothing worth keeping;
  // a note and ask again) ; 'error', 'model' (no model is set up) ; 'closed'.
  // reduce(state, event) returns { state, effect }: the new state and what the dialog has to do next, or null. effect is
  //   { call: 'plan', request } | { call: 'run', planId } | { call: 'save', request } | { call: 'cancel', planId }.
  // The state never holds a sentence, only codes: the words are made when it is painted.

  function noteChanged(s) {
    return String(s.note || '').trim() !== String(s.plannedNote || '').trim();
  }

  // The Create button works: the plan is there, and a cloud host that has not been allowed has its box ticked.
  function canCreate(s) {
    return s.phase === 'ready' && !!s.plan && !!s.plan.planId && (!needsConsent(s.plan) || s.consent === true);
  }

  // The first state of a dialog for a task, and the plan it asks for.
  function start(task, lang) {
    const state = {
      phase: 'planning', task: task || {}, agent: agentName(task), lang: lang === 'ja' ? 'ja' : 'en',
      note: '', plannedNote: '', plan: null, thenRun: false, notice: '', consent: false,
      rules: [], model: '', error: null, saving: false, result: null
    };
    return { state: state, effect: { call: 'plan', request: request(state.task, '', state.lang) } };
  }

  function change(s, fields) {
    return Object.assign({}, s, fields);
  }

  function out(state, effect) {
    return { state: state, effect: effect || null };
  }

  function replan(s, fields) {
    const next = change(s, Object.assign({ phase: 'planning', error: null }, fields));
    return out(next, { call: 'plan', request: request(next.task, next.note, next.lang) });
  }

  function reduce(s, ev) {
    switch (ev && ev.type) {
      case 'note':
        if (s.phase !== 'ready' && s.phase !== 'none') return out(s);
        return out(change(s, { note: clip(ev.text, NOTE_MAX_CHARS) }));

      case 'consent':
        if (s.phase !== 'ready') return out(s);
        return out(change(s, { consent: ev.checked === true }));

      case 'plan': {
        if (s.phase !== 'planning') return out(s);
        const plan = ev.plan;
        if (!plan || !plan.planId) return out(change(s, { phase: 'error', error: { kind: 'plan', code: '', detail: '?' } }));
        if (plan.modelConfigured === false) return out(change(s, { phase: 'model', plan: null }));
        const same = sameDestination(s.plan, plan);
        // A new plan made only because the note changed goes straight on to the model when the destination is the one the person saw
        if (s.thenRun && same && !needsConsent(plan)) {
          return out(change(s, { phase: 'running', plan: plan, plannedNote: s.note, thenRun: false, notice: '' }), { call: 'run', planId: plan.planId });
        }
        return out(change(s, {
          phase: 'ready', plan: plan, plannedNote: s.note,
          notice: s.thenRun && s.plan && !same ? 'changed' : '',
          thenRun: false, consent: same ? s.consent : false
        }));
      }

      case 'planFailed':
        if (s.phase !== 'planning') return out(s);
        if (ev.code === 'model_not_configured') return out(change(s, { phase: 'model', plan: null }));
        return out(change(s, { phase: 'error', thenRun: false, error: { kind: 'plan', code: ev.code || '', detail: ev.detail || '' } }));

      case 'create':
        if (!canCreate(s)) return out(s);
        // The note was changed after the plan was made: the excerpt that is sent includes it, so the backend works the plan out again first
        if (noteChanged(s)) return replan(s, { thenRun: true });
        return out(change(s, { phase: 'running', error: null, notice: '' }), { call: 'run', planId: s.plan.planId });

      case 'again':
        if (s.phase !== 'none' || !noteChanged(s)) return out(s);
        return replan(s, { thenRun: true });

      case 'retry':
        if (s.phase !== 'error' && s.phase !== 'model') return out(s);
        return replan(s, { plan: null, thenRun: false, notice: '' });

      case 'ran': {
        if (s.phase !== 'running') return out(s);
        const rows = proposedRows(ev.rules);
        const model = ev.model ? String(ev.model) : (s.plan ? s.plan.model : '');
        if (!rows.length) return out(change(s, { phase: 'none', rules: [], model: model }));
        return out(change(s, { phase: 'result', rules: rows, model: model, error: null }));
      }

      case 'runFailed': {
        if (s.phase !== 'running') return out(s);
        if (ev.code === 'model_not_configured') return out(change(s, { phase: 'model', plan: null }));
        if (ev.code === 'plan_expired') return replan(s, { thenRun: false, notice: 'expired' });
        if (ev.code === 'consent_required') {
          // The backend has no answer for this host: the box is asked again, on the plan we have
          return out(change(s, { phase: 'ready', consent: false, notice: 'consent', plan: change(s.plan, { consentGiven: false, local: false }) }));
        }
        return out(change(s, { phase: 'error', error: { kind: 'run', code: ev.code || '', detail: ev.detail || '' } }));
      }

      case 'toggleRule': {
        if (s.phase !== 'result' || s.saving || !s.rules[ev.index]) return out(s);
        const rows = s.rules.slice();
        rows[ev.index] = change(rows[ev.index], { checked: !rows[ev.index].checked });
        return out(change(s, { rules: rows }));
      }

      case 'editRule': {
        if (s.phase !== 'result' || s.saving || !s.rules[ev.index]) return out(s);
        const rows = s.rules.slice();
        rows[ev.index] = change(rows[ev.index], { text: String(ev.text == null ? '' : ev.text) });
        return out(change(s, { rules: rows }));
      }

      case 'save': {
        if (s.phase !== 'result' || s.saving) return out(s);
        const rules = chosenRules(s.rules);
        if (!rules.length) return out(s);
        const agent = (s.plan && s.plan.agent) || s.agent;
        return out(change(s, { saving: true, error: null }), { call: 'save', request: { agent: agent, rules: rules } });
      }

      case 'saved':
        if (s.phase !== 'result') return out(s);
        return out(change(s, { phase: 'closed', saving: false, result: ev.result || {} }));

      case 'saveFailed':
        if (s.phase !== 'result') return out(s);
        return out(change(s, { saving: false, error: { kind: 'save', code: ev.code || '', detail: ev.detail || '' } }));

      case 'cancel':
        if (s.saving) return out(s); // the file is being written: it is closed when that is done
        return out(change(s, { phase: 'closed' }), s.phase === 'running' && s.plan ? { call: 'cancel', planId: s.plan.planId } : null);

      default:
        return out(s);
    }
  }

  // The buttons of a state: { primary: { key, event, enabled } | null, secondary: { key }, hint: key of the line of keys }.
  // primary.event 'settings' is not a state event: the dialog opens the model settings.
  function controls(s) {
    const cancel = { key: 'btnCancel' };
    const close = { key: 'dialogClose' };
    switch (s.phase) {
      case 'ready': return { primary: { key: 'lessonsCreate', event: 'create', enabled: canCreate(s) }, secondary: cancel, hint: 'lessonsHintReady' };
      case 'result': return { primary: { key: 'btnSave', event: 'save', enabled: !s.saving && chosenRules(s.rules).length > 0 }, secondary: cancel, hint: 'lessonsHintResult' };
      case 'none': return { primary: { key: 'lessonsAskAgain', event: 'again', enabled: noteChanged(s) }, secondary: close, hint: 'lessonsHintNone' };
      case 'error': return { primary: { key: 'lessonsRetry', event: 'retry', enabled: true }, secondary: close, hint: 'lessonsHintBanner' };
      case 'model': return { primary: { key: 'askSetupButton', event: 'settings', enabled: true }, secondary: close, hint: 'lessonsHintBanner' };
      default: return { primary: null, secondary: cancel, hint: 'lessonsHintWorking' }; // planning, running
    }
  }

  // ---- the file picker of the palette command ----------------------------------------------------------------------

  // The answer of lessonsInfo('') as rows [{ agent, path, count, applied, skipped, disabled }], by agent name. The answer is a list, or an
  // object that holds one (files / lessons / items / agents); a file that does not exist is not offered.
  function fileList(raw) {
    let src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch (e) { src = null; }
    }
    let list = Array.isArray(src) ? src : (src && typeof src === 'object' ? (src.files || src.lessons || src.items || src.agents) : null);
    if (!Array.isArray(list)) list = [];
    return list
      .filter(function (x) { return x && typeof x === 'object' && typeof x.path === 'string' && x.path && x.exists !== false; })
      .map(function (x) {
        return { agent: String(x.agent == null ? '' : x.agent), path: x.path, count: count(x.count), applied: count(x.applied), skipped: count(x.skipped), disabled: x.disabled === true };
      })
      .sort(function (a, b) { return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0; });
  }

  // The right-hand words of a picker row: how many lessons, and that the agent does not use them.
  function pickDesc(row, t) {
    const parts = [t(row.count === 1 ? 'lessonsPickCountOne' : 'lessonsPickCount', { n: row.count })];
    if (row.disabled) parts.push(t('lessonsPickOff'));
    return parts.join(' · ');
  }

  // ---- the dialog (the DOM; built only when it opens) ------------------------------------------------------------

  const ICON_OPEN = '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const BULB_ICON = ICON_OPEN + '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>';

  let current = null; // the open dialog: { mode: 'learn' | 'pick', host, state, token, opener, ... }, or null
  let wired = false;  // the listeners of the markup are put on once
  let fade = null;    // PanelFade of the card (made on the first opening)

  function el(id) { return global.document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setHidden(id, hidden) {
    const e = el(id);
    if (e) e.classList.toggle('hidden', !!hidden);
  }

  function setText(id, text) {
    const e = el(id);
    if (e) e.textContent = text;
  }

  // A backend call as a promise, whatever it throws or returns; a JSON text is read.
  function ask(fn) {
    let call;
    try { call = Promise.resolve(fn()); } catch (err) { call = Promise.reject(err); }
    return call.then(function (v) {
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (e) { return null; }
      }
      return v;
    });
  }

  function plainFailure(err) {
    const m = err && err.message ? err.message : err;
    return String(m == null ? '?' : m).split('\n')[0].trim() || '?';
  }

  // The failure as one line for a sentence; the app words and masks it (host.failureText), else the first line as it is.
  function detailOf(st, err, llm) {
    const code = errorCode(err);
    if (code === 'consent_required') return afterCode(err);
    if (typeof st.host.failureText === 'function') return st.host.failureText(err, llm === true) || '?';
    return plainFailure(err);
  }

  function phaseOf(st) {
    return st.mode === 'learn' ? st.state.phase : 'pick';
  }

  // Something in the dialog a close would lose: a proposal being looked at, a run, a typed note.
  function holdsWork(st) {
    if (st.mode !== 'learn') return false;
    const s = st.state;
    return st.busy === true || s.phase === 'planning' || s.phase === 'running' || s.phase === 'result' || s.saving ||
      (s.phase !== 'model' && s.phase !== 'error' && String(s.note || '').trim() !== '');
  }

  function focusSoon(id) {
    const e = el(id);
    if (!e) return;
    try { e.focus({ preventScroll: true }); } catch (err) { e.focus(); }
  }

  // Where the focus goes when the dialog changes phase: it never stays on a button that has gone (the panel would then think the person moved on).
  function focusFor(st) {
    const phase = phaseOf(st);
    if (phase === 'ready' || phase === 'none') focusSoon('lesson-note');
    else if (phase === 'result') focusSoon('lesson-rule-input-0');
    else if (phase === 'error' || phase === 'model') focusSoon('lesson-primary');
    else if (phase === 'pick') focusSoon('lesson-pick-list');
    else focusSoon('lesson-secondary');
  }

  function restoreFocus(st) {
    const h = st.host;
    if (typeof h.restoreFocus === 'function') { h.restoreFocus(st.opener); return; }
    const o = st.opener;
    if (o && o.isConnected !== false && typeof o.focus === 'function') {
      try { o.focus({ preventScroll: true }); } catch (e) { o.focus(); }
    }
  }

  // restore (default true): the focus goes back to where it was. replaced: another dialog is opening over this one.
  function closeDialog(st, restore, replaced) {
    if (current !== st) return;
    current = null;
    el('lesson-modal').classList.add('hidden');
    global.document.removeEventListener('keydown', onKey, true);
    el('lesson-rules').innerHTML = '';
    el('lesson-pick-list').innerHTML = '';
    el('lesson-note').value = '';
    el('lesson-consent').checked = false;
    if (fade) fade.reset();
    if (restore !== false) restoreFocus(st);
    if (!replaced && typeof st.host.onClose === 'function') st.host.onClose();
  }

  // The state changed: the sections, texts and buttons follow it. The note box and the rule fields are never rewritten while they hold the
  // person's typing (they are only set when they differ from the state).
  function render(st) {
    const s = st.state;
    const t = st.host.t;
    const phase = s.phase;
    const c = controls(s);
    const agent = (s.plan && s.plan.agent) || s.agent; // (the name the backend resolved, once it has said it)
    setText('lesson-agent', agent);
    setHidden('lesson-agent', !agent);
    setText('lesson-context', instructionPreview(s.task.instruction));
    el('lesson-context').title = String(s.task.instruction == null ? '' : s.task.instruction).slice(0, 600);
    el('lesson-card').setAttribute('aria-label', t('badgeLessons'));

    const working = phase === 'planning' || phase === 'running';
    setHidden('lesson-working', !working);
    if (working) setText('lesson-working-text', phase === 'running' ? t('lessonsAsking', { model: s.plan ? s.plan.model : '' }) : t(s.notice === 'expired' ? 'lessonsExpired' : 'lessonsPlanning'));

    // the banner: a failure, or the one sentence that points to Settings
    let banner = '';
    let bannerKind = 'warn';
    if (phase === 'model') banner = t('lessonsNoModel');
    else if (phase === 'error' || (phase === 'result' && s.error)) { banner = errorText(s.error, t, { host: s.plan ? s.plan.host : '' }); bannerKind = 'error'; }
    else if (phase === 'ready' && s.notice === 'consent') banner = t('lessonsConsentRequired', { host: s.plan ? s.plan.host : '' });
    else if (phase === 'ready' && s.notice === 'changed') banner = t('lessonsDestChanged');
    else if (phase === 'ready' && st.consentError) { banner = t('lessonsConsentSaveFailed'); bannerKind = 'error'; }
    setHidden('lesson-banner', !banner);
    setText('lesson-banner', banner);
    el('lesson-banner').setAttribute('data-kind', bannerKind);

    // what will be sent, and to whom
    const ready = phase === 'ready' && !!s.plan;
    setHidden('lesson-prepare', !ready);
    if (ready) {
      const lines = planLines(s.plan, s.note, t, s.lang);
      setText('lesson-sent', lines.sent);
      setText('lesson-sent-note', lines.note);
      setHidden('lesson-sent-note', !lines.note);
      setText('lesson-masked', lines.masked);
      setHidden('lesson-masked', !lines.masked);
      setText('lesson-dest', lines.dest);
      el('lesson-dest').setAttribute('data-kind', lines.destKind);
      setText('lesson-existing', lines.existing);
      setHidden('lesson-existing', !lines.existing);
      setHidden('lesson-consent-row', !lines.consent);
      setText('lesson-consent-text', lines.consent);
      const box = el('lesson-consent');
      if (box.checked !== s.consent) box.checked = s.consent;
    }

    // the note box: before the model is asked, and when nothing was found
    const noteShown = phase === 'ready' || phase === 'none';
    setHidden('lesson-note-row', !noteShown);
    const note = el('lesson-note');
    if (noteShown && note.value !== s.note) note.value = s.note;

    setHidden('lesson-none', phase !== 'none');
    setHidden('lesson-result', phase !== 'result');
    if (phase === 'result') {
      if (!st.rulesPainted) paintRules(st);
      setText('lesson-result-intro', t('lessonsResultIntro', { model: s.model, agent: agent }));
      paintRuleWarnings(st);
    } else {
      st.rulesPainted = false;
    }

    // the buttons and the line of keys
    const primary = el('lesson-primary');
    primary.classList.toggle('hidden', !c.primary);
    if (c.primary) {
      primary.textContent = t(c.primary.key);
      primary.disabled = !c.primary.enabled || st.busy === true;
    }
    el('lesson-secondary').textContent = t(c.secondary.key);
    setText('lesson-hint', t(c.hint, { mod: st.host.mod || 'Ctrl' }));

    if (st.shownPhase !== phase) {
      st.shownPhase = phase;
      focusFor(st);
    }
  }

  // The proposed rules as rows: a tick and a one-line field each. Painted once when the result comes; ticking and editing change the state only.
  function paintRules(st) {
    const t = st.host.t;
    let html = '';
    st.state.rules.forEach(function (row, i) {
      html += '<div class="lesson-rule" data-index="' + i + '">' +
        '<input type="checkbox" class="lesson-rule-check" id="lesson-rule-check-' + i + '" data-index="' + i + '" checked aria-label="' + escapeHtml(t('lessonsRuleKeep', { n: i + 1 })) + '">' +
        '<input type="text" class="lesson-rule-input" id="lesson-rule-input-' + i + '" data-index="' + i + '" maxlength="' + MAX_RULE_CHARS + '" spellcheck="false" autocomplete="off" value="' + escapeHtml(row.text) + '" title="' + escapeHtml(row.text) + '" aria-label="' + escapeHtml(t('lessonsRuleLabel', { n: i + 1 })) + '">' +
        '<div class="lesson-rule-warn hidden" id="lesson-rule-warn-' + i + '"></div></div>';
    });
    el('lesson-rules').innerHTML = html;
    st.rulesPainted = true;
  }

  // A rule that holds a comment mark says it will not be saved.
  function paintRuleWarnings(st) {
    st.state.rules.forEach(function (row, i) {
      const warn = el('lesson-rule-warn-' + i);
      if (!warn) return;
      const bad = ruleProblem(row.text) === 'marks';
      warn.classList.toggle('hidden', !bad);
      warn.textContent = bad ? st.host.t('lessonsRuleBad') : '';
    });
  }

  // Runs what the state asks for next. A late answer (the dialog closed, or another request started since) is dropped by the token.
  function perform(st, effect) {
    const backend = st.host.backend;
    const token = ++st.token;
    const live = function () { return current === st && st.token === token; };
    if (effect.call === 'plan') {
      ask(function () { return backend.lessonPlan(effect.request); }).then(function (raw) {
        if (live()) dispatch(st, { type: 'plan', plan: normalizePlan(raw) });
      }, function (err) {
        if (live()) dispatch(st, { type: 'planFailed', code: errorCode(err), detail: detailOf(st, err, false) });
      });
    } else if (effect.call === 'run') {
      ask(function () { return backend.lessonRun(effect.planId); }).then(function (raw) {
        if (!live()) return;
        const r = raw && typeof raw === 'object' ? raw : {};
        dispatch(st, { type: 'ran', rules: r.rules, model: r.model });
      }, function (err) {
        if (live()) dispatch(st, { type: 'runFailed', code: errorCode(err), detail: detailOf(st, err, true) });
      });
    } else if (effect.call === 'save') {
      ask(function () { return backend.lessonSave(effect.request); }).then(function (raw) {
        if (!live()) return;
        st.savedRules = effect.request.rules.length;
        dispatch(st, { type: 'saved', result: raw });
      }, function (err) {
        if (live()) dispatch(st, { type: 'saveFailed', code: errorCode(err), detail: detailOf(st, err, false) });
      });
    } else if (effect.call === 'cancel') {
      try {
        const stopped = backend.cancelLesson(effect.planId);
        if (stopped && typeof stopped.catch === 'function') stopped.catch(function () {});
      } catch (e) { /* nothing left to stop */ }
    }
  }

  function dispatch(st, ev) {
    if (current !== st || st.mode !== 'learn') return;
    const r = reduce(st.state, ev);
    st.state = r.state;
    if (r.state.phase === 'closed') {
      const done = ev.type === 'saved' ? r.state : null;
      const host = st.host;
      const agent = r.state.plan && r.state.plan.agent ? r.state.plan.agent : r.state.agent;
      closeDialog(st, true);
      if (done && typeof host.showMessage === 'function') host.showMessage(savedText(done.result, agent, st.savedRules || 0, host.t), 5000);
      if (r.effect) perform(st, r.effect); // (the cancel of a run that was going)
      return;
    }
    render(st);
    if (r.effect) perform(st, r.effect);
  }

  // The primary button, or Ctrl+Enter.
  function activatePrimary(st) {
    if (st.mode !== 'learn' || st.busy) return;
    const c = controls(st.state);
    if (!c.primary || !c.primary.enabled) return;
    if (c.primary.event === 'settings') {
      const host = st.host;
      closeDialog(st, false);
      if (typeof host.openModelSettings === 'function') host.openModelSettings();
      return;
    }
    if (c.primary.event === 'create') { create(st); return; }
    dispatch(st, { type: c.primary.event });
  }

  // Create: for a cloud host that was not allowed yet the ticked box is saved as the app's answer (general.cloudConsent) BEFORE anything is
  // asked of the model, and the backend checks it again; if it cannot be saved nothing is sent.
  function create(st) {
    const s = st.state;
    if (!canCreate(s)) return;
    if (!needsConsent(s.plan)) { dispatch(st, { type: 'create' }); return; }
    st.busy = true;
    st.consentError = false;
    render(st);
    let saved;
    try {
      // (a destination with no host to name cannot be allowed: nothing is saved under an empty key)
      saved = Promise.resolve(st.host.rememberConsent && s.plan.consentKey ? st.host.rememberConsent(s.plan.consentKey) : false);
    } catch (e) {
      saved = Promise.resolve(false);
    }
    saved.then(function (ok) { return ok !== false; }, function () { return false; }).then(function (ok) {
      if (current !== st) return;
      st.busy = false;
      if (!ok) {
        st.consentError = true;
        render(st);
        return;
      }
      // (the person may have changed the note while it was saved: the state decides what happens next)
      dispatch(st, { type: 'create' });
    });
  }

  // Esc, the Cancel button, the corner button: while the model works, it is stopped, and the dialog closes.
  function requestClose(st) {
    if (current !== st) return;
    if (st.mode !== 'learn') { closeDialog(st, true); return; }
    dispatch(st, { type: 'cancel' });
  }

  function onKey(e) {
    const st = current;
    if (!st) return;
    if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229) return; // the Esc that drops a conversion is not "close"
      e.preventDefault();
      e.stopPropagation(); // one Esc closes one panel
      requestClose(st);
      return;
    }
    if (st.mode === 'pick') { pickKey(st, e); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      activatePrimary(st);
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    el('lesson-primary').addEventListener('click', function () { if (current) activatePrimary(current); });
    el('lesson-secondary').addEventListener('click', function () { if (current) requestClose(current); });
    el('lesson-close').addEventListener('click', function () { if (current) requestClose(current); });
    el('lesson-note').addEventListener('input', function () { if (current && current.mode === 'learn') dispatch(current, { type: 'note', text: el('lesson-note').value }); });
    el('lesson-consent').addEventListener('change', function () {
      if (!current || current.mode !== 'learn') return;
      current.consentError = false; // (the sentence about a permission that could not be saved is about the last try)
      dispatch(current, { type: 'consent', checked: el('lesson-consent').checked });
    });
    // The rule rows are made when a result comes: the listeners are on their container
    const rules = el('lesson-rules');
    rules.addEventListener('change', function (e) {
      const box = e.target;
      if (current && current.mode === 'learn' && box.classList && box.classList.contains('lesson-rule-check')) {
        dispatch(current, { type: 'toggleRule', index: Number(box.getAttribute('data-index')) });
      }
    });
    rules.addEventListener('input', function (e) {
      const field = e.target;
      if (current && current.mode === 'learn' && field.classList && field.classList.contains('lesson-rule-input')) {
        field.title = field.value; // a rule longer than the field shows all of it on hover
        dispatch(current, { type: 'editRule', index: Number(field.getAttribute('data-index')), text: field.value });
      }
    });
    // A row of the picker is taken on press (the list keeps the focus), as the palette's rows are
    el('lesson-pick-list').addEventListener('mousedown', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('[data-row]') : null;
      e.preventDefault();
      if (!row || !current || current.mode !== 'pick') return;
      current.active = Number(row.getAttribute('data-row')) || 0;
      pickCommit(current);
    });
    // A press on the dimmed window outside: closes it, unless that would lose a proposal, a run or a note
    el('lesson-modal').addEventListener('mousedown', function (e) {
      if (e.target !== el('lesson-modal') || !current) return;
      e.preventDefault();
      if (!holdsWork(current)) requestClose(current);
    });
    if (global.PanelFade) {
      fade = global.PanelFade.create(el('lesson-card'), {
        isOpen: function () { return !!current; },
        close: function () { if (current) requestClose(current); },
        getValue: function () { return current && current.mode === 'learn' ? String(current.state.note || '') : ''; },
        isBusy: function () { return !!current && holdsWork(current); },
        refocus: function () { if (current) focusFor(current); }
      });
    }
  }

  // Shows the card for a mode and takes over the keys.
  function show(st) {
    el('lesson-card').classList.remove('panel-fading');
    if (fade) fade.reset();
    el('lesson-modal').classList.remove('hidden');
    global.document.addEventListener('keydown', onKey, true);
  }

  // Opens the dialog for a finished task. host: { task (what TaskManager.historyTask gives), backend, t, lang ('en' | 'ja'), mod ('Ctrl' | 'Cmd'),
  // opener (the element to give the focus back to), showMessage(msg, ms), rememberConsent(key) -> promise of false when it could not be saved,
  // openModelSettings(), failureText(err, llm) -> one line, restoreFocus(opener), onClose() }. Returns false when it cannot open.
  function open(host) {
    if (!global.document || !el('lesson-modal') || !host || !host.task || !host.backend || typeof host.backend.lessonPlan !== 'function') return false;
    wire();
    if (current) closeDialog(current, false, true);
    const first = start(host.task, host.lang);
    const st = {
      mode: 'learn', host: host, state: first.state, token: 0, opener: host.opener || global.document.activeElement,
      busy: false, consentError: false, rulesPainted: false, shownPhase: '', savedRules: 0
    };
    current = st;
    setHidden('lesson-pick', true);
    setHidden('lesson-footer', false);
    el('lesson-note').setAttribute('placeholder', host.t('lessonsNotePlaceholder'));
    setText('lesson-note-label', host.t('lessonsNoteLabel'));
    setText('lesson-none-text', host.t('lessonsNone'));
    setText('lesson-none-hint', host.t('lessonsNoneHint'));
    el('lesson-close').setAttribute('aria-label', host.t('dialogClose'));
    setHidden('lesson-meta', false);
    show(st);
    render(st);
    perform(st, first.effect);
    return true;
  }

  // ---- the picker (palette: "Open the lessons file") ----------------------------------------------------------------

  function paintPick(st) {
    const t = st.host.t;
    let html = '';
    st.rows.forEach(function (row, i) {
      html += '<div class="quick-pick-item lesson-pick-item' + (i === st.active ? ' active' : '') + '" id="lesson-pick-row-' + i + '" role="option" aria-selected="' + (i === st.active ? 'true' : 'false') + '" data-row="' + i + '">' +
        '<div class="quick-pick-item-main"><span class="quick-pick-item-icon">' + BULB_ICON + '</span>' +
        '<div class="quick-pick-item-content"><div class="quick-pick-item-title">' + escapeHtml(row.agent) + '</div>' +
        '<div class="quick-pick-item-desc">' + escapeHtml(pickDesc(row, t)) + '</div></div></div></div>';
    });
    const list = el('lesson-pick-list');
    list.innerHTML = html;
    list.setAttribute('aria-activedescendant', 'lesson-pick-row-' + st.active);
    const active = list.querySelector('.lesson-pick-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function pickKey(st, e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      st.active = (st.active + (e.key === 'ArrowDown' ? 1 : st.rows.length - 1)) % st.rows.length;
      paintPick(st);
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      pickCommit(st);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // Shift+Tab stays in the panel, as in the tag picker
    }
  }

  function pickCommit(st) {
    const row = st.rows[st.active];
    if (!row) return;
    const host = st.host;
    closeDialog(st, false);
    if (typeof host.openFile === 'function') host.openFile(row);
  }

  // Opens the picker of the lessons files. host: { rows (fileList), t, openFile(row), restoreFocus(opener), onClose() }. Returns false when it
  // cannot open.
  function openPicker(host) {
    if (!global.document || !el('lesson-modal') || !host || !Array.isArray(host.rows) || host.rows.length === 0) return false;
    wire();
    if (current) closeDialog(current, false, true);
    const st = { mode: 'pick', host: host, rows: host.rows, active: 0, opener: host.opener || global.document.activeElement };
    current = st;
    const t = host.t;
    ['lesson-working', 'lesson-banner', 'lesson-prepare', 'lesson-note-row', 'lesson-result', 'lesson-none', 'lesson-footer', 'lesson-agent'].forEach(function (id) { setHidden(id, true); });
    setHidden('lesson-pick', false);
    setText('lesson-context', t('lessonsPickContext'));
    setHidden('lesson-meta', false);
    setText('lesson-hint', t('lessonsHintPick'));
    el('lesson-card').setAttribute('aria-label', t('cmdPaletteLessonsFile'));
    el('lesson-close').setAttribute('aria-label', t('dialogClose'));
    paintPick(st);
    show(st);
    focusSoon('lesson-pick-list');
    return true;
  }

  function isOpen() {
    return !!current;
  }

  const api = {
    MAX_RULE_CHARS: MAX_RULE_CHARS,
    MAX_SAVE_RULES: MAX_SAVE_RULES,
    NOTE_MAX_CHARS: NOTE_MAX_CHARS,
    agentName: agentName,
    instructionPreview: instructionPreview,
    request: request,
    normalizePlan: normalizePlan,
    needsConsent: needsConsent,
    sameDestination: sameDestination,
    planLines: planLines,
    cleanRule: cleanRule,
    ruleProblem: ruleProblem,
    chosenRules: chosenRules,
    proposedRows: proposedRows,
    errorCode: errorCode,
    afterCode: afterCode,
    errorText: errorText,
    savedText: savedText,
    start: start,
    reduce: reduce,
    canCreate: canCreate,
    controls: controls,
    fileList: fileList,
    pickDesc: pickDesc,
    open: open,
    openPicker: openPicker,
    isOpen: isOpen
  };
  global.Lessons = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
