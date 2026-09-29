// The AI item of the status bar: it says where the AI runs, opens a popover with the three helpers as switches, a switch flips the
// setting and saves it, "Suggestions" off hides its Ctrl+J sub-switch, Escape and a click outside close the popover with the
// focus going back to the item. (UX review B5.)
import { assert, click, lastSavedConfig, liveConfig, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';

const aria = (s, id) => s.ev(`document.getElementById('${id}').getAttribute('aria-checked')`);

export default {
  title: 'status bar AI item: popover, switches persist, Escape and outside click close',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },

  async run(s, t) {
    t.step('the item names a model that can answer');
    const cls = await s.ev("document.getElementById('stat-ai').className");
    assert.ok(!/status-ai-unset|status-ai-error/.test(cls), `the AI item is in its normal state: ${cls}`);
    assert.equal(await shown(s, 'status-ai-pop'), false, 'the popover is closed at first');
    assert.equal(await s.ev("document.getElementById('stat-ai').getAttribute('aria-expanded')"), 'false');

    t.step('click opens the popover with three switches');
    await click(s, 'stat-ai');
    await waitShown(s, 'status-ai-pop');
    assert.equal(await s.ev("document.getElementById('stat-ai').getAttribute('aria-expanded')"), 'true');
    assert.equal(await s.ev("document.querySelectorAll('#status-ai-pop [role=switch]').length"), 4, 'prediction, suggestions, its manual sub-switch, voice');
    assert.equal(await aria(s, 'stat-autocomplete'), 'true', 'text prediction starts on (the demo config)');
    assert.equal(await aria(s, 'stat-action'), 'true');
    assert.equal(await shown(s, 'stat-action-manual'), true, 'the "only when I press the key" sub-switch shows while Suggestions is on');
    assert.equal(await aria(s, 'stat-action-manual'), 'false');
    await waitFocus(s, 'stat-autocomplete');

    t.step('a switch flips the setting and saves it');
    await click(s, 'stat-autocomplete');
    await s.waitFor("document.getElementById('stat-autocomplete').getAttribute('aria-checked') === 'false'");
    assert.equal((await liveConfig(s)).autocomplete.enabled, false, 'the running app has text prediction off');
    await s.waitFor("window.__docshot.calls.some(function (c) { return c.fn === 'saveConfig'; })");
    assert.equal((await lastSavedConfig(s)).autocomplete.enabled, false, 'and the saved settings too');
    assert.ok((await s.state()).toasts.length > 0, 'a message told what changed');

    t.step('Suggestions off hides the sub-switch');
    await click(s, 'stat-action');
    await s.waitFor("document.getElementById('stat-action').getAttribute('aria-checked') === 'false'");
    assert.equal(await shown(s, 'stat-action-manual'), false, 'the sub-switch is gone');
    assert.equal((await liveConfig(s)).action.enabled, false);
    await click(s, 'stat-action'); // back on
    await s.waitFor("document.getElementById('stat-action').getAttribute('aria-checked') === 'true'");
    assert.equal(await shown(s, 'stat-action-manual'), true);

    t.step('Escape closes it and the focus goes back to the item');
    await s.key('Escape');
    await waitHidden(s, 'status-ai-pop');
    await waitFocus(s, 'stat-ai');
    assert.equal(await s.ev("document.getElementById('stat-ai').getAttribute('aria-expanded')"), 'false');

    t.step('the keyboard opens it too, and a click outside closes it');
    await s.key('Enter');
    await waitShown(s, 'status-ai-pop');
    assert.equal(await aria(s, 'stat-autocomplete'), 'false', 'the popover shows the saved state');
    await click(s, 'editor');
    await waitHidden(s, 'status-ai-pop');
    assert.equal((await s.state()).tabs[0].content, 'text\n', 'none of this touched the note');
  },
};
