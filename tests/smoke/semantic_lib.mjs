// Helpers the meaning-search and deep-search flows share (92_* to 96_*). Not a flow itself (the runner only loads NN_*.mjs and NNN_*.mjs files).
// Everything here drives the page through the session `s` and the mock backend's knobs (window.__docshot.semantic / .deep in
// tools/docshots/mock/backend.js); nothing touches a real config, note or model.
import { assert, click, shown, waitFocus, waitShown } from './lib.mjs';

export const SEMANTIC_ON = { config: { semantic: { enabled: true } } };

export const visible = (s, id) => s.ev(`(function () {
  var e = document.getElementById(${JSON.stringify(id)});
  if (!e || e.classList.contains('hidden')) return false;
  var r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
})()`);

// A string of the UI language from the i18n table, with {name} placeholders filled in (what the app itself would show).
export const phrase = (s, key, params = {}) => s.ev(`(function () {
  var text = I18N[document.documentElement.lang][${JSON.stringify(key)}];
  var params = ${JSON.stringify(params)};
  Object.keys(params).forEach(function (k) { text = text.split('{' + k + '}').join(String(params[k])); });
  return text;
})()`);

export const textOf = (s, selector) => s.ev(`(function () { var e = document.querySelector(${JSON.stringify(selector)}); return e ? e.textContent : null; })()`);

export const itemCount = (s) => s.ev("document.querySelectorAll('#scraps-search-results .scraps-match-item').length");

// The queries the mock backend was asked, in order, for a search function ('searchScraps' / 'searchScrapsSemantic') or a deep call.
export const asked = (s, fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${JSON.stringify(fn)}; }).map(function (c) { return c.args; })`);

// Opens the daily notes search (Ctrl+Shift+F) and waits until it can be typed into.
export async function openSearch(s) {
  await s.key('f', { ctrl: true, shift: true });
  await waitShown(s, 'scraps-search-modal');
  await waitFocus(s, 'scraps-search-input');
}

// Replaces the query: select all, type. Resolves once the new text is in the box (the answer for it comes later).
export async function typeQuery(s, text) {
  await s.key('a', { ctrl: true });
  await s.type(text);
  await s.waitFor(`document.getElementById('scraps-search-input').value === ${JSON.stringify(text)}`);
}

// Waits for a meaning list for the current query to be on screen: items drawn, nothing stale, so the Deep search button is up.
export const waitMeaningList = (s) => s.waitFor(`document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0 &&
  !document.getElementById('btn-scraps-deep').classList.contains('hidden')`);

// Search panel open, Meaning chosen, `query` typed, its list and the Deep search button on screen.
export async function openMeaning(s, query) {
  await openSearch(s);
  if ((await s.ev("document.getElementById('scraps-mode-meaning').getAttribute('aria-pressed')")) !== 'true') await click(s, 'scraps-mode-meaning');
  await typeQuery(s, query);
  await waitMeaningList(s);
}

// Presses the Deep search button and waits for the confirmation dialog (it is shown only for a plan that can be run).
export async function openDeepDialog(s) {
  await click(s, 'btn-scraps-deep');
  await waitShown(s, 'deep-search-modal');
  await waitFocus(s, 'deep-search-cancel');
}

export const deepKnobs = (s, patch) => s.ev(`Object.assign(window.__docshot.deep, ${JSON.stringify(patch)}); 1`);
export const semanticKnobs = (s, patch) => s.ev(`Object.assign(window.__docshot.semantic, ${JSON.stringify(patch)}); 1`);

export { assert, shown };
