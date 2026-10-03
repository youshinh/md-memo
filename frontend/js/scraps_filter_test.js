// Unit tests for scraps_filter.js: the state of the notes search's filter row (period and tags), what the backend is asked, the tag list,
// the undated line, the empty-result message and the markup of the area.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
const SF = require('./scraps_filter.js');

// A "t" like the app's: the table of the language, {name} filled in.
const I18N = new Function(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '\nreturn I18N;')();
const tr = (lang) => (key, params) => {
  let s = I18N[lang][key];
  assert.ok(typeof s === 'string', `${lang} has no string for ${key}`);
  Object.keys(params || {}).forEach((k) => { s = s.split('{' + k + '}').join(String(params[k])); });
  return s;
};
const tEn = tr('en');
const tJa = tr('ja');

(function testState() {
  const s0 = SF.create();
  assert.deepStrictEqual(s0, { period: 'all', tags: [] });
  assert.strictEqual(SF.activeCount(s0), 0);
  assert.strictEqual(SF.isActive(s0), false);
  assert.strictEqual(SF.countLabel(s0), '');

  const s1 = SF.toggleTag(s0, 'work');
  assert.deepStrictEqual(s1.tags, ['work']);
  assert.deepStrictEqual(s0.tags, [], 'a new state: the old one is not changed');
  const s2 = SF.toggleTag(s1, 'urgent');
  assert.deepStrictEqual(s2.tags, ['work', 'urgent'], 'in the order they were chosen');
  const s3 = SF.toggleTag(s2, 'work');
  assert.deepStrictEqual(s3.tags, ['urgent'], 'choosing a chosen tag lets it go');

  const p1 = SF.setPeriod(s2, 'week');
  assert.strictEqual(p1.period, 'week');
  assert.deepStrictEqual(p1.tags, ['work', 'urgent'], 'the tags stay when the period changes');
  assert.notStrictEqual(p1.tags, s2.tags, 'and are a copy');
  assert.strictEqual(SF.setPeriod(p1, 'week'), p1, 'the same period again: the same state (nothing to search again)');
  assert.strictEqual(SF.setPeriod(p1, 'nonsense').period, 'all', 'an unknown period is "all"');
  assert.strictEqual(SF.setPeriod(p1, undefined).period, 'all');

  assert.strictEqual(SF.activeCount(p1), 3, 'two tags and a period');
  assert.strictEqual(SF.countLabel(p1), '(3)');
  assert.strictEqual(SF.activeCount(SF.setPeriod(s0, 'month')), 1, 'a period alone');
  assert.strictEqual(SF.countLabel(SF.toggleTag(s0, 'a')), '(1)');
  assert.strictEqual(SF.isActive(SF.setPeriod(s0, 'today')), true);
  assert.deepStrictEqual(SF.clear(), { period: 'all', tags: [] });

  // things that are not tags
  assert.strictEqual(SF.toggleTag(s1, ''), s1);
  assert.strictEqual(SF.toggleTag(s1, '   '), s1);
  assert.strictEqual(SF.toggleTag(s1, null), s1);
  assert.strictEqual(SF.toggleTag(s1, 42), s1);
  assert.deepStrictEqual(SF.toggleTag(s0, '  spaced  ').tags, ['spaced'], 'trimmed');
  // a state from nowhere is a fresh one
  assert.deepStrictEqual(SF.toggleTag(null, 'a').tags, ['a']);
  assert.deepStrictEqual(SF.toggleTag({ period: 'x', tags: 'no' }, 'a'), { period: 'all', tags: ['a'] });
  assert.strictEqual(SF.activeCount(undefined), 0);
  assert.strictEqual(SF.activeCount({ tags: 5 }), 0);
})();

(function testAtMostEightTags() {
  let s = SF.create();
  for (let i = 1; i <= 8; i++) s = SF.toggleTag(s, 't' + i);
  assert.strictEqual(s.tags.length, 8);
  assert.strictEqual(SF.toggleTag(s, 't9'), s, 'a 9th tag is refused: the backend fails a search with more than 8');
  assert.deepStrictEqual(SF.toggleTag(s, 't3').tags, ['t1', 't2', 't4', 't5', 't6', 't7', 't8'], 'but one can still be let go');
  const again = SF.toggleTag(SF.toggleTag(s, 't3'), 't9');
  assert.strictEqual(again.tags.length, 8, 'and another chosen in its place');
  assert.strictEqual(again.tags[7], 't9');
  assert.strictEqual(SF.MAX_TAGS_CHOSEN, 8);
})();

