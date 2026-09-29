// Review repairs (2026-09-30): three small accessibility facts that are only visible in the markup and the style sheet, kept from
// slipping back:
//   * the find bar's match count is a live region (Enter now keeps the focus in the box, so the count is the only feedback),
//   * the keyboard focus ring of the status-bar buttons is white (the accent ring lay over the bar colour: 1.2:1 on the blue bar),
//   * the state colours of the AI item and of the Git sync button (amber, red, green) read at 4.5:1 or more on the dark pill on
//     every theme (on the blue bar they were 2.9:1 to 4.1:1).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const css = read('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const app = read('frontend/js/app.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

// ---- contrast ---------------------------------------------------------------------------------------------
const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const la = lum(a); const lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const under = (rgb, alpha) => rgb.map((v) => Math.round(v * (1 - alpha))); // black at `alpha` over rgb

// The block of a selector: "body.theme-blue { ... }" -> its declarations.
function block(selector) {
  const at = css.indexOf('\n' + selector + ' {');
  assert.notStrictEqual(at, -1, selector + ' must have a rule');
  return css.slice(at, css.indexOf('}', at));
}
const declared = (body, prop) => { const m = new RegExp('(?:^|[\\s;{])' + prop + ':\\s*([^;]+);').exec(body); return m ? m[1].trim() : null; };

const THEMES = ['olive', 'blue', 'forest', 'charcoal'];
const barOf = (theme) => declared(block('body.theme-' + theme), '--bg-statusbar');
const pillAlpha = Number(/\.clickable-badge::before \{[^}]*background: rgba\(0, 0, 0, ([0-9.]+)\)/.exec(css)[1]);

check('the pill under a status-bar item is black at 25% over the bar (what the contrast below is measured on)', () => {
  assert.strictEqual(pillAlpha, 0.25);
  THEMES.forEach((t) => assert.match(barOf(t), /^#[0-9a-f]{6}$/i, t + ' has a bar colour'));
});

// ---- the find count -----------------------------------------------------------------------------------------
check('the find bar\'s match count is a polite live region', () => {
  const tag = /<span id="find-count"[^>]*>/.exec(html);
  assert.ok(tag, '#find-count exists');
  assert.match(tag[0], /role="status"/);
  assert.match(tag[0], /aria-live="polite"/);
});

// ---- the focus ring -----------------------------------------------------------------------------------------
check('the status-bar buttons have a white focus ring inside the button, at least 4.5:1 on all four bars', () => {
  const rule = block('.clickable-badge:focus-visible');
  assert.strictEqual(declared(rule, 'outline'), '2px solid #fff');
  assert.strictEqual(declared(rule, 'outline-offset'), '-2px', 'the ring stays inside the 24px bar');
  THEMES.forEach((t) => {
    const r = ratio(hex('#ffffff'), hex(barOf(t)));
    assert.ok(r >= 4.5, t + ': the ring is ' + r.toFixed(2) + ':1 on the bar');
  });
});

// ---- the state colours ----------------------------------------------------------------------------------------
// The value a token has on a theme: the theme's own, else the fallback written in var(--token, fallback).
function stateColour(token, theme, fallback) {
  const own = declared(block('body.theme-' + theme), token);
  return own || fallback;
}
const fallbackOf = (source, token) => {
  const m = new RegExp('var\\(' + token + ', (#[0-9a-fA-F]{6})\\)').exec(source);
  assert.ok(m, token + ' is used with a fallback colour');
  return m[1];
};

check('the AI item and the Git sync button take their amber, red and green from tokens that the blue theme lightens', () => {
  assert.match(css, /\.status-ai\.status-ai-unset \{\s*color: var\(--status-warn, #[0-9a-f]{6}\);/i);
  assert.match(css, /\.status-ai\.status-ai-error \{\s*color: var\(--status-error, #[0-9a-f]{6}\);/i);
  for (const token of ['--status-warn', '--status-ok', '--status-error']) {
    assert.match(app, new RegExp("statGitSync\\.style\\.color = 'var\\(" + token + ", #[0-9a-f]{6}\\)'"), 'Git sync uses ' + token);
  }
  assert.ok(!/statGitSync\.style\.color = '#/.test(app), 'no colour of the Git button is written as a plain hex any more');
});

check('amber (not set up, syncing), red (error) and green (synced) are 4.5:1 or more on the pill of every theme', () => {
  const tokens = {
    '--status-warn': fallbackOf(css, '--status-warn'),
    '--status-error': fallbackOf(css, '--status-error'),
    '--status-ok': fallbackOf(app, '--status-ok')
  };
  assert.strictEqual(fallbackOf(app, '--status-warn'), tokens['--status-warn'], 'the CSS and the Git button agree on amber');
  assert.strictEqual(fallbackOf(app, '--status-error'), tokens['--status-error'], 'and on red');
  const problems = [];
  THEMES.forEach((theme) => {
    const pill = under(hex(barOf(theme)), pillAlpha);
    Object.keys(tokens).forEach((token) => {
      const colour = stateColour(token, theme, tokens[token]);
      const r = ratio(hex(colour), pill);
      if (r < 4.5) problems.push(theme + ' ' + token + ' ' + colour + ' is ' + r.toFixed(2) + ':1');
    });
  });
  assert.deepStrictEqual(problems, []);
});

check('the blue theme is where the tokens are lightened; the others keep the familiar amber, red and green', () => {
  const blue = block('body.theme-blue');
  ['--status-ok', '--status-warn', '--status-error'].forEach((t) => assert.ok(declared(blue, t), t + ' is set on the blue theme'));
  ['olive', 'forest', 'charcoal'].forEach((theme) => {
    ['--status-ok', '--status-warn', '--status-error'].forEach((t) => assert.strictEqual(declared(block('body.theme-' + theme), t), null, theme + ' does not override ' + t));
  });
});

if (failed) {
  console.log('\n' + failed + ' status bar accessibility test(s) FAILED');
  process.exit(1);
}
console.log('\nAll status bar accessibility tests passed');
