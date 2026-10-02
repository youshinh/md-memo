// Unit tests for print_preview.js: what happens to the preview before it is printed (the images are waited for, a diagram in the dark
// tone is drawn again in the light one) and how it is put back. A tiny fake DOM and a fake Mermaid; the real paper look is css/print.css,
// checked in a browser (tests/smoke/97_print_preview.mjs).
const assert = require('assert');

global.window = global;

// ---- a fake DOM: just enough tree for children, classes, dataset and innerHTML ------------------------------------------------
class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.classes = new Set();
    this.dataset = {};
    this.listeners = {};
    this.html = '';
  }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.isRoot === true; }
  get ownerDocument() { return fakeDocument; }
  get classList() { const c = this.classes; return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x) }; }
  appendChild(child) {
    if (child.isFragment) { while (child.children.length) this.appendChild(child.children[0]); return child; }
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parent = null; return child; }
  set innerHTML(h) { this.children.forEach((c) => { c.parent = null; }); this.children = []; const svg = new Node('svg'); svg.html = h; this.appendChild(svg); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
}
const fakeDocument = {
  createElement: (tag) => new Node(tag),
  createDocumentFragment: () => { const f = new Node('#fragment'); f.isFragment = true; return f; }
};

function pane(...children) {
  const p = new Node('div');
  p.isRoot = true;
  children.forEach((c) => p.appendChild(c));
  p.querySelectorAll = (sel) => {
    const out = [];
    const walk = (n) => n.children.forEach((c) => {
      if (sel === 'img' && c.tag === 'img') out.push(c);
      if (sel === 'pre.mermaid-card.tone-dark' && c.tag === 'pre' && c.classes.has('mermaid-card') && c.classes.has('tone-dark')) out.push(c);
      walk(c);
    });
    walk(p);
    return out;
  };
  return p;
}

function card(tone, source) {
  const c = new Node('pre');
  c.classes.add('mermaid-card');
  c.classes.add('tone-' + tone);
  if (source) c.dataset.mermaidSrc = source;
  const svg = new Node('svg'); svg.html = 'dark drawing';
  const btn = new Node('button'); btn.addEventListener('click', () => {});
  c.appendChild(svg);
  c.appendChild(btn);
  return { card: c, svg, btn };
}

let mermaidCalls;
function installMermaid(render) {
  mermaidCalls = { initialize: [], render: [] };
  global.mermaid = {
    initialize: (cfg) => mermaidCalls.initialize.push(cfg),
    render: async (id, src) => { mermaidCalls.render.push([id, src]); return render(id, src); }
  };
  global.MermaidTone = require('./mermaid_tone.js');
}

const PP = require('./print_preview.js');

async function testDarkDiagramsAreDrawnAgainInTheLightToneAndPutBack() {
  installMermaid(async (id, src) => ({ svg: '<svg>light ' + src + '</svg>' }));
  const dark = card('dark', 'graph LR; A-->B');
  const light = card('light', 'graph LR; C-->D'); // already light: left alone
  const bare = card('dark', ''); // no source kept (drawn by an older page): left alone
  const p = pane(dark.card, light.card, bare.card);
  let resets = 0;
  const restore = await PP.prepare(p, { resetMermaid: () => resets++ });

  assert.deepStrictEqual(mermaidCalls.render.map((c) => c[1]), ['graph LR; A-->B'], 'only the dark card with a source is drawn again');
  assert.strictEqual(mermaidCalls.initialize.length, 1);
  assert.strictEqual(mermaidCalls.initialize[0].theme, 'default', 'the light tone is Mermaid\'s default theme');
  assert.strictEqual(mermaidCalls.initialize[0].securityLevel, 'strict', 'the security level is the same as ever');
  assert.strictEqual(resets, 1, 'Mermaid goes back to the tone of the settings as soon as the drawing is done');
  assert.ok(dark.card.classes.has('tone-light') && !dark.card.classes.has('tone-dark'));
  assert.strictEqual(dark.card.children.length, 1);
  assert.ok(/light graph LR; A-->B/.test(dark.card.children[0].html), 'the card holds the light drawing');
  assert.ok(light.card.classes.has('tone-light') && light.card.children[0] === light.svg, 'a light card is not touched');
  assert.ok(bare.card.classes.has('tone-dark') && bare.card.children[0] === bare.svg, 'a card with no source is not touched');

  restore();
  assert.ok(dark.card.classes.has('tone-dark') && !dark.card.classes.has('tone-light'));
  assert.deepStrictEqual(dark.card.children, [dark.svg, dark.btn], 'the very same children come back, so the tone button still has its listener');
  assert.strictEqual(dark.btn.listeners.click.length, 1);
  restore(); // twice is harmless
  assert.deepStrictEqual(dark.card.children, [dark.svg, dark.btn]);
}