// The local day of a Date as the page sees it, written independently of the module (no UTC trick): used to check the dates
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

(function testPeriodRanges() {
  const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h || 0, mi || 0, 0);
  const r = (id, now) => SF.periodRange(id, now);

  assert.strictEqual(r('all', at(2026, 10, 3)), null, 'all: no dates at all');
  assert.strictEqual(r('nonsense', at(2026, 10, 3)), null);
  assert.strictEqual(r(undefined, at(2026, 10, 3)), null);

  const now = at(2026, 10, 3, 14, 30);
  assert.deepStrictEqual(r('today', now), { from: '2026-10-03', to: '2026-10-03' });
  assert.deepStrictEqual(r('week', now), { from: '2026-09-27', to: '2026-10-03' }, 'today and the 6 days before: 7 days');
  assert.deepStrictEqual(r('days30', now), { from: '2026-09-04', to: '2026-10-03' }, 'today and the 29 days before: 30 days');
  assert.deepStrictEqual(r('month', now), { from: '2026-10-01', to: '2026-10-03' }, 'the 1st to today');

  // the first of the month: the week reaches into the month before, this month is one day
  assert.deepStrictEqual(r('week', at(2026, 3, 1)), { from: '2026-02-23', to: '2026-03-01' });
  assert.deepStrictEqual(r('month', at(2026, 3, 1)), { from: '2026-03-01', to: '2026-03-01' });
  assert.deepStrictEqual(r('days30', at(2026, 3, 1)), { from: '2026-01-31', to: '2026-03-01' }, 'February 2026 has 28 days');
  // a leap year
  assert.deepStrictEqual(r('week', at(2028, 3, 1)), { from: '2028-02-24', to: '2028-03-01' });
  assert.deepStrictEqual(r('days30', at(2028, 3, 1)), { from: '2028-02-01', to: '2028-03-01' }, 'February 2028 has 29 days');
  assert.deepStrictEqual(r('today', at(2028, 2, 29)), { from: '2028-02-29', to: '2028-02-29' }, 'the 29th of a leap February exists');
  assert.deepStrictEqual(r('week', at(2026, 3, 3)), { from: '2026-02-25', to: '2026-03-03' });
  // the last day of the month, and of the year
  assert.deepStrictEqual(r('month', at(2026, 1, 31)), { from: '2026-01-01', to: '2026-01-31' });
  assert.deepStrictEqual(r('week', at(2027, 1, 3)), { from: '2026-12-28', to: '2027-01-03' }, 'across New Year');
  assert.deepStrictEqual(r('days30', at(2027, 1, 3)), { from: '2026-12-05', to: '2027-01-03' });
  assert.deepStrictEqual(r('month', at(2026, 12, 31)), { from: '2026-12-01', to: '2026-12-31' });
  // the time of day does not matter: the local day does
  assert.deepStrictEqual(r('today', at(2026, 10, 3, 0, 0)), { from: '2026-10-03', to: '2026-10-03' });
  assert.deepStrictEqual(r('today', at(2026, 10, 3, 23, 59)), { from: '2026-10-03', to: '2026-10-03' });
  // short years are written with four digits
  assert.deepStrictEqual(r('today', new Date(2000, 0, 5)), { from: '2000-01-05', to: '2000-01-05' });

  // a "now" that is not a date: the real clock
  const real = r('today', 'yesterday');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(real.from) && real.from === real.to, JSON.stringify(real));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r('week', new Date(NaN)).from), 'an invalid Date is the real clock too');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r('week').to));
})();

