// Unit tests for preview_images.js: local images whose path has a space or non-ASCII characters
// (the macOS "Application Support" folder) must reach the preview as the real file path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const PI = require('./preview_images.js');

// The real markdown-it the app ships, configured like app.js configures it.
const ctx = {};
ctx.window = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'markdown-it.min.js'), 'utf8'), ctx);
function newMd() {
  const md = ctx.markdownit({ html: false, linkify: true, typographer: true, breaks: true });
  PI.installLooseImageRule(md);
  return md;
}
function srcsOf(md, text) {
  const out = [];
  const re = /<img src="([^"]*)" alt="([^"]*)"/g;
  let m;
  const html = md.render(text);
  while ((m = re.exec(html))) out.push({ src: m[1], alt: m[2] });
  return { html, imgs: out };
}

// ---- the reported case: a generated diagram under ~/Library/Application Support ---------------------

(function testSpaceInTargetIsAnImage() {
  const md = newMd();
  const { html, imgs } = srcsOf(md, '![Generated Diagram](/Users/you/Library/Application Support/md-memo/assets/diagram_1.jpg)');
  assert.strictEqual(imgs.length, 1, 'a target with a space must render as an image, got: ' + html);
  assert.strictEqual(imgs[0].alt, 'Generated Diagram');
  assert.strictEqual(imgs[0].src, '/Users/you/Library/Application%20Support/md-memo/assets/diagram_1.jpg');
  assert.strictEqual(
    PI.resolveLocalImagePath(imgs[0].src, ''),
    '/Users/you/Library/Application Support/md-memo/assets/diagram_1.jpg',
    'the preview must ask for the real path, not the percent-encoded text');
})();

(function testWithoutTheRuleTheSourceStaysText() {
  // Documents why the rule exists: stock markdown-it shows the source.
  const stock = ctx.markdownit({ html: false, linkify: true, typographer: true, breaks: true });
  assert.strictEqual(srcsOf(stock, '![x](/a b/c.png)').imgs.length, 0);
})();

(function testEncodedTargetsFromTheApp() {
  const md = newMd();
  // What the app now writes (Go markdownTarget): spaces and parentheses escaped.
  const { imgs } = srcsOf(md, '![Generated Diagram](/Users/you/Library/Application%20Support/md-memo/assets/d.jpg)');
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(PI.resolveLocalImagePath(imgs[0].src, ''), '/Users/you/Library/Application Support/md-memo/assets/d.jpg');
  const paren = srcsOf(md, '![x](assets/my%20photo%20%281%29.png)').imgs[0];
  assert.strictEqual(PI.resolveLocalImagePath(paren.src, '/notes'), '/notes/assets/my photo (1).png');
})();

(function testWindowsPathWithASpace() {
  const md = newMd();
  const { imgs } = srcsOf(md, '![x](C:/Users/a b/AppData/Roaming/md-memo/assets/d.png)');
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(PI.resolveLocalImagePath(imgs[0].src, ''), 'C:/Users/a b/AppData/Roaming/md-memo/assets/d.png');
})();

(function testNonAsciiAndPercentInNames() {
  const md = newMd();
  const jp = srcsOf(md, '![x](assets/写真.png)').imgs[0];
  assert.strictEqual(PI.resolveLocalImagePath(jp.src, '/n'), '/n/assets/写真.png', 'Japanese file names were sent percent-encoded before');
  const pct = srcsOf(md, '![x](assets/100%.png)').imgs[0];
  assert.strictEqual(PI.resolveLocalImagePath(pct.src, '/n'), '/n/assets/100%.png');
  assert.strictEqual(PI.resolveLocalImagePath('assets/bad%zz.png', '/n'), '/n/assets/bad%zz.png', 'a stray % is kept');
})();

// ---- the rule must not disturb anything it does not own ---------------------------------------------

(function testOrdinaryImagesAndTextAreUntouched() {
  const md = newMd();
  const a = srcsOf(md, '![a](assets/x.png)').imgs;
  assert.deepStrictEqual(a, [{ src: 'assets/x.png', alt: 'a' }]);
  const titled = srcsOf(md, '![a](assets/x.png "a title")').imgs;
  assert.strictEqual(titled.length, 1, 'an image with a title still renders (the built-in rule)');
  const angle = srcsOf(md, '![a](<assets/my pic.png>)').imgs;
  assert.strictEqual(angle.length, 1, 'the CommonMark angle-bracket form still works');
  // Not an image extension: stays text, like before.
  assert.strictEqual(srcsOf(md, '![a](not an image)').imgs.length, 0);
  assert.strictEqual(srcsOf(md, '![a](notes and more.txt)').imgs.length, 0);
  // A normal link is not turned into an image.
  assert.strictEqual(srcsOf(md, '[a](assets/x y.png)').imgs.length, 0);
})();

(function testCodeIsNotRewritten() {
  const md = newMd();
  const html = md.render('```\n![x](/a b/c.png)\n```\n\n`![x](/a b/c.png)`');
  assert.ok(!/<img/.test(html), 'code must show the source, not a picture: ' + html);
  assert.ok(html.includes('![x](/a b/c.png)'), 'the source text is kept in code');
})();

(function testTwoImagesOnOneLine() {
  const md = newMd();
  const { imgs } = srcsOf(md, '![a](/p q/a.png) and ![b](/r s/b.jpg)');
  assert.strictEqual(imgs.length, 2);
  assert.strictEqual(imgs[1].src, '/r%20s/b.jpg');
})();

(function testRuleIsInstalledOnce() {
  const md = newMd();
  PI.installLooseImageRule(md);
  PI.installLooseImageRule(md);
  assert.strictEqual(srcsOf(md, '![a](/p q/a.png)').imgs.length, 1);
  PI.installLooseImageRule(null); // must not throw
})();

// ---- resolveLocalImagePath ---------------------------------------------------------------------------

(function testResolveLocalImagePath() {
  const r = PI.resolveLocalImagePath;
  assert.strictEqual(r('', '/n'), null);
  assert.strictEqual(r('https://example.com/a.png', '/n'), null);
  assert.strictEqual(r('http://example.com/a.png', '/n'), null);
  assert.strictEqual(r('data:image/png;base64,AAAA', '/n'), null);
  assert.strictEqual(r('/api/image?path=x', '/n'), null);
  assert.strictEqual(r('assets/a.png', '/notes'), '/notes/assets/a.png');
  assert.strictEqual(r('assets/a.png', ''), 'assets/a.png', 'an unsaved note has no folder to resolve against');
  assert.strictEqual(r('C:\\pics\\a.png', '/notes'), 'C:\\pics\\a.png');
  assert.strictEqual(r('C:/pics/a.png', '/notes'), 'C:/pics/a.png');
  assert.strictEqual(r('/abs/a.png', '/notes'), '/abs/a.png');
})();

(function testFileUrls() {
  const r = PI.resolveLocalImagePath;
  assert.strictEqual(r('file:///C:/pics/a%20b.png', ''), 'C:/pics/a b.png');
  assert.strictEqual(r('file:///Users/me/Library/Application%20Support/x.png', ''), '/Users/me/Library/Application Support/x.png',
    'a macOS file URL keeps its leading slash (it was dropped before, turning the path relative)');
  assert.strictEqual(r('file://C:/x.png', ''), 'C:/x.png');
})();

console.log('preview_images tests passed');