async function testAFailingDiagramPrintsAsItIsAndTheRestIsDone() {
  installMermaid(async (id, src) => { if (src === 'bad') throw new Error('syntax'); return { svg: '<svg>ok ' + src + '</svg>' }; });
  const bad = card('dark', 'bad');
  const good = card('dark', 'good');
  let resets = 0;
  const restore = await PP.prepare(pane(bad.card, good.card), { resetMermaid: () => resets++ });
  assert.ok(bad.card.classes.has('tone-dark') && bad.card.children[0] === bad.svg, 'the diagram that could not be drawn again stays as it was');
  assert.ok(good.card.classes.has('tone-light'));
  assert.strictEqual(resets, 1);
  restore();
  assert.ok(good.card.classes.has('tone-dark') && good.card.children[0] === good.svg);
}

async function testNothingToDoWithoutDarkDiagramsOrWithoutMermaid() {
  installMermaid(async () => ({ svg: '' }));
  const lightOnly = pane(card('neutral', 'x').card);
  const restore = await PP.prepare(lightOnly, { resetMermaid() { throw new Error('nothing was drawn, nothing to reset'); } });
  assert.deepStrictEqual(mermaidCalls.initialize, []);
  restore();
  delete global.mermaid; // Mermaid never loaded (no diagram was ever drawn)
  const r2 = await PP.prepare(pane(card('dark', 'y').card), {});
  r2();
}

async function testAPreviewDrawnAgainMeanwhileIsNotTouchedByRestore() {
  installMermaid(async () => ({ svg: '<svg>light</svg>' }));
  const c = card('dark', 'z');
  const p = pane(c.card);
  const restore = await PP.prepare(p, {});
  p.removeChild(c.card); // the preview was rendered again while the dialog was open: this card is gone
  restore(); // must not throw or resurrect it
  assert.strictEqual(p.children.length, 0);
  assert.ok(c.card.classes.has('tone-light'), 'a detached card is left as it is');
}

async function testImagesAreWaitedForButNotForever() {
  installMermaid(async () => ({ svg: '' }));
  const loaded = new Node('img'); loaded.complete = true;
  const late = new Node('img'); late.complete = false;
  const never = new Node('img'); never.complete = false;
  // a picture that finishes loading: the preparation waits for it
  const p1 = pane(loaded, late);
  let done = false;
  const prep = PP.prepare(p1, {}).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(done, false, 'still waiting for the late image');
  late.listeners.load.forEach((fn) => fn());
  await prep;
  assert.strictEqual(done, true);
  // one that fails counts as done too (the page shows a broken image, the print goes on)
  const failing = new Node('img'); failing.complete = false;
  const p2 = pane(failing);
  const prep2 = PP.prepare(p2, {});
  failing.listeners.error.forEach((fn) => fn());
  await prep2;
  // one that never answers: after the time-out the print goes on
  const t0 = Date.now();
  await PP.prepare(pane(never), { imageWaitMs: 60 });
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 2000, 'waited about imageWaitMs and no longer');
}

(async () => {
  await testDarkDiagramsAreDrawnAgainInTheLightToneAndPutBack();
  await testAFailingDiagramPrintsAsItIsAndTheRestIsDone();
  await testNothingToDoWithoutDarkDiagramsOrWithoutMermaid();
  await testAPreviewDrawnAgainMeanwhileIsNotTouchedByRestore();
  await testImagesAreWaitedForButNotForever();
  console.log('print_preview tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
