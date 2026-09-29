// The floating panels and the Settings dialog follow docs/design/panel-template.md and docs/design/settings-dialog.md:
// one width, one place, one shell, no box around the field, labels that are not buttons, switches, and three levels of button.
// The pixel checks were made in a real browser (docshots); this test keeps the rules from being undone.
import fs from 'fs';
import assert from 'assert';

console.log('=== Panel template tests ===');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const css = read('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const html = read('frontend/index.html');
const app = read('frontend/js/app.js');
const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();

const rule = (selector) => {
  const at = css.indexOf(selector + ' {');
  assert.notStrictEqual(at, -1, selector + ' must exist');
  return css.slice(at, css.indexOf('}', at));
};

// 1. One width for every panel, one gap under the header, one shadow
{
  assert.ok(/--panel-width:\s*560px/.test(css), 'the panel width is 560px');
  assert.ok(/--panel-top:\s*16px/.test(css), 'the gap under the header is 16px');
  for (const sel of ['.inline-prompt-bar', '.quick-pick-modal', '.jev-action-panel']) {
    const r = rule(sel);
    assert.ok(/width:\s*min\(var\(--panel-width, 560px\), calc\(100% - 32px\)\)/.test(r), sel + ' uses the shared width');
    assert.ok(/box-shadow:\s*var\(--panel-shadow\)/.test(r), sel + ' uses the shared shadow');
    assert.ok(/border:\s*1px solid var\(--border-color\)/.test(r), sel + ' has the ordinary border, not an accent one');
    assert.ok(/border-radius:\s*8px/.test(r), sel + ' has the shared radius');
  }
  assert.ok(!/#cli-filter-bar\s*\{/.test(css), 'the command bar has no width of its own');
  assert.ok(/scraps-search-dialog\s*\{\s*max-width:\s*none/.test(css), 'the search is not wider than the others');
  assert.ok(/left:\s*0;\s*right:\s*0;\s*margin:\s*0 auto;/.test(rule('.inline-prompt-bar')), 'the bars are centred');
  assert.ok(/\.inline-prompt-bar\.panel-dock-bottom\s*\{[^}]*bottom:\s*var\(--panel-top/.test(css), 'the bottom-edge exception exists');
  console.log('PASS: every floating panel is 560px wide, centred, with one border, radius and shadow.');
}

// 2. Rewrite looks like the others; the field has no box of its own
{
  assert.ok(!/\.inline-prompt-rewrite/.test(css), 'no amber Rewrite variant');
  for (const sel of ['#inline-prompt-input,\n#cli-filter-input']) {
    const at = css.indexOf(sel + ' {');
    assert.notStrictEqual(at, -1, 'the field rule exists');
    const r = css.slice(at, css.indexOf('}', at));
    assert.ok(/background:\s*transparent/.test(r) && /border:\s*0/.test(r), 'the field has neither a background nor a border');
  }
  assert.ok(/\.quick-pick-input\s*\{[^}]*background:\s*transparent/.test(css), 'the palette field is bare too');
  assert.ok(/\.inline-prompt-row\s*\{[^}]*height:\s*44px/.test(css), 'the header row is 44px');
  assert.ok(/\.quick-pick-input-wrap\s*\{[^}]*height:\s*44px/.test(css), 'and so is the palette\'s');
  console.log('PASS: Rewrite is the same panel as Ask; the field is bare inside a 44px header.');
}

// 3. The palette and the search carry a kind label like the others; the suggest panel's is localized
{
  assert.ok(/data-i18n="badgeCommands">Commands</.test(html) && /data-i18n="badgeSearch">Search</.test(html), 'labels in the palette and the search');
  for (const k of ['badgeCommands', 'badgeSearch', 'badgeSuggest']) assert.ok(I18N.en[k] && I18N.ja[k], k + ' in both languages');
  assert.ok(/dockPanelBar\(inlinePromptBar,/.test(app) && /dockPanelBar\(cliFilterBar,/.test(app), 'both bars are placed by dockPanelBar');
  assert.ok(!/inlinePromptBar\.style\.(left|top|width)\s*=\s*[`'"]/.test(app), 'the ask bar no longer follows the caret with inline coordinates');
  console.log('PASS: the palette and search have labels; the bars are placed by one function.');
}

// 4. The Settings dialog
{
  const card = rule('#settings-modal .modal-card');
  assert.ok(/width:\s*min\(var\(--panel-width, 560px\), calc\(100vw - 32px\)\)/.test(card), 'Settings is as wide as the panels');
  assert.ok(/height:\s*min\(620px, 88vh\)/.test(card), 'its size does not change with the tab');
  assert.ok(/\.modal-header\s*\{[^}]*height:\s*48px/.test(css.slice(css.indexOf('#settings-modal .modal-header'))), 'header 48px');
  assert.ok(/\.settings-tabs\s*\{[^}]*height:\s*40px/.test(css), 'tabs 40px');
  const tab = css.slice(css.indexOf('.settings-tab-btn.active {'), css.indexOf('.settings-tab-btn.active {') + 200);
  assert.ok(!/background/.test(tab), 'the selected tab is not filled');
  assert.ok(/#settings-modal \.settings-section-header h4\s*\{[^}]*color:\s*var\(--accent-label/.test(css), 'category names use the bright accent');
  assert.ok(/#settings-modal \.settings-pane\s*\{[^}]*gap:\s*12px/.test(css), 'fields are 12px apart');
  assert.ok(/#settings-modal input\[type="checkbox"\]\s*\{[^}]*appearance:\s*none[^}]*width:\s*32px;[^}]*height:\s*18px/.test(css), 'on/off options are 32 x 18 switches');
  assert.ok(/#settings-modal input\[type="checkbox"\]:checked::after\s*\{[^}]*left:\s*16px/.test(css), 'the switch knob moves');
  // three levels of button; the quiet one still has a fill
  const footerBtn = rule('#settings-modal .modal-footer .btn-primary,\n#settings-modal .modal-footer .btn-secondary,\n#settings-modal #btn-reset-shortcuts');
  assert.ok(/height:\s*28px/.test(footerBtn), 'buttons are 28px');
  const tertiary = css.slice(css.indexOf('#settings-modal #btn-export-settings,'), css.indexOf('#settings-modal #btn-export-settings,') + 260);
  assert.ok(/background:\s*rgba\(255, 255, 255, 0\.07\)/.test(tertiary), 'Export / Import have a pale fill so they read as buttons');
  // shortcuts: keys are chips, recording is green rather than red
  const rec = rule('#settings-modal .shortcut-key-btn.recording');
  assert.ok(!/#e51400|red|255, ?136, ?136/i.test(rec), 'recording is not red');
  assert.ok(/:has\(#pane-shortcuts:not\(\.hidden\)\)/.test(css), 'the shortcut list scrolls under a fixed hint line');
  console.log('PASS: Settings shares the panels\' width, rows, labels, buttons and keys.');
}

console.log('\nAll panel template tests PASSED!');
