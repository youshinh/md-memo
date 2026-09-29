// The first batch of the 2026-09 UX review (docs/design/ux-review-2026-09.md): readable primary buttons, a visible keyboard
// focus, less motion on request, an ask bar that opens (with the way to fix it) when no model is set up, the basics in the
// command palette, tab tooltips, no start-up toast, and an accessibility layer for the icon buttons, dialogs and toggles.
// The pixel checks were made in a real browser; this test keeps the rules from being undone.
import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== First-run polish tests ===');

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const css = read('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const html = read('frontend/index.html');
const app = read('frontend/js/app.js');
const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();
const A11Y = require('../frontend/js/a11y.js');

// 1. Contrast and focus (F1-F4, F8)
{
  const onAccent = ['.inline-prompt-bar .btn-action', '.ambient-pill:hover'];
  for (const sel of onAccent) {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert(m, sel + ' must exist');
    assert(/background:\s*var\(--accent-color\)/.test(m[1]), sel + ' sits on the accent colour');
    assert(/color:\s*#fff(fff)?\s*;/.test(m[1]), sel + ' must use white text on the accent (dark text was 2.1-3.7:1)');
  }
  // The panel's kind (Ask / Rewrite / CLI) is a label, not a button: bright accent text and a divider, never a fill.
  {
    const badge = css.match(/\.inline-prompt-badge\s*\{([^}]*)\}/);
    assert(badge, '.inline-prompt-badge must exist');
    assert(!/background\s*:/.test(badge[1]), 'the badge has no fill (a fill is what a button looks like)');
    assert(/color:\s*var\(--accent-label/.test(badge[1]), 'the badge text is the bright accent, readable on the dark panel');
    assert(/\.inline-prompt-badge::after\s*\{[^}]*width:\s*1px/.test(css), 'a 1px divider separates the badge from the field');
    const rewrite = css.match(/\.inline-prompt-rewrite \.inline-prompt-badge\s*\{([^}]*)\}/);
    assert(rewrite && /color:\s*#f59e0b/.test(rewrite[1]) && !/background/.test(rewrite[1]), 'rewrite mode keeps its amber, as text');
    assert(!/id="cli-filter-badge"[^>]*style=/.test(html), 'the command bar badge has no inline fill');
    assert(!/cliFilterBadge\.style\.background/.test(app), 'the command bar badge states change its text colour, not a fill');
    for (const theme of ['body.dark-theme {', 'body.theme-blue {', 'body.theme-olive {', 'body.theme-forest {', 'body.theme-charcoal {']) {
      const at = css.indexOf(theme);
      assert(at !== -1, theme + ' exists');
      assert(/--accent-label:/.test(css.slice(at, css.indexOf('}', at))), theme + ' defines --accent-label');
    }
  }
  assert(/--text-muted:\s*#9d9d9d/.test(css), 'muted text is #9d9d9d (4.5:1 or better on the dark surfaces)');
  assert(/#editor::placeholder\s*\{[^}]*#8f8f8f/.test(css) && /#editor-secondary::placeholder\s*\{[^}]*#8f8f8f/.test(css), 'placeholders are readable');
  assert(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-hover/.test(css), 'one visible focus ring for keyboard users');
  assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*0\.01ms !important/.test(css), 'reduced motion is honoured');
  console.log('PASS: white text on accent, readable muted text and placeholders, a focus ring, reduced motion.');
}

// 2. The dimmed chrome does not hide feedback (B8), the AI-running text stays on one line (D4), hit areas (G4)
{
  for (const probe of ['#stat-message:not(:empty)', '#stat-llm-indicator:not(.hidden)', '#stat-tasks:not(.hidden)']) {
    assert(css.includes('body.zen-active #status-bar:has(' + probe + ')'), 'the status bar stays at full strength while: ' + probe);
  }
  assert(/#stat-llm-indicator\s*\{[^}]*white-space:\s*nowrap/.test(css), 'the AI-running text must not wrap and get cut');
  assert(/\.tab-close::before\s*\{[^}]*inset:/.test(css) && /\.clickable-badge::before\s*\{[^}]*inset:/.test(css), 'the tab close and the status toggles have a 24px hit area');
  assert.ok(!/LLM processing/.test(I18N.en.llmProcessing + I18N.en.llmProcessingWithCount), 'the English status says AI, not LLM');
  console.log('PASS: feedback is not dimmed, the running text is one line, the small controls have a bigger hit area.');
}

// 3. The ask bar opens without a model and offers the fix (D3); badge words (C2)
{
  assert(/<div id="inline-prompt-setup" class="inline-prompt-setup hidden">/.test(html) && /id="btn-inline-prompt-setup"/.test(html), 'the set-up banner is in the ask bar');
  assert(/const llmReady = isLlmConfigured\(false\);/.test(app), 'the bar checks the model without a toast');
  assert(!/if \(!isLlmConfigured\(true\)\) return;\s*\n\s*\n\s*const editor = editorForTab/.test(app), 'the bar no longer refuses to open');
  assert(/btnInlinePromptSetup\.onclick = \(\) => \{\s*closeInlinePromptBar\(\);\s*openSettings\(\);\s*switchSettingsTab\('model'\);/.test(app), 'the banner button opens Settings on AI Models');
  assert(/textContent = t\(isRewrite \? 'badgeRewrite' : 'badgeAsk'\)/.test(app), 'the badge uses words');
  for (const k of ['badgeAsk', 'badgeRewrite', 'askSetupNeeded', 'askSetupButton', 'tabCloseLabel']) assert.ok(I18N.en[k] && I18N.ja[k], k + ' in both languages');
  console.log('PASS: the ask bar opens with a set-up banner when no model can answer, and its badge has words.');
}

// 4. The palette knows the basics (A4); tab tooltips (B3); no start-up toast (B7); find keeps the typed query (C4); Esc and backdrop (C5, C6)
{
  const ids = ['cmd_settings', 'cmd_shortcuts', 'cmd_help', 'cmd_save', 'cmd_save_as', 'cmd_find', 'cmd_replace', 'cmd_preview'];
  for (const id of ids) assert.ok(app.includes("id: '" + id + "'"), 'palette entry ' + id);
  assert.ok(/\.\.\.basicPaletteCommands\(\),/.test(app), 'the basics are part of the palette');
  for (const k of ['Settings', 'Shortcuts', 'Help', 'Save', 'SaveAs', 'Find', 'Replace', 'Preview']) {
    assert.ok(I18N.en['cmdPalette' + k] && I18N.ja['cmdPalette' + k], 'cmdPalette' + k + ' in both languages');
  }
  assert.ok(/tabEl\.title = tab\.path \|\| tab\.title/.test(app), 'tabs carry their full path as a tooltip');
  assert.ok(/loadWorkspaceFolder\(savedFolder, true\)/.test(app) && /if \(!quiet\) showMessage\(t\('folderLoaded'/.test(app), 'the workspace toast is not shown on start-up');
  assert.ok(/if \(seed && !\(wasOpen && findInput\.value\)\) findInput\.value = seed;/.test(app), 'Find keeps a query the user already typed');
  assert.ok(/if \(contextMenu && !contextMenu\.classList\.contains\('hidden'\)\) \{\s*contextMenu\.classList\.add\('hidden'\);\s*return;/.test(app), 'Esc closes the context menu');
  assert.ok(/quickPickModal\.addEventListener\('mousedown', \(e\) => \{\s*if \(e\.target === quickPickModal\) closeQuickPick\(\);/.test(app), 'a click on the dimmed backdrop closes the palette');
  assert.ok(/function openSettings\(\) \{\s*if \(contextMenu\) contextMenu\.classList\.add\('hidden'\);/.test(app), 'Settings closes a context menu left behind');
  console.log('PASS: palette basics, tab tooltips, quiet start-up, find keeps the query, Esc and backdrop close.');
}

// 5. The accessibility layer
{
  assert.strictEqual(A11Y.needsLabel(''), true);
  assert.strictEqual(A11Y.needsLabel('✕'), true, 'a glyph names nothing');
  assert.strictEqual(A11Y.needsLabel('×'), true);
  assert.strictEqual(A11Y.needsLabel('  '), true);
  assert.strictEqual(A11Y.needsLabel('Save'), false);
  assert.strictEqual(A11Y.needsLabel('Run'), false);
  assert.strictEqual(A11Y.needsLabel('設定'), false, 'Japanese text is a name');
  assert.strictEqual(A11Y.needsLabel('Aa', true), true, 'a two-letter abbreviation with a title is named by the title');
  assert.strictEqual(A11Y.needsLabel('Aa', false), false);
  assert.strictEqual(A11Y.nextTrapIndex(0, -1, false), null, 'no focusable element: leave it to the browser');
  assert.strictEqual(A11Y.nextTrapIndex(4, 3, false), 0, 'Tab on the last wraps to the first');
  assert.strictEqual(A11Y.nextTrapIndex(4, 0, true), 3, 'Shift+Tab on the first wraps to the last');
  assert.strictEqual(A11Y.nextTrapIndex(4, 1, false), null, 'in the middle the browser moves focus');
  assert.strictEqual(A11Y.nextTrapIndex(4, -1, false), 0, 'focus outside the dialog comes back to its first element');
  assert.strictEqual(A11Y.nextTrapIndex(4, -1, true), 3);
  assert.ok(html.indexOf('js/a11y.js') !== -1 && html.indexOf('js/a11y.js') < html.indexOf('js/app.js'), 'a11y.js loads before app.js');
  assert.ok(/if \(window\.A11y\) window\.A11y\.refresh\(\);/.test(app), 'labels follow the UI language');
  console.log('PASS: needsLabel, the focus-trap arithmetic, and the wiring of the accessibility layer.');
}

// 6. The Zen icon no longer looks like a settings gear (B1); the English-only tooltips are translated (H4)
{
  assert.ok(!html.includes('M12 9L12 1.4') && !app.includes('M12 9L12 1.4'), 'the sun-like Zen icon is gone from the header, the context menu and the palette');
  assert.ok(/id="btn-zen"[\s\S]*?M21 12\.79A9 9 0 1 1 11\.21 3/.test(html), 'Zen is a crescent moon');
  const keys = [...html.matchAll(/data-i18n-title="(tip[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 14, 'tooltips wired: ' + keys.length);
  for (const k of new Set(keys)) assert.ok(I18N.en[k] && I18N.ja[k], k + ' in both languages');
  console.log('PASS: the Zen icon is distinct, and ' + keys.length + ' more tooltips follow the UI language.');
}

console.log('\nAll first-run polish tests PASSED!');