(function testPeriodsAreCalendarDaysInEveryTimeZone() {
  // Days are counted on the calendar (UTC arithmetic on the local year / month / day), so a night with 23 or 25 hours, or a day
  // that a time zone skipped, changes nothing. Checked against a plain day count, in zones with and without daylight saving.
  const dayNumber = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
  const fromNumber = (n) => { const u = new Date(n * 86400000); return ymd(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()); };
  const zones = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'America/Sao_Paulo', 'Pacific/Apia'];
  const saved = process.env.TZ;
  let honoured = 0;
  try {
    zones.forEach((tz) => {
      process.env.TZ = tz;
      if (tz === 'Asia/Tokyo' && new Date(2026, 6, 1).getTimezoneOffset() !== -540) return; // this runtime keeps its zone: nothing to prove here
      honoured++;
      for (let day = 0; day < 366; day++) {
        [[0, 30], [12, 0], [23, 30]].forEach(([h, mi]) => {
          const now = new Date(2026, 0, 1 + day, h, mi, 0);
          if (now.getHours() !== h && !(h === 0 && now.getHours() === 1)) return; // a local hour a zone skipped
          const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
          const n = dayNumber(y, m, d);
          const week = SF.periodRange('week', now);
          const month30 = SF.periodRange('days30', now);
          const mon = SF.periodRange('month', now);
          const today = ymd(y, m, d);
          assert.strictEqual(week.to, today, `${tz} ${today}: to`);
          assert.strictEqual(week.from, fromNumber(n - 6), `${tz} ${today}: 7 days`);
          assert.strictEqual(month30.from, fromNumber(n - 29), `${tz} ${today}: 30 days`);
          assert.strictEqual(mon.from, ymd(y, m, 1), `${tz} ${today}: this month`);
        });
      }
    });
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.ok(honoured >= 1);
})();

(function testToRequest() {
  const now = new Date(2026, 9, 3, 12, 0, 0);
  assert.strictEqual(SF.toRequest(SF.create(), now), null, 'nothing chosen: null, so the search goes the way it always went');
  assert.strictEqual(SF.toRequest(null, now), null);
  assert.strictEqual(SF.toRequest(undefined, now), null);
  assert.strictEqual(SF.toRequest({ junk: 1 }, now), null);

  assert.deepStrictEqual(SF.toRequest(SF.toggleTag(SF.create(), 'work'), now), { tags: ['work'] }, 'a tag alone: no dates');
  assert.deepStrictEqual(SF.toRequest(SF.setPeriod(SF.create(), 'today'), now), { from: '2026-10-03', to: '2026-10-03' }, 'a period alone: no tags key');
  const both = SF.toRequest(SF.setPeriod(SF.toggleTag(SF.toggleTag(SF.create(), 'work'), 'urgent'), 'month'), now);
  assert.deepStrictEqual(both, { tags: ['work', 'urgent'], from: '2026-10-01', to: '2026-10-03' });
  assert.strictEqual(JSON.stringify(both), '{"tags":["work","urgent"],"from":"2026-10-01","to":"2026-10-03"}', 'the wire form of the contract');
  assert.deepStrictEqual(SF.toRequest(SF.setPeriod(SF.create(), 'all'), now), null);

  // the request does not share the state's array
  const state = SF.toggleTag(SF.create(), 'a');
  const req = SF.toRequest(state, now);
  req.tags.push('b');
  assert.deepStrictEqual(state.tags, ['a']);

  // the period is read from the clock each time: the same state asked on the next day gives the next day
  const st = SF.setPeriod(SF.create(), 'today');
  assert.strictEqual(SF.toRequest(st, new Date(2026, 9, 3, 23, 59)).to, '2026-10-03');
  assert.strictEqual(SF.toRequest(st, new Date(2026, 9, 4, 0, 1)).to, '2026-10-04');
})();

(function testNormalizeOptions() {
  const raw = {
    tags: [
      { tag: 'idea', files: 1, entries: 2 },
      { tag: 'work', files: 8, entries: 20 },
      { tag: 'urgent', files: 4, entries: 4 },
      { tag: 'reading', files: 4, entries: 6 }
    ],
    files: 14,
    undated: 2
  };
  const n = SF.normalizeOptions(raw);
  assert.deepStrictEqual(n.tags.map((x) => x.tag), ['work', 'reading', 'urgent', 'idea'], 'most files first, the tag name breaks a tie');
  assert.strictEqual(n.files, 14);
  assert.strictEqual(n.undated, 2);
  assert.deepStrictEqual(n.tags[0], { tag: 'work', files: 8, entries: 20 });
  assert.deepStrictEqual(raw.tags.map((x) => x.tag), ['idea', 'work', 'urgent', 'reading'], 'the answer itself is not reordered');

  assert.deepStrictEqual(SF.normalizeOptions(null), { tags: [], files: 0, undated: 0 });
  assert.deepStrictEqual(SF.normalizeOptions('text'), { tags: [], files: 0, undated: 0 });
  assert.deepStrictEqual(SF.normalizeOptions({}), { tags: [], files: 0, undated: 0 });
  assert.deepStrictEqual(SF.normalizeOptions({ tags: 'no' }), { tags: [], files: 0, undated: 0 });
  const odd = SF.normalizeOptions({
    tags: [null, 7, { files: 3 }, { tag: '' }, { tag: '  ' }, { tag: 5 }, { tag: 'ok', files: '3', entries: -1 }, { tag: 'ok', files: 9 }, { tag: 'nan', files: 'x' }],
    files: '12', undated: -4
  });
  assert.deepStrictEqual(odd.tags, [{ tag: 'ok', files: 9, entries: 0 }, { tag: 'nan', files: 0, entries: 0 }], 'rows that are not tags are dropped, a tag seen twice keeps the larger count, counts are whole numbers');
  assert.strictEqual(odd.files, 12);
  assert.strictEqual(odd.undated, 0);
  assert.strictEqual(SF.normalizeOptions({ undated: 2.9 }).undated, 2);
  // a name in Japanese is a name like any other
  assert.deepStrictEqual(SF.normalizeOptions({ tags: [{ tag: '仕事', files: 3 }, { tag: '買い物', files: 3 }] }).tags.map((x) => x.tag), ['仕事', '買い物'].sort());
})();

