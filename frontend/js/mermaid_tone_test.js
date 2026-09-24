// Unit tests for mermaid_tone.js: tone choice, the Mermaid configuration behind each tone, and the
// card decoration (with a tiny fake DOM; the real look is checked in a browser).
const assert = require('assert');

global.window = global;
const MT = require('./mermaid_tone.js');

(function testNormalizeTone() {
  assert.deepStrictEqual(MT.TONES, ['dark', 'light', 'neutral', 'forest']);
  for (const t of MT.TONES) assert.strictEqual(MT.normalizeTone(t), t);
  assert.strictEqual(MT.normalizeTone(undefined), 'dark', 'no setting yet keeps the look the app always had');
  assert.strictEqual(MT.normalizeTone(''), 'dark');
  assert.strictEqual(MT.normalizeTone('sepia'), 'dark', 'a value from a newer or older version falls back');
  assert.strictEqual(MT.normalizeTone(null), 'dark');
})();

(function testFlip() {
  assert.strictEqual(MT.flipTone('dark'), 'light');
  assert.strictEqual(MT.flipTone('light'), 'dark');
  assert.strictEqual(MT.flipTone('neutral'), 'dark', 'a light tone flips back to dark');
  assert.strictEqual(MT.flipTone('forest'), 'dark');
  assert.strictEqual(MT.flipTone(undefined), 'light');
})();

(function testMermaidConfig() {
  const dark = MT.mermaidConfig('dark');
  assert.strictEqual(dark.theme, 'dark');
  assert.strictEqual(dark.startOnLoad, false);
  assert.strictEqual(dark.securityLevel, 'strict', 'the security level must never depend on the tone');
  assert.deepStrictEqual(dark.themeVariables, {
    darkMode: true, background: '#252526', primaryColor: '#007acc', textColor: '#d4d4d4'
  }, 'the dark tone is the configuration the app has always used');
  assert.strictEqual(MT.mermaidConfig('light').theme, 'default');
  assert.strictEqual(MT.mermaidConfig('neutral').theme, 'neutral');
  assert.strictEqual(MT.mermaidConfig('forest').theme, 'forest');
  for (const t of ['light', 'neutral', 'forest']) {
    const c = MT.mermaidConfig(t);
    assert.strictEqual(c.themeVariables, undefined, t + ': no dark overrides on a light tone');
    assert.strictEqual(c.securityLevel, 'strict');
    assert.strictEqual(c.startOnLoad, false);
  }
  assert.strictEqual(MT.mermaidConfig('bogus').theme, 'dark');
})();

(function testCardClasses() {
  assert.deepStrictEqual(MT.cardClasses('light'), ['mermaid-card', 'tone-light']);
  assert.deepStrictEqual(MT.cardClasses('nope'), ['mermaid-card', 'tone-dark']);
})();

(function testDecorate() {
  const classes = new Set(['tone-dark']);
  const children = [];
  let handler = null;
  const btn = {
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { if (type === 'click') handler = fn; }
  };
  const container = {
    ownerDocument: { createElement: (tag) => { assert.strictEqual(tag, 'button'); return btn; } },
    classList: {
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      add: (n) => classes.add(n)
    },
    appendChild: (c) => children.push(c)
  };
  let flips = 0;
  MT.decorate(container, 'light', 'Switch colors', () => { flips++; });
  assert.ok(classes.has('tone-light') && classes.has('mermaid-card'));
  assert.ok(!classes.has('tone-dark'), 'the previous tone class is removed');
  assert.strictEqual(children.length, 1);
  assert.strictEqual(btn.type, 'button', 'must not submit or navigate anything');
  assert.strictEqual(btn.className, 'mermaid-tone-btn');
  assert.strictEqual(btn.title, 'Switch colors');
  assert.strictEqual(btn.attrs['aria-label'], 'Switch colors');
  assert.ok(/<svg/.test(btn.innerHTML) && !/[\u{1F300}-\u{1FAFF}]/u.test(btn.innerHTML), 'a line SVG icon, no emoji');
  let stopped = 0;
  let prevented = 0;
  handler({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.strictEqual(flips, 1);
  assert.strictEqual(stopped, 1, 'the click must not reach the preview pane link handler');
  assert.strictEqual(prevented, 1);
  MT.decorate(null, 'dark', 't', () => {}); // must not throw
})();

console.log('mermaid_tone tests passed');
