// The preview must not be mistaken for the editor. Both are dark, use the same fonts and fill the same window,
// so the preview gets its own theme-tinted surface (--bg-preview), a frame in the theme's accent colour and a
// "Preview" tag in the corner. All of it is CSS: the tag is a sibling after #preview-pane, so it shows only
// while the pane does, and no script has to remember to switch it on or off.
//
// The pixel check needs a real browser (done there: every theme's surface differs from the editor's #1e1e1e,
// the frame is inside the scrollbar, the tag is hidden for an HTML page and in split view). This test keeps the
// rules from being removed or drifting apart.
import fs from 'fs';
import assert from 'assert';

console.log('=== Preview vs editor distinction tests ===');

const css = fs.readFileSync('frontend/css/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync('frontend/index.html', 'utf8').replace(/\r\n/g, '\n');

const rule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}'));
  assert(m, 'rule not found: ' + selector);
  return m[1];
};

// 1. Every theme (and the default block) defines the preview surface, and none of them is the editor's colour.
{
  for (const sel of ['body.dark-theme', 'body.theme-blue', 'body.theme-olive', 'body.theme-forest', 'body.theme-charcoal']) {
    const m = rule(sel).match(/--bg-preview:\s*(#[0-9a-fA-F]{6})\s*;/);
    assert(m, sel + ' must define --bg-preview');
    assert.notStrictEqual(m[1].toLowerCase(), '#1e1e1e', sel + ': the preview surface must differ from the editor (#1e1e1e)');
  }
  console.log('PASS: every theme defines a --bg-preview that differs from the editor background.');
}

// 2. The full preview and the side preview use the tinted surface and an accent frame.
{
  for (const sel of ['#preview-pane', '.secondary-preview-pane']) {
    const body = rule(sel);
    assert(/background:\s*var\(--bg-preview\b/.test(body), sel + ' must use var(--bg-preview)');
    assert(/border:\s*[2-9]px solid var\(--accent-hover\b/.test(body), sel + ' must have a frame in the theme accent');
  }
  console.log('PASS: full and side preview use the tinted surface and the accent frame.');
}

// 3. The tag: hidden by default, shown only next to a visible, non-HTML #preview-pane.
{
  assert(/display:\s*none\s*;/.test(rule('.preview-badge')), '.preview-badge must be hidden by default');
  assert(/position:\s*absolute\s*;/.test(rule('.preview-badge')), '.preview-badge must not take space in the layout');
  assert(/pointer-events:\s*none\s*;/.test(rule('.preview-badge')), '.preview-badge must not catch clicks');
  const shown = rule('#preview-pane:not(.hidden):not(.html-mode) ~ .preview-badge');
  assert(/display:\s*block\s*;/.test(shown), 'the tag must be shown next to a visible, non-HTML preview pane');
  console.log('PASS: the Preview tag is CSS-driven (hidden, shown only beside the visible Markdown preview).');
}

// 4. The markup: the tag comes after #preview-pane (the ~ selector looks forward), inside the same parent, and is translated.
{
  assert(/<div id="preview-pane"[^>]*><\/div>\s*(<!--[\s\S]*?-->\s*)?<div id="preview-badge"/.test(html),
    '#preview-badge must directly follow #preview-pane (same parent, later sibling)');
  assert(/<div id="preview-badge"[^>]*data-i18n="preview"/.test(html), 'the tag must use the existing "preview" translation');
  assert(/<div id="preview-badge"[^>]*aria-hidden="true"/.test(html), 'the tag is decoration: hidden from assistive tech');
  console.log('PASS: the tag follows #preview-pane and is translated.');
}

console.log('\nAll preview distinction tests PASSED!');