(function testTagView() {
  const mk = (n) => ({ tags: Array.from({ length: n }, (_, i) => ({ tag: 'tag' + String(i).padStart(3, '0'), files: 1000 - i, entries: 1 })) });
  assert.deepStrictEqual(SF.tagView(null, []), { shown: [], more: 0 });
  assert.deepStrictEqual(SF.tagView(undefined, undefined), { shown: [], more: 0 });
  assert.deepStrictEqual(SF.tagView({ tags: 'no' }, []), { shown: [], more: 0 });

  let v = SF.tagView(mk(3), []);
  assert.strictEqual(v.shown.length, 3);
  assert.strictEqual(v.more, 0);
  v = SF.tagView(mk(40), []);
  assert.strictEqual(v.shown.length, 40, '40 fit');
  assert.strictEqual(v.more, 0);
  v = SF.tagView(mk(41), []);
  assert.strictEqual(v.shown.length, 40);
  assert.strictEqual(v.more, 1);
  v = SF.tagView(mk(100), []);
  assert.strictEqual(v.shown.length, 40, 'at most 40 buttons');
  assert.strictEqual(v.more, 60);
  assert.strictEqual(v.shown[0].tag, 'tag000');
  assert.strictEqual(v.shown[39].tag, 'tag039', 'the list order is kept');
  assert.strictEqual(SF.MAX_TAGS_SHOWN, 40);

  // a chosen tag is drawn even when it is beyond the 40th (or gone), so it can be let go
  v = SF.tagView(mk(50), ['tag045']);
  assert.strictEqual(v.shown.length, 41);
  assert.strictEqual(v.shown[40].tag, 'tag045');
  assert.strictEqual(v.shown[40].files, 955, 'with its own numbers');
  assert.strictEqual(v.more, 9, 'and it is no longer counted as left out');
  v = SF.tagView(mk(5), ['gone']);
  assert.deepStrictEqual(v.shown[5], { tag: 'gone', files: 0, entries: 0 });
  assert.strictEqual(v.more, 0);
  v = SF.tagView(mk(5), ['tag001']);
  assert.strictEqual(v.shown.length, 5, 'a chosen tag that is already shown is not drawn twice');
})();

(function testUndatedNotice() {
  const opts = { tags: [], files: 20, undated: 3 };
  const week = SF.setPeriod(SF.create(), 'week');
  assert.strictEqual(SF.undatedNotice(week, opts), 3, 'a period is chosen and notes have no date: say how many');
  assert.strictEqual(SF.undatedNotice(SF.create(), opts), 0, 'no period: nothing is left out of a period');
  assert.strictEqual(SF.undatedNotice(SF.toggleTag(SF.create(), 'work'), opts), 0, 'a tag alone leaves no note out because of its date');
  assert.strictEqual(SF.undatedNotice(week, { undated: 0 }), 0, 'every note has a date: no line');
  assert.strictEqual(SF.undatedNotice(week, null), 0, 'the options did not arrive');
  assert.strictEqual(SF.undatedNotice(week, {}), 0);
  assert.strictEqual(SF.undatedNotice(week, { undated: 'x' }), 0);
  assert.strictEqual(SF.undatedNotice(null, opts), 0);
  ['today', 'week', 'days30', 'month'].forEach((p) => assert.strictEqual(SF.undatedNotice(SF.setPeriod(SF.create(), p), opts), 3, p));
})();

