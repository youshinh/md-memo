// Settings > AI Models > Semantic search (js/semantic_settings.js): the switch that used to be a hand edit of config.json. The section is
// there and folded, off by default, and a person who never touches it gets no "semantic" key. Turning it on fills in the usual local model;
// the destination says whether notes stay on this PC (a model on this PC) or go to a host (a cloud model, which needs the person's
// consent before anything can be updated); the index card says how the index stands and has "Update now" and "Rebuild" (acting on what
// is on the screen, before Save), a Stop button while it runs, a question before a large run to a cloud host, and one line for a failure.
// Save writes config.semantic, and the notes search then has its Meaning mode. The backend is the mock (tools/docshots/mock/backend.js).
import { assert, click, shown, waitShown, waitHidden } from './lib.mjs';
import { openSearch, phrase, visible } from './semantic_lib.mjs';

export default {
  title: 'Settings > Semantic search: off and untouched by default, the switch fills in the local model, where the notes go and the consent, Update now / Rebuild / Stop, a question before a large cloud run, one line for a failure, and Save turns the Meaning mode on',
  session: { notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 60000,

  async run(s, t) {
    const text = (id) => s.ev(`(function () { var e = document.getElementById(${JSON.stringify(id)}); return e && !e.classList.contains('hidden') ? e.textContent : ''; })()`);
    const val = (id) => s.ev(`document.getElementById(${JSON.stringify(id)}).value`);
    const disabled = (id) => s.ev(`document.getElementById(${JSON.stringify(id)}).disabled`);
    const shownBtn = (id) => s.ev(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
    const calls = (fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${JSON.stringify(fn)}; }).map(function (c) { return c.args; })`);
    const knob = (code) => s.ev(`(function () { var k = window.__docshot.semanticIndex; ${code}; return 1; })()`);
    const configSemantic = () => s.ev('JSON.stringify(MdMemoBridge.getConfig().semantic === undefined ? null : MdMemoBridge.getConfig().semantic)');
    const setValue = (id, v) => s.ev(`(function () { var e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    const toggle = (id, on) => s.ev(`(function () { var e = document.getElementById(${JSON.stringify(id)}); e.checked = ${on ? 'true' : 'false'}; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    const settle = (cond) => s.waitFor(cond, { timeout: 8000 });
    const openSettings = async () => {
      await s.key(',', { ctrl: true });
      await waitShown(s, 'settings-modal');
      await s.ev("document.getElementById('tab-btn-model').click(); 1");
      await s.waitFor("!document.getElementById('pane-model').classList.contains('hidden')");
      await s.ev("(function () { var d = document.getElementById('cfg-semantic-enabled').closest('details'); if (d) d.open = true; return 1; })()");
    };

    t.step('the section is there, off, with nothing filled in; pressing Save without touching it writes no "semantic" key');
    await openSettings();
    assert.equal(await text('semantic-index-status'), await phrase(s, 'semanticIndexOff'));
    assert.equal(await s.ev("document.getElementById('cfg-semantic-enabled').checked"), false);
    assert.deepEqual([await val('cfg-semantic-base-url'), await val('cfg-semantic-model')], ['', '']);
    assert.equal(await disabled('btn-semantic-update'), true);
    assert.equal(await disabled('btn-semantic-rebuild'), true);
    await click(s, 'btn-save-settings');
    await waitHidden(s, 'settings-modal');
    assert.equal(await configSemantic(), 'null', 'a person who never uses the feature gets no semantic key');
    assert.equal(await shown(s, 'scraps-search-modal'), false);
    await openSearch(s);
    assert.equal(await visible(s, 'scraps-search-mode'), false, 'no Meaning mode while it is off');
    await s.key('Escape');

    t.step('the switch fills in the usual local model, the destination says the notes stay here, and the index card says it is not made yet');
    await openSettings();
    await toggle('cfg-semantic-enabled', true);
    await settle("document.getElementById('semantic-destination') && !document.getElementById('semantic-destination').classList.contains('hidden')");
    assert.deepEqual([await val('cfg-semantic-base-url'), await val('cfg-semantic-model')], ['http://localhost:11434', 'bge-m3']);
    assert.equal(await text('semantic-destination'), await phrase(s, 'semanticDestLocal'));
    assert.equal(await text('semantic-index-status'), await phrase(s, 'semanticIndexNone'));
    assert.equal(await visible(s, 'semantic-consent-group'), false, 'a model on this PC needs no consent');
    assert.equal(await disabled('btn-semantic-update'), false);
    assert.equal(await disabled('btn-semantic-rebuild'), true, 'nothing to make again yet');
    const asked = await calls('semanticStatus');
    assert.ok(asked.length >= 1 && asked[asked.length - 1][0].enabled === true && asked[asked.length - 1][0].model.model === 'bge-m3', 'the status was asked for the section as it is on the screen (before Save)');

    t.step('Update now acts on the screen\'s section; while it runs there is progress and a Stop button; afterwards the index line and the result');
    await knob('k.updateDelay = 700');
    await click(s, 'btn-semantic-update');
    await settle("!document.getElementById('btn-semantic-cancel').classList.contains('hidden')");
    assert.equal(await shownBtn('btn-semantic-update'), false, 'Update gives its place to Stop while it runs');
    assert.equal(await text('semantic-index-progress'), await phrase(s, 'semanticProgress', { files: 21, filesTotal: 53, texts: 168, textsTotal: 424 }));
    await settle("document.getElementById('btn-semantic-cancel').classList.contains('hidden')");
    const upd = await calls('semanticUpdate');
    assert.equal(upd.length, 1);
    assert.deepEqual([upd[0][0].enabled, upd[0][0].model.baseUrl, upd[0][1], upd[0][2]], [true, 'http://localhost:11434', false, false]);
    assert.equal(await text('semantic-index-result'), await phrase(s, 'semanticDone', { seconds: 1.4, embedded: 424, changed: 53 }));
    await settle("document.getElementById('semantic-index-status').textContent.indexOf('412') !== -1");
    assert.ok((await text('semantic-index-status')).endsWith(await phrase(s, 'semanticIndexUpToDate')), await text('semantic-index-status'));
    assert.equal(await disabled('btn-semantic-rebuild'), false, 'there is an index to make again now');

    t.step('Stop ends a run that is going: what was done is kept, and the buttons are back');
    await knob('k.updateDelay = 20000');
    await click(s, 'btn-semantic-update');
    await settle("!document.getElementById('btn-semantic-cancel').classList.contains('hidden')");
    await click(s, 'btn-semantic-cancel');
    await settle("document.getElementById('btn-semantic-cancel').classList.contains('hidden')");
    assert.equal(await text('semantic-index-result'), await phrase(s, 'semanticCancelled'));
    await knob('k.updateDelay = 0');

    t.step('Rebuild asks for a rebuild; a failure is one line');
    await click(s, 'btn-semantic-rebuild');
    await settle('window.__docshot.calls.filter(function (c) { return c.fn === "semanticUpdate"; }).length === 3');
    assert.equal((await calls('semanticUpdate'))[2][1], true);
    await knob("k.updateReject = 'the model is not reachable'");
    await click(s, 'btn-semantic-update');
    await settle("document.getElementById('semantic-index-result').textContent.indexOf('not reachable') !== -1 || document.getElementById('semantic-index-result').textContent.indexOf('reachable') !== -1");
    assert.equal(await text('semantic-index-result'), await phrase(s, 'semanticFailed', { message: 'the model is not reachable' }));
    await knob("k.updateReject = ''");

    t.step('a cloud host: the destination says the text is sent there, nothing can be updated until it is allowed, a large run asks first');
    await setValue('cfg-semantic-base-url', 'https://api.example.com/v1');
    await settle("!document.getElementById('semantic-consent-group').classList.contains('hidden')");
    assert.equal(await text('semantic-destination'), await phrase(s, 'semanticDestCloud', { host: 'api.example.com' }));
    assert.equal(await s.ev("document.getElementById('cfg-semantic-consent').checked"), false);
    assert.equal(await text('semantic-consent-label'), await phrase(s, 'semanticConsentLabel', { host: 'api.example.com' }));
    assert.equal(await disabled('btn-semantic-update'), true, 'not allowed yet: nothing can be sent');
    await toggle('cfg-semantic-consent', true);
    await settle("document.getElementById('btn-semantic-update').disabled === false");
    await knob('k.bigRun = true');
    await click(s, 'btn-semantic-update');
    await settle("!document.getElementById('btn-semantic-go').classList.contains('hidden')");
    assert.equal(await text('semantic-index-result'), await phrase(s, 'semanticConfirmLarge', { texts: 1500, host: 'api.example.com' }));
    assert.equal(await disabled('btn-semantic-update'), true, 'nothing else can be pressed while the question waits');
    const beforeGo = (await calls('semanticUpdate')).length;
    await click(s, 'btn-semantic-go');
    await settle(`window.__docshot.calls.filter(function (c) { return c.fn === 'semanticUpdate'; }).length === ${beforeGo + 1}`);
    const go = (await calls('semanticUpdate')).pop();
    assert.equal(go[2], true, 'the second call carries the yes');
    assert.deepEqual(go[0].privacy.cloudConsent['api.example.com'] !== undefined, true, 'with the consent of the screen');
    await settle("document.getElementById('btn-semantic-go').classList.contains('hidden')");

    t.step('Save writes config.semantic (with the consent for that host and no key), and the notes search has its Meaning mode');
    await click(s, 'btn-save-settings');
    await waitHidden(s, 'settings-modal');
    const saved = JSON.parse(await configSemantic());
    assert.equal(saved.enabled, true);
    assert.equal(saved.model.baseUrl, 'https://api.example.com/v1');
    assert.equal(saved.model.model, 'bge-m3');
    assert.ok('api.example.com' in saved.privacy.cloudConsent, JSON.stringify(saved));
    assert.equal('apiKey' in saved.model, false, 'no key was typed, none is written');
    await openSearch(s);
    assert.equal(await visible(s, 'scraps-search-mode'), true, 'the Meaning mode is there now');
    await s.key('Escape');

    t.step('opened again, the fields hold what was saved; turning it off and saving keeps the model and consent');
    await openSettings();
    assert.equal(await s.ev("document.getElementById('cfg-semantic-enabled').checked"), true);
    assert.equal(await val('cfg-semantic-base-url'), 'https://api.example.com/v1');
    await settle("document.getElementById('cfg-semantic-consent').checked === true");
    await toggle('cfg-semantic-enabled', false);
    await click(s, 'btn-save-settings');
    await waitHidden(s, 'settings-modal');
    const off = JSON.parse(await configSemantic());
    assert.equal(off.enabled, false);
    assert.equal(off.model.baseUrl, 'https://api.example.com/v1');
    assert.ok('api.example.com' in off.privacy.cloudConsent);
  }
};
