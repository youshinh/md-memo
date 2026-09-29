// Changing the UI language in Settings takes effect everywhere at once (UX review bug B29). Four things used to keep the old
// language until the next start: the AI item of the status bar ("AI: local"), the tooltip of a tab's close button, the
// button names that a11y.js sets for screen readers (a two-letter Japanese "置換" is given an aria-label, English "Replace" is
// not, and the old label stayed), and the "Protocol: Ollama" line of the AI Models pane. The flow switches to the other
// language and back, so both directions are checked whatever language the run started in.
import { assert, click, waitShown } from './lib.mjs';

const other = (lang) => (lang === 'ja' ? 'en' : 'ja');

async function setLanguage(s, lang) {
  await s.ev(`(function () { var e = document.getElementById('cfg-language'); e.value = ${JSON.stringify(lang)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await s.waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`);
}

// What every one of the four should read in `lang` (from the tables in i18n.js, not from the page's own t()).
async function expectLanguage(s, lang, where) {
  const want = await s.ev(`(function () {
    var T = I18N[${JSON.stringify(lang)}];
    var model = (MdMemoBridge.getConfig().text || {}).model || '';
    return {
      aiLabel: T.statAiLocal,
      aiTitle: T.statAiTitleLocal.replace('{model}', model),
      protocol: T.llmProtocolDetected.replace('{protocol}', T.providerOllama),
      closeTitle: T.closeTabTitle
    };
  })()`);
  const got = await s.ev(`(function () {
    var nameOf = function (id) { var e = document.getElementById(id); return { label: e.getAttribute('aria-label'), text: e.textContent.trim(), title: e.title, mark: e.hasAttribute('data-a11y-label'), need: A11y.needsLabel(e.textContent, !!e.title) }; };
    var close = document.querySelector('.tab-close');
    var stale = Array.prototype.filter.call(document.querySelectorAll('[data-a11y-label]'), function (b) { return !A11y.needsLabel(b.textContent, !!b.title); }).map(function (b) { return b.id || b.className; });
    return {
      aiLabel: document.getElementById('stat-ai').textContent,
      aiTitle: document.getElementById('stat-ai').title,
      protocol: document.getElementById('text-provider-detect-line').textContent,
      closeTitle: close ? close.title : null,
      replace: nameOf('btn-replace-one'),
      run: nameOf('btn-inline-prompt-send'),
      stale: stale
    };
  })()`);
  // All four are looked at before the flow fails, so that one run names every symptom that is still there.
  const problems = [];
  const same = (actual, expected, what) => { if (actual !== expected) problems.push(`${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`); };
  same(got.aiLabel, want.aiLabel, 'the AI item of the status bar');
  same(got.aiTitle, want.aiTitle, 'the tooltip of the AI item');
  same(got.protocol, want.protocol, 'the protocol line of the AI Models pane');
  same(got.closeTitle, want.closeTitle, 'the tooltip of the tab close button');
  if (got.stale.length) problems.push(`buttons that keep an aria-label although their visible text now names them: ${got.stale.join(', ')}`);
  for (const key of ['replace', 'run']) {
    const b = got[key];
    const id = key === 'replace' ? 'btn-replace-one' : 'btn-inline-prompt-send';
    // A name is given exactly when the text alone does not name the button; then it is the button's title.
    if ((b.label !== null) !== b.need) problems.push(`#${id} has ${b.label === null ? 'no' : 'an'} aria-label (${JSON.stringify(b)})`);
    else if (b.need && b.label !== b.title) problems.push(`#${id}: its aria-label ${JSON.stringify(b.label)} does not follow its title ${JSON.stringify(b.title)}`);
  }
  assert.deepEqual(problems, [], `${where}: still in the old language`);
}

export default {
  title: 'changing the UI language updates the AI item, tab tooltips, button names and the protocol line at once',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },

  async run(s, t) {
    t.step('open Settings on the AI Models pane, wait for the protocol line');
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    await click(s, 'tab-btn-model');
    await s.waitFor("!document.getElementById('text-provider-detect-line').classList.contains('hidden') && document.getElementById('text-provider-detect-line').textContent.length > 0");
    await expectLanguage(s, t.lang, `as started (${t.lang})`);

    const there = other(t.lang);
    t.step(`switch the language to ${there}`);
    await setLanguage(s, there);
    await expectLanguage(s, there, `switched to ${there}, dialog still open`);

    t.step(`Save, then look again in ${there}`);
    await click(s, 'btn-save-settings');
    await s.waitFor("document.getElementById('settings-modal').classList.contains('hidden')");
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    await click(s, 'tab-btn-model');
    await s.waitFor("!document.getElementById('text-provider-detect-line').classList.contains('hidden')");
    await expectLanguage(s, there, `saved in ${there}`);

    t.step(`switch back to ${t.lang}`);
    await setLanguage(s, t.lang);
    await expectLanguage(s, t.lang, `switched back to ${t.lang}, dialog still open`);
  },
};