(function testEmptyMessageKey() {
  assert.strictEqual(SF.emptyMessageKey(null, false), 'scrapsSearchEmpty', 'no text typed: the usual invitation, filter or not');
  assert.strictEqual(SF.emptyMessageKey({ tags: ['a'] }, false), 'scrapsSearchEmpty');
  assert.strictEqual(SF.emptyMessageKey(null, true), 'scrapsSearchNoResults', 'text typed, no filter: the usual sentence');
  assert.strictEqual(SF.emptyMessageKey(undefined, true), 'scrapsSearchNoResults');
  assert.strictEqual(SF.emptyMessageKey({ tags: ['a'] }, true), 'scrapsFilterNoResults', 'text typed, a filter: the notes are missing because of it');
  assert.strictEqual(SF.emptyMessageKey({ from: '2026-10-03', to: '2026-10-03' }, true), 'scrapsFilterNoResults');
  [['scrapsFilterNoResults', 'No notes match the filter', '条件に合うノートがありません'], ['scrapsSearchNoResults', null, null]].forEach(([key, en, ja]) => {
    assert.ok(I18N.en[key] && I18N.ja[key], key);
    if (en) { assert.strictEqual(I18N.en[key], en); assert.strictEqual(I18N.ja[key], ja); }
  });
})();

const buttons = (html) => html.match(/<button\b[^>]*>/g) || [];
const attrOf = (tag, name) => { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; };

