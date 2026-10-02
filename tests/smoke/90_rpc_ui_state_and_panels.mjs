// The JSON-RPC UI calls of the page (window.__mdMemoRPC.getUiState / setUiState / openPanel, behind `ui.get` / `ui.set` /
// `ui.open_panel`): what the window shows (preview, split, zen), changing it through the same functions the shortcuts and the
// palette call, and opening the panels the palette opens. A key that already holds is left alone; a bad value, an impossible pair
// of keys or an unknown panel is an invalid_params error that changes nothing.
import { assert, rpc, settle, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';

const A = 'tab_x1';

const ui = async (s) => (await rpc(s, 'getUiState()')).ok;
const set = async (s, spec) => rpc(s, `setUiState(${JSON.stringify(spec)})`);

// What is on screen for the layout state, from the DOM (not from the state the RPC reports).
const layout = (s) => s.ev(`(function () {
  function vis(id) { var e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); }
  return {
    editorPane: vis('editor-pane'), fullPreview: vis('preview-pane'), secondary: vis('secondary-pane'),
    secondaryPreview: vis('secondary-preview-pane'), secondaryEditor: vis('secondary-editor-pane'),
    zen: document.body.classList.contains('zen-mode')
  };
})()`);

// The plain layout: the editor alone, no preview, no split, no zen.
async function assertPlainLayout(s, message) {
  const l = await layout(s);
  assert.deepEqual([l.editorPane, l.fullPreview, l.secondary, l.zen], [true, false, false, false], message || 'the plain layout');
}

const PANELS = ['find', 'replace', 'scraps_search', 'settings', 'shortcuts', 'snippets', 'all_tabs', 'command_palette', 'about'];

export default {
  title: 'ui RPC: getUiState / setUiState (preview, split, zen) and openPanel use the app\'s own toggles and panels, idempotent and safe',
  session: { notes: [{ title: 'a.md', content: '# Title\n\nsome text\n', cursor: 0 }, { title: 'b.md', content: 'second note\n' }] },
  timeoutMs: 60000,

  async run(s, t) {
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(A)}`);

    t.step('getUiState: the starting layout');
    let st = await ui(s);
    assert.deepEqual(Object.keys(st).sort(), ['activeTabId', 'fullscreen', 'preview', 'secondaryTabId', 'splitMode', 'zen']);
    assert.equal(st.activeTabId, A);
    assert.equal(st.splitMode, false);
    assert.equal(st.secondaryTabId, null);
    assert.equal(st.preview, 'off');
    assert.equal(st.zen, false);
    assert.ok(st.fullscreen === null || typeof st.fullscreen === 'boolean', 'fullscreen is a boolean, or null when the page cannot tell');

    t.step('setUiState with nothing to set changes nothing and returns the state');
    assert.deepEqual((await set(s, {})).ok, st);
    assert.deepEqual((await rpc(s, 'setUiState()')).ok, st);

    t.step('preview "full": the preview replaces the editor; again is a no-op; "off" brings the editor back');
    let r = await set(s, { preview: 'full' });
    assert.equal(r.ok.preview, 'full');
    assert.equal(r.ok.splitMode, false);
    let lay = await layout(s);
    assert.deepEqual([lay.editorPane, lay.fullPreview], [false, true]);
    r = await set(s, { preview: 'full' });
    assert.equal(r.ok.preview, 'full', 'asking for what already holds does not toggle it back');
    assert.equal((await layout(s)).fullPreview, true);
    r = await set(s, { preview: 'off' });
    assert.equal(r.ok.preview, 'off');
    await assertPlainLayout(s, 'the editor is back');
    r = await set(s, { preview: 'off' });
    assert.equal(r.ok.preview, 'off');
    assert.equal((await layout(s)).editorPane, true);

    t.step('preview "side": the split\'s right-hand pane shows the preview of the active note; again is a no-op');
    r = await set(s, { preview: 'side' });
    assert.deepEqual(r.ok, { ...st, preview: 'side', splitMode: true, secondaryTabId: A });
    lay = await layout(s);
    assert.deepEqual([lay.editorPane, lay.secondary, lay.secondaryPreview], [true, true, true]);
    r = await set(s, { preview: 'side' });
    assert.equal(r.ok.preview, 'side');
    assert.equal((await ui(s)).secondaryTabId, A);
    assert.equal((await rpc(s, 'getUiState()')).ok.preview, 'side', 'getUiState agrees');

    t.step('split:true while the side preview is open keeps it (it already is a split); preview "off" closes the split');
    r = await set(s, { split: true });
    assert.deepEqual([r.ok.preview, r.ok.splitMode], ['side', true]);
    r = await set(s, { preview: 'off' });
    assert.deepEqual([r.ok.preview, r.ok.splitMode, r.ok.secondaryTabId], ['off', false, null]);
    assert.equal((await layout(s)).secondary, false);

    t.step('split:true opens the second editor on another note; again is a no-op; split:false closes it');
    r = await set(s, { split: true });
    assert.equal(r.ok.splitMode, true);
    assert.equal(r.ok.preview, 'off');
    assert.ok(r.ok.secondaryTabId && r.ok.secondaryTabId !== A, 'the other note');
    lay = await layout(s);
    assert.deepEqual([lay.secondary, lay.secondaryEditor, lay.secondaryPreview], [true, true, false]);
    const secondary = r.ok.secondaryTabId;
    r = await set(s, { split: true });
    assert.equal(r.ok.secondaryTabId, secondary, 'the same second note, nothing reopened');
    r = await set(s, { split: false });
    assert.deepEqual([r.ok.splitMode, r.ok.secondaryTabId], [false, null]);
    r = await set(s, { split: false });
    assert.equal(r.ok.splitMode, false);

    t.step('the side preview turned into a two-editor split, and the full preview closing a split');
    await set(s, { preview: 'side' });
    r = await set(s, { preview: 'off', split: true });
    assert.deepEqual([r.ok.preview, r.ok.splitMode], ['off', true]);
    lay = await layout(s);
    assert.deepEqual([lay.secondaryEditor, lay.secondaryPreview], [true, false]);
    r = await set(s, { preview: 'full' });
    assert.deepEqual([r.ok.preview, r.ok.splitMode, r.ok.secondaryTabId], ['full', false, null], 'Ctrl+P closes the split first');
    r = await set(s, { preview: 'side', split: true });
    assert.deepEqual([r.ok.preview, r.ok.splitMode], ['side', true], 'a side preview and the split together is the same state');
    r = await set(s, { preview: 'off', split: false });
    assert.deepEqual([r.ok.preview, r.ok.splitMode], ['off', false]);
    await assertPlainLayout(s);

    t.step('zen: on, again is a no-op, off');
    r = await set(s, { zen: true });
    assert.equal(r.ok.zen, true);
    assert.equal((await layout(s)).zen, true);
    r = await set(s, { zen: true });
    assert.equal(r.ok.zen, true, 'not toggled back');
    r = await set(s, { zen: false });
    assert.equal(r.ok.zen, false);
    r = await set(s, { zen: false });
    assert.equal(r.ok.zen, false);

    t.step('several keys at once');
    r = await set(s, { preview: 'side', zen: true });
    assert.deepEqual([r.ok.preview, r.ok.zen], ['side', true]);
    r = await set(s, { preview: 'off', zen: false });
    assert.deepEqual([r.ok.preview, r.ok.zen, r.ok.splitMode], ['off', false, false]);
    st = await ui(s);

    t.step('an unknown value, a wrong type, an unknown key or an impossible pair is invalid_params and changes nothing');
    const bad = [
      { preview: 'half' }, { preview: true }, { split: 'yes' }, { zen: 1 }, { fullscreen: true },
      { preview: 'full', split: true }, { preview: 'side', split: false },
      { zen: true, preview: 'half' }, // the valid key is not applied either: the whole spec is checked first
      { zen: true, preview: 'full', split: true }
    ];
    for (const spec of bad) {
      r = await set(s, spec);
      assert.equal(r.kind, 'invalid_params', `${JSON.stringify(spec)} is refused: ${JSON.stringify(r)}`);
      assert.ok(r.err.startsWith('[invalid_params] '), r.err);
      assert.deepEqual(await ui(s), st, `${JSON.stringify(spec)} changed nothing`);
    }
    r = await rpc(s, 'setUiState("zen")');
    assert.equal(r.kind, 'invalid_params');
    await assertPlainLayout(s);

    t.step('openPanel: each name shows its panel, and nothing is sent to the AI or saved');
    const callsBefore = await s.ev("window.__docshot.calls.filter(function (c) { return /^(queryLLM|queryVision|runSlotAgent|saveFile|saveFileAs|jevExecute)/.test(c.fn); }).length");
    const open = {
      find: () => waitShown(s, 'find-replace-bar'),
      replace: async () => { await waitShown(s, 'find-replace-bar'); await waitShown(s, 'replace-row'); },
      scraps_search: async () => { await waitShown(s, 'scraps-search-modal'); await waitFocus(s, 'scraps-search-input'); },
      settings: () => waitShown(s, 'settings-modal'),
      shortcuts: async () => {
        await waitShown(s, 'settings-modal');
        await s.waitFor("document.getElementById('tab-btn-shortcuts').classList.contains('active')");
      },
      snippets: () => waitShown(s, 'slot-quick-selector'),
      all_tabs: () => waitShown(s, 'tab-list-panel'),
      command_palette: () => waitShown(s, 'quick-pick-modal'),
      about: () => waitShown(s, 'about-modal')
    };
    assert.deepEqual(Object.keys(open), PANELS, 'the flow covers every panel');
    for (const name of PANELS) {
      r = await rpc(s, `openPanel(${JSON.stringify(name)})`);
      assert.deepEqual(r.ok, { panel: name }, `${name}: ${JSON.stringify(r)}`);
      await open[name]();
      await s.key('Escape');
      await s.waitFor(`(function () {
        function hid(id) { var e = document.getElementById(id); return !e || e.classList.contains('hidden'); }
        return ['find-replace-bar', 'scraps-search-modal', 'settings-modal', 'slot-quick-selector', 'tab-list-panel', 'quick-pick-modal', 'about-modal'].every(hid);
      })()`);
    }
    const callsAfter = await s.ev("window.__docshot.calls.filter(function (c) { return /^(queryLLM|queryVision|runSlotAgent|saveFile|saveFileAs|jevExecute)/.test(c.fn); }).length");
    assert.equal(callsAfter, callsBefore, 'no AI request, agent run or save was made');
    st = await s.state();
    assert.equal(st.pendingLlm, 0);
    assert.ok(st.tabs.every((tab) => !tab.dirty), 'no note was changed');

    t.step('openPanel twice is fine (the second call only brings the panel forward)');
    await rpc(s, "openPanel('settings')");
    await waitShown(s, 'settings-modal');
    r = await rpc(s, "openPanel('settings')");
    assert.deepEqual(r.ok, { panel: 'settings' });
    assert.equal(await shown(s, 'settings-modal'), true);
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('an unknown panel is invalid_params and says what to use; nothing opens');
    for (const name of ['nope', '', 'Find']) {
      r = await rpc(s, `openPanel(${JSON.stringify(name)})`);
      assert.equal(r.kind, 'invalid_params', name);
      assert.equal(r.err, `[invalid_params] unknown panel "${name}"; use one of: ${PANELS.join(', ')}`);
    }
    r = await rpc(s, 'openPanel()');
    assert.equal(r.kind, 'invalid_params');
    r = await rpc(s, 'openPanel(5)');
    assert.equal(r.kind, 'invalid_params');
    await settle(200); // "nothing opens"
    const panels = (await s.state()).panels;
    assert.ok(Object.values(panels).every((on) => !on), `no panel is open: ${JSON.stringify(panels)}`);
  }
};
