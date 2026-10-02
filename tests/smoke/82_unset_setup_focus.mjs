// No AI model set up, and the ways in to Settings > AI Models (first-run sessions C9-12 and C13-09): the window used to show the
// AI Models tab with the focus left on the General tab, so a keyboard user had to find the way down by hand. Now the focus goes to
// the tab that is showing, and "Set up" (and the palette's "AI model setup") puts it on the first field to fill in.
import { assert, click, runPaletteCommand, selectInEditor, openAsk, waitFocus, waitHidden, waitShown } from './lib.mjs';

export default {
  title: 'unset AI: Set up and the palette focus the model field; Settings focuses the tab it opened on',
  session: {
    notes: [{ title: 'fruit.md', content: 'banana\napple\n' }],
    config: { text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: '' } },
  },

  async run(s, t) {
    t.step('the ask bar\'s Set up puts the focus on the first field of the text model');
    await selectInEditor(s, 'banana');
    await openAsk(s);
    await click(s, 'btn-inline-prompt-setup');
    await waitShown(s, 'settings-modal');
    assert.equal(await s.ev("document.getElementById('tab-btn-model').classList.contains('active')"), true, 'AI Models is showing');
    await waitFocus(s, 'cfg-base-url');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('the status bar item opens the same tab with the focus on that tab, not on General');
    await click(s, 'stat-ai');
    await waitShown(s, 'settings-modal');
    await waitFocus(s, 'tab-btn-model');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('Settings from the keyboard still starts on General');
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    await waitFocus(s, 'tab-btn-general');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('the palette finds the AI settings by its words, and opens them with the field focused');
    await runPaletteCommand(s, t.pick('AI model setup', 'AIモデルの設定'));
    await waitShown(s, 'settings-modal');
    assert.equal(await s.ev("document.getElementById('tab-btn-model').classList.contains('active')"), true);
    await waitFocus(s, 'cfg-base-url');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('"language" finds the General settings in the palette');
    await runPaletteCommand(s, t.pick('language', '言語'));
    await waitShown(s, 'settings-modal');
    assert.equal(await s.ev("document.getElementById('tab-btn-general').classList.contains('active')"), true, 'General is showing');
    await waitFocus(s, 'tab-btn-general');
  },
};