(function testAreaHtml() {
  const options = SF.normalizeOptions({ tags: [{ tag: 'work', files: 8, entries: 9 }, { tag: 'reading', files: 5, entries: 5 }, { tag: 'idea', files: 1, entries: 1 }], files: 14, undated: 2 });
  let html = SF.areaHtml({ state: SF.create(), status: 'ready', options }, tEn);

  const periods = buttons(html).filter((b) => attrOf(b, 'data-filter-period') !== null);
  assert.deepStrictEqual(periods.map((b) => attrOf(b, 'data-filter-period')), ['all', 'today', 'week', 'days30', 'month']);
  assert.deepStrictEqual(periods.map((b) => attrOf(b, 'aria-pressed')), ['true', 'false', 'false', 'false', 'false'], 'one period is chosen: "all"');
  const tags = buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null);
  assert.deepStrictEqual(tags.map((b) => attrOf(b, 'data-filter-tag')), ['work', 'reading', 'idea']);
  assert.deepStrictEqual(tags.map((b) => attrOf(b, 'aria-pressed')), ['false', 'false', 'false']);
  assert.strictEqual(attrOf(tags[0], 'title'), 'Notes with this tag: 8');
  // every button stays out of the Tab order (Tab in the search box quotes the line) and is a plain button
  buttons(html).forEach((b) => {
    assert.strictEqual(attrOf(b, 'tabindex'), '-1', b);
    assert.strictEqual(attrOf(b, 'type'), 'button', b);
  });
  assert.ok(!/data-filter-clear/.test(html), 'nothing is chosen: no Clear');
  assert.ok(!/scraps-filter-note/.test(html), 'and no line about notes without a date');
  assert.ok(/role="group" aria-label="Period"/.test(html) && /role="group" aria-label="Tags"/.test(html), 'two groups, named');
  assert.ok(/>All</.test(html) && />Today</.test(html) && />Last 7 days</.test(html) && />Last 30 days</.test(html) && />This month</.test(html));

  // chosen tags and period
  let st = SF.setPeriod(SF.toggleTag(SF.toggleTag(SF.create(), 'work'), 'idea'), 'week');
  html = SF.areaHtml({ state: st, status: 'ready', options }, tEn);
  const p2 = buttons(html).filter((b) => attrOf(b, 'data-filter-period') !== null);
  assert.deepStrictEqual(p2.map((b) => attrOf(b, 'aria-pressed')), ['false', 'false', 'true', 'false', 'false']);
  const t2 = buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null);
  assert.deepStrictEqual(t2.map((b) => attrOf(b, 'aria-pressed')), ['true', 'false', 'true']);
  assert.ok(/class="scraps-filter-chip on"[^>]*data-filter-tag="work"/.test(html), 'a chosen chip carries the "on" class');
  assert.ok(/data-filter-clear/.test(html), 'Clear is there while something is chosen');
  assert.ok(/2 notes without a date are not in the period\./.test(html), 'a period is chosen and notes have no date');
  // ... and in Japanese
  const ja = SF.areaHtml({ state: st, status: 'ready', options }, tJa);
  assert.ok(ja.indexOf('日付のないノート 2 件は期間に入りません') !== -1, ja);
  assert.ok(ja.indexOf('>解除<') !== -1 && ja.indexOf('>すべて<') !== -1 && ja.indexOf('>今月<') !== -1 && ja.indexOf('>7 日間<') !== -1);
  assert.ok(ja.indexOf('aria-label="期間"') !== -1 && ja.indexOf('aria-label="タグ"') !== -1);
  assert.ok(ja.indexOf('このタグのノート: 8 件') !== -1);

  // one note without a date: its own sentence; none: no sentence; a tag alone: no sentence
  html = SF.areaHtml({ state: SF.setPeriod(SF.create(), 'today'), status: 'ready', options: { ...options, undated: 1 } }, tEn);
  assert.ok(/1 note without a date is not in the period\./.test(html));
  html = SF.areaHtml({ state: SF.setPeriod(SF.create(), 'today'), status: 'ready', options: { ...options, undated: 0 } }, tEn);
  assert.ok(!/scraps-filter-note/.test(html) && /data-filter-clear/.test(html), 'a period, every note has a date: Clear but no sentence');
  html = SF.areaHtml({ state: SF.toggleTag(SF.create(), 'work'), status: 'ready', options }, tEn);
  assert.ok(!/scraps-filter-note/.test(html), 'a tag alone: the dates do not matter');
  // while the options are not there the sentence cannot be said
  html = SF.areaHtml({ state: SF.setPeriod(SF.create(), 'today'), status: 'loading', options: null }, tEn);
  assert.ok(!/scraps-filter-note/.test(html));

  // the states of the tag list
  html = SF.areaHtml({ state: SF.create(), status: 'loading' }, tEn);
  assert.ok(/Reading the tags\.\.\./.test(html) && buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null).length === 0);
  assert.strictEqual(buttons(html).filter((b) => attrOf(b, 'data-filter-period') !== null).length, 5, 'the period needs no list: it works at once');
  html = SF.areaHtml({ state: SF.create() }, tEn);
  assert.ok(/Reading the tags/.test(html), 'a view with no status is still waiting');
  html = SF.areaHtml({ state: SF.create(), status: 'failed', message: 'it broke <b>' }, tEn);
  assert.ok(/scraps-filter-status-error/.test(html) && /Could not read the tags: it broke &lt;b&gt;/.test(html), 'the reason, escaped');
  html = SF.areaHtml({ state: SF.create(), status: 'failed' }, tEn);
  assert.ok(/Could not read the tags: \?/.test(html));
  html = SF.areaHtml({ state: SF.create(), status: 'ready', options: SF.normalizeOptions({ tags: [], files: 3 }) }, tEn);
  assert.ok(/No tags yet\. Write &lt;!-- tags: work --&gt; on a line of a note to add one\./.test(html), 'no tags: how to add one, as text');
  assert.ok(html.indexOf('<!--') === -1, 'and never as a live comment in the markup');
  html = SF.areaHtml({ state: SF.create(), status: 'ready', options: SF.normalizeOptions({ tags: [], files: 3 }) }, tJa);
  assert.ok(html.indexOf('&lt;!-- tags: 仕事 --&gt;') !== -1);
  // a chosen tag is drawn while the list is not there, so it can still be let go
  html = SF.areaHtml({ state: SF.toggleTag(SF.create(), 'work'), status: 'loading' }, tEn);
  const kept = buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(attrOf(kept[0], 'aria-pressed'), 'true');
  assert.strictEqual(attrOf(kept[0], 'title'), null, 'it has no count to show');

  // names are text, not markup
  const hostile = SF.normalizeOptions({ tags: [{ tag: 'a"b<i>&c', files: 2 }, { tag: '</button><img src=x>', files: 1 }] });
  html = SF.areaHtml({ state: SF.create(), status: 'ready', options: hostile }, tEn);
  assert.ok(!/<img/i.test(html) && !/<i>/.test(html), html);
  assert.ok(html.indexOf('data-filter-tag="a&quot;b&lt;i&gt;&amp;c"') !== -1, html);
  assert.ok(html.indexOf('>a&quot;b&lt;i&gt;&amp;c<') !== -1);

  // no emoji or pictograph in the markup
  assert.ok(!/\p{Extended_Pictographic}/u.test(SF.areaHtml({ state: st, status: 'ready', options }, tEn)));
})();

