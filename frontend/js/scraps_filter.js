// MD-Memo: the filter row of the notes search (Ctrl+Shift+F) - a period and tags that narrow every search of the panel (exact, meaning,
// and the Deep search made from the list on screen). docs/design/tag-filter-2026-10.md section 5.
//
//  - The state is { period, tags }: one period (all / today / 7 days / 30 days / this month) and the tags that must ALL be on a note.
//    Nothing is saved: the state lives as long as the app is open.
//  - What the backend gets is a plain object, { tags?, from?, to? }, or null when nothing is chosen (so a search without a filter goes
//    the way it always went). The period becomes from / to as local calendar dates (YYYY-MM-DD), made when the search starts, never
//    when the button was pressed: a panel left open over midnight still asks for the right days.
//  - The tag list is the backend's (scrapFilterOptions: {tags: [{tag, files, entries}], files, undated}), the most used first, 40 shown.
//  - Pure functions only, and the markup of the area as a string: no DOM, nothing runs until the person opens the filter.
(function (global) {
  'use strict';

  const MAX_TAGS_SHOWN = 40; // tag buttons; the rest is only counted ("N more")
  const MAX_TAGS_CHOSEN = 8; // the backend takes at most 8 tags in one filter (search.ParseTagList) and fails the search for more

  // days: how many calendar days the period spans, today included (7 days = today and the 6 days before).
  const PERIODS = [
    { id: 'all', key: 'scrapsFilterPeriodAll' },
    { id: 'today', key: 'scrapsFilterPeriodToday', days: 1 },
    { id: 'week', key: 'scrapsFilterPeriodWeek', days: 7 },
    { id: 'days30', key: 'scrapsFilterPeriod30', days: 30 },
    { id: 'month', key: 'scrapsFilterPeriodMonth' }
  ];
  const PERIOD_BY_ID = {};
  PERIODS.forEach(function (p) { PERIOD_BY_ID[p.id] = p; });

  // ---- state -------------------------------------------------------------------------------------

  function create() {
    return { period: 'all', tags: [] };
  }

  // A state from outside is never trusted: anything that is not a state is a fresh one.
  function sane(state) {
    return state && typeof state === 'object' && Array.isArray(state.tags) && PERIOD_BY_ID[state.period] ? state : create();
  }

  // Each of these returns a new state, or the same object when nothing changed (the caller then has nothing to search again).
  function setPeriod(state, id) {
    const s = sane(state);
    const period = PERIOD_BY_ID[id] ? id : 'all';
    return period === s.period ? s : { period: period, tags: s.tags.slice() };
  }

  // Chooses the tag, or lets it go when it is chosen. A 9th tag is refused (same state back).
  function toggleTag(state, tag) {
    const s = sane(state);
    const name = typeof tag === 'string' ? tag.trim() : '';
    if (!name) return s;
    const at = s.tags.indexOf(name);
    if (at >= 0) return { period: s.period, tags: s.tags.slice(0, at).concat(s.tags.slice(at + 1)) };
    if (s.tags.length >= MAX_TAGS_CHOSEN) return s;
    return { period: s.period, tags: s.tags.concat(name) };
  }

  function clear() {
    return create();
  }

  // How many things narrow the search: each chosen tag, and the period when it is not "all". The count on the button.
  function activeCount(state) {
    const s = sane(state);
    return s.tags.length + (s.period === 'all' ? 0 : 1);
  }

  function isActive(state) {
    return activeCount(state) > 0;
  }

  // "(2)" for the button, '' when nothing is chosen.
  function countLabel(state) {
    const n = activeCount(state);
    return n > 0 ? '(' + n + ')' : '';
  }

  // ---- the period as dates -----------------------------------------------------------------------

  function pad(n, width) {
    let s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  // y, m (1 to 12), d (may be 0 or past the end of the month: the calendar carries it) -> "YYYY-MM-DD". The day is counted in UTC, which has no
  // daylight saving, so a day is always one day whatever the time zone does that week.
  function dayString(y, m, d) {
    const u = new Date(0);
    u.setUTCFullYear(y, m - 1, d);
    return pad(u.getUTCFullYear(), 4) + '-' + pad(u.getUTCMonth() + 1, 2) + '-' + pad(u.getUTCDate(), 2);
  }

  function isDate(d) {
    return !!d && typeof d.getTime === 'function' && typeof d.getFullYear === 'function' && !isNaN(d.getTime());
  }

  // { from, to } of the period, ending today (the local day of `now`), or null for "all" and anything unknown.
  //   today        today
  //   week         today and the 6 days before
  //   days30       today and the 29 days before
  //   month        the 1st of this month to today
  function periodRange(id, now) {
    const p = PERIOD_BY_ID[id];
    if (!p || p.id === 'all') return null;
    const at = isDate(now) ? now : new Date();
    const y = at.getFullYear();
    const m = at.getMonth() + 1;
    const d = at.getDate();
    return { from: p.id === 'month' ? dayString(y, m, 1) : dayString(y, m, d - (p.days - 1)), to: dayString(y, m, d) };
  }

  // What the backend is asked: { tags?, from?, to? } or null. The tags come in the order they were chosen.
  function toRequest(state, now) {
    const s = sane(state);
    const filter = {};
    if (s.tags.length) filter.tags = s.tags.slice();
    const range = periodRange(s.period, now);
    if (range) {
      filter.from = range.from;
      filter.to = range.to;
    }
    return filter.tags || range ? filter : null;
  }

  // ---- the tag list ------------------------------------------------------------------------------

  function count(v) {
    const n = Math.floor(Number(v));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function byUse(a, b) {
    if (a.files !== b.files) return b.files - a.files;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  }

  // The backend's answer as the page uses it: tags that are text, counts that are whole numbers, one row per tag, the most used first.
  function normalizeOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const byTag = new Map();
    (Array.isArray(src.tags) ? src.tags : []).forEach(function (row) {
      const tag = row && typeof row.tag === 'string' ? row.tag.trim() : '';
      if (!tag) return;
      const files = count(row.files);
      const seen = byTag.get(tag);
      if (!seen || files > seen.files) byTag.set(tag, { tag: tag, files: files, entries: count(row.entries) });
    });
    return { tags: Array.from(byTag.values()).sort(byUse), files: count(src.files), undated: count(src.undated) };
  }

  // The buttons to draw: the first 40 tags, then the number that did not fit. A tag that is chosen is always drawn (even past the 40th, or
  // gone from the list), so that it can be let go.
  function tagView(options, chosen) {
    const all = options && Array.isArray(options.tags) ? options.tags : [];
    const picked = Array.isArray(chosen) ? chosen : [];
    const shown = all.slice(0, MAX_TAGS_SHOWN);
    const have = new Set(shown.map(function (row) { return row.tag; }));
    let more = all.length - shown.length;
    picked.forEach(function (tag) {
      if (have.has(tag)) return;
      have.add(tag);
      const row = all.find(function (r) { return r.tag === tag; });
      shown.push(row || { tag: tag, files: 0, entries: 0 });
      if (row) more--;
    });
    return { shown: shown, more: more };
  }

  // How many notes have no date in their name and so are in no period; 0 when the line is not to be shown (no period chosen, or none).
  function undatedNotice(state, options) {
    if (sane(state).period === 'all') return 0;
    return count(options && options.undated);
  }

  // The i18n key of what an empty list says. With a filter chosen the list is empty because of it, which the person must be able to tell.
  function emptyMessageKey(filter, hasQuery) {
    if (!hasQuery) return 'scrapsSearchEmpty';
    return filter ? 'scrapsFilterNoResults' : 'scrapsSearchNoResults';
  }

  // ---- the area ----------------------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Every button is out of the Tab order (Tab in the search box quotes the line), and says what it is to a screen reader.
  function chip(attr, label, pressed, extra) {
    return '<button type="button" class="scraps-filter-chip' + (pressed ? ' on' : '') + '" tabindex="-1" aria-pressed="' + (pressed ? 'true' : 'false') + '" ' + attr + (extra || '') + '>' + esc(label) + '</button>';
  }

  // view: { state, status: 'idle' | 'loading' | 'ready' | 'failed', options (normalized), message (why it failed) }; t(key, params) is the app's.
  function areaHtml(view, t) {
    const v = view || {};
    const state = sane(v.state);
    const status = v.status || 'idle';

    const periods = PERIODS.map(function (p) {
      return chip('data-filter-period="' + esc(p.id) + '"', t(p.key), state.period === p.id);
    }).join('');

    const tv = tagView(status === 'ready' ? v.options : null, state.tags);
    const full = state.tags.length >= MAX_TAGS_CHOSEN;
    let tags = tv.shown.map(function (row) {
      const on = state.tags.indexOf(row.tag) >= 0;
      const title = !on && full ? t('scrapsFilterTagLimit', { n: MAX_TAGS_CHOSEN }) : row.files > 0 ? t('scrapsFilterTagNotes', { n: row.files }) : '';
      return chip('data-filter-tag="' + esc(row.tag) + '"', row.tag, on, (!on && full ? ' disabled' : '') + (title ? ' title="' + esc(title) + '"' : ''));
    }).join('');
    if (tv.more > 0) tags += '<span class="scraps-filter-more">' + esc(t('scrapsFilterMore', { n: tv.more })) + '</span>';
    if (status === 'idle' || status === 'loading') {
      tags += '<span class="scraps-filter-status">' + esc(t('scrapsFilterLoading')) + '</span>';
    } else if (status === 'failed') {
      tags += '<span class="scraps-filter-status scraps-filter-status-error">' + esc(t('scrapsFilterFailed', { message: v.message || '?' })) + '</span>';
    } else if (tv.shown.length === 0) {
      tags += '<span class="scraps-filter-status">' + esc(t('scrapsFilterNoTags')) + '</span>';
    }

    // Clear ends the period row, and is there while something is chosen. The line about notes without a date comes under the tags, when it is true.
    const clearBtn = isActive(state) ? '<button type="button" class="scraps-filter-clear" tabindex="-1" data-filter-clear>' + esc(t('scrapsFilterClear')) + '</button>' : '';
    const undated = status === 'ready' ? undatedNotice(state, v.options) : 0;
    const note = undated > 0 ? '<div class="scraps-filter-note">' + esc(t(undated === 1 ? 'scrapsFilterUndatedOne' : 'scrapsFilterUndated', { n: undated })) + '</div>' : '';

    return '<div class="scraps-filter-group" role="group" aria-label="' + esc(t('scrapsFilterPeriod')) + '"><span class="scraps-filter-label">' + esc(t('scrapsFilterPeriod')) + '</span><div class="scraps-filter-chips">' + periods + '</div>' + clearBtn + '</div>' +
      '<div class="scraps-filter-group" role="group" aria-label="' + esc(t('scrapsFilterTags')) + '"><span class="scraps-filter-label">' + esc(t('scrapsFilterTags')) + '</span><div class="scraps-filter-chips">' + tags + '</div></div>' +
      note;
  }

  global.ScrapsFilter = {
    MAX_TAGS_SHOWN: MAX_TAGS_SHOWN,
    MAX_TAGS_CHOSEN: MAX_TAGS_CHOSEN,
    PERIODS: PERIODS,
    create: create,
    setPeriod: setPeriod,
    toggleTag: toggleTag,
    clear: clear,
    activeCount: activeCount,
    isActive: isActive,
    countLabel: countLabel,
    periodRange: periodRange,
    toRequest: toRequest,
    normalizeOptions: normalizeOptions,
    tagView: tagView,
    undatedNotice: undatedNotice,
    emptyMessageKey: emptyMessageKey,
    areaHtml: areaHtml
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.ScrapsFilter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
