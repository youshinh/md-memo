// Settings: Ctrl+, opens it, a switch flips with a real click, Cancel throws the change away, Save keeps it (saved config, the
// status bar, and the next time the dialog opens), Escape closes it. The switch is "Autosave" - a setting with a visible effect
// in the status bar, so the flow can see that the change really reached the app.
import { assert, click, lastSavedConfig, backendCalls, liveConfig, waitHidden, waitShown } from './lib.mjs';

const SWITCH = 'cfg-autosave';
const checked = (s) => s.ev(`document.getElementById('${SWITCH}').checked`);

async function openSettings(s) {
  await s.key(',', { ctrl: true });
  await waitShown(s, 'settings-modal');
  await s.waitFor(`document.getElementById('${SWITCH}').getBoundingClientRect().width > 0`);
}

export default {
  title: 'settings: open, flip a switch, Cancel discards, Save persists, Escape closes',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },

  async run(s, t) {
    t.step('open Settings');
    await openSettings(s);
    assert.equal(await s.ev("document.getElementById('tab-btn-general').classList.contains('active')"), true, 'it opens on the General tab');
    assert.equal(await checked(s), true, 'Autosave starts on (the demo config)');
    assert.equal(await s.ev("document.getElementById('stat-autosave').getAttribute('aria-pressed')"), 'true', 'and the status bar agrees');
    const savesBefore = (await backendCalls(s, 'saveConfig')).length;

    t.step('flip the switch and Cancel');
    await click(s, SWITCH);
    assert.equal(await checked(s), false, 'the click flipped the switch');
    await click(s, 'btn-cancel-settings');
    await waitHidden(s, 'settings-modal');
    assert.equal((await backendCalls(s, 'saveConfig')).length, savesBefore, 'Cancel saved nothing');
    assert.equal((await liveConfig(s)).general.autoSave, true, 'the app still has Autosave on');
    await openSettings(s);
    assert.equal(await checked(s), true, 'the reopened dialog shows the old value again');

    t.step('flip the switch and Save');
    await click(s, SWITCH);
    assert.equal(await checked(s), false);
    await click(s, 'btn-save-settings');
    await waitHidden(s, 'settings-modal');
    await s.waitFor(`document.getElementById('stat-autosave').getAttribute('aria-pressed') === 'false'`);
    const saved = await lastSavedConfig(s);
    assert.ok(saved, 'the settings were sent to be saved');
    assert.equal(saved.general.autoSave, false, 'the saved settings carry Autosave off');
    assert.equal((await liveConfig(s)).general.autoSave, false, 'the running app uses it');
    assert.equal(JSON.parse(await s.ev("localStorage.getItem('md_notepad_config_v3')")).general.autoSave, false, 'and the copy the WebView keeps');
    assert.ok((await s.state()).toasts.length > 0, 'a message said the settings were saved');

    t.step('the next time it opens, the value is there; put it back');
    await openSettings(s);
    assert.equal(await checked(s), false, 'the dialog shows the saved value');
    await click(s, SWITCH);
    await click(s, 'btn-save-settings');
    await waitHidden(s, 'settings-modal');
    await s.waitFor(`document.getElementById('stat-autosave').getAttribute('aria-pressed') === 'true'`);
    assert.equal((await lastSavedConfig(s)).general.autoSave, true, 'saved on again');

    t.step('Escape closes the dialog');
    await openSettings(s);
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');
    assert.equal((await s.state()).panels.settings, false);
  },
};