(function testAreaHtmlLimits() {
  // 45 tags: 40 buttons and "5 more" as text, not a button
  const many = SF.normalizeOptions({ tags: Array.from({ length: 45 }, (_, i) => ({ tag: 'tag' + String(i).padStart(2, '0'), files: 100 - i, entries: 1 })) });
  let html = SF.areaHtml({ state: SF.create(), status: 'ready', options: many }, tEn);
  const tags = buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null);
  assert.strictEqual(tags.length, 40);
  assert.ok(/<span class="scraps-filter-more">5 more<\/span>/.test(html), html);
  assert.ok(SF.areaHtml({ state: SF.create(), status: 'ready', options: many }, tJa).indexOf('<span class="scraps-filter-more">他 5 個</span>') !== -1);
  assert.ok(!/scraps-filter-more/.test(SF.areaHtml({ state: SF.create(), status: 'ready', options: SF.normalizeOptions({ tags: [{ tag: 'a', files: 1 }] }) }, tEn)), 'nothing left out: no "more"');

  // 8 tags chosen: the others cannot be chosen (and say why); the chosen ones can still be let go
  let st = SF.create();
  for (let i = 0; i < 8; i++) st = SF.toggleTag(st, 'tag0' + i);
  html = SF.areaHtml({ state: st, status: 'ready', options: many }, tEn);
  const all = buttons(html).filter((b) => attrOf(b, 'data-filter-tag') !== null);
  const off = all.filter((b) => /\sdisabled(\s|>|=)/.test(b));
  assert.strictEqual(all.length, 40);
  assert.strictEqual(off.length, 32, 'the 32 that are not chosen');
  off.forEach((b) => { assert.strictEqual(attrOf(b, 'aria-pressed'), 'false'); assert.strictEqual(attrOf(b, 'title'), 'Up to 8 tags at a time'); });
  all.filter((b) => attrOf(b, 'aria-pressed') === 'true').forEach((b) => assert.ok(!/\sdisabled/.test(b), 'a chosen one is not disabled'));
  // fewer than 8: none disabled
  html = SF.areaHtml({ state: SF.toggleTag(SF.create(), 'tag00'), status: 'ready', options: many }, tEn);
  assert.ok(!/\sdisabled/.test(html));
})();

(function testStringsExistInBothLanguages() {
  // Every i18n key this module can use, found in its source, exists in English and Japanese; the English has no Japanese in it
  const src = fs.readFileSync(path.join(__dirname, 'scraps_filter.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/'(scraps[A-Za-z0-9]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size >= 14, 'found the keys: ' + keys.size);
  const CJK = /[぀-ヿ一-鿿＀-￯]/;
  keys.forEach((k) => {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], 'en is missing ' + k);
    assert.ok(typeof I18N.ja[k] === 'string' && I18N.ja[k], 'ja is missing ' + k);
    assert.ok(!CJK.test(I18N.en[k]), 'the English string for ' + k + ' has Japanese in it');
    assert.ok(!/\p{Extended_Pictographic}/u.test(I18N.en[k] + I18N.ja[k]), k + ' has an emoji');
  });
  // the same {placeholders} in both languages
  keys.forEach((k) => {
    const ph = (s) => (s.match(/\{[a-z]+\}/g) || []).filter((x, i, a) => a.indexOf(x) === i).sort().join(',');
    if (k === 'scrapsFilterUndatedOne') return; // says "1" in words
    assert.strictEqual(ph(I18N.ja[k]), ph(I18N.en[k]), 'placeholders of ' + k);
  });
  // the source itself has no emoji
  assert.ok(!/\p{Extended_Pictographic}/u.test(src));
  // the periods name keys that exist
  SF.PERIODS.forEach((p) => assert.ok(I18N.en[p.key] && I18N.ja[p.key], p.key));
})();

(function testNothingRunsAtLoad() {
  // The module only defines functions: no DOM, no timer, no listener when it is loaded
  const src = fs.readFileSync(path.join(__dirname, 'scraps_filter.js'), 'utf8');
  assert.ok(!/\b(document|setTimeout|setInterval|addEventListener|requestAnimationFrame)\b/.test(src.replace(/\/\/.*$/gm, '')), 'no DOM or timer use');
})();

console.log('scraps_filter tests passed');
