// Unit tests for file_anchor.js pure helpers (link parsing, path->file:// URL, misc predicates).
const assert = require('assert');

global.window = global;
global.document = {
  documentElement: { lang: 'ja' },
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector: () => null }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener: () => {}
};
global.backend = {};

const FA = require('./file_anchor.js');

// ---- findLinkAt ---------------------------------------------------------------------------------

(function testPlainFileUrlLink() {
  const text = 'see [report](file:///C:/Users/a/report.pdf) for details';
  const caret = text.indexOf('report.pdf') + 2;
  const link = FA.findLinkAt(text, caret);
  assert.ok(link);
  assert.strictEqual(link.isImage, false);
  assert.strictEqual(link.label, 'report');
  assert.strictEqual(link.target, 'file:///C:/Users/a/report.pdf');
})();

(function testImageRelativeLink() {
  const text = '![photo](./assets/x.png)';
  const link = FA.findLinkAt(text, 5);
  assert.ok(link);
  assert.strictEqual(link.isImage, true);
  assert.strictEqual(link.target, './assets/x.png');
})();

(function testAngleWrappedTargetWithSpaces() {
  const text = 'open [doc](<file:///C:/My Documents/a (1).pdf>) now';
  const caret = text.indexOf('My Documents') + 3;
  const link = FA.findLinkAt(text, caret);
  assert.ok(link, 'angle-wrapped target with spaces and parens must parse');
  assert.strictEqual(link.target, 'file:///C:/My Documents/a (1).pdf');
})();

(function testPercentEncodedParenInTarget() {
  const text = '[f](./assets/a%29b.txt)';
  const link = FA.findLinkAt(text, 5);
  assert.ok(link);
  assert.strictEqual(link.target, './assets/a%29b.txt');
})();

(function testHttpAndMailtoAreIgnored() {
  assert.strictEqual(FA.findLinkAt('[site](https://example.com)', 3), null);
  assert.strictEqual(FA.findLinkAt('[me](mailto:a@example.com)', 3), null);
})();

(function testTwoLinksOnOneLinePicksCorrectOne() {
  const text = '[a](./assets/a.png) and [b](./assets/b.png)';
  const bStart = text.lastIndexOf('[b]');
  const link = FA.findLinkAt(text, bStart + 1);
  assert.strictEqual(link.label, 'b');
  assert.strictEqual(link.target, './assets/b.png');

  const linkA = FA.findLinkAt(text, 1);
  assert.strictEqual(linkA.label, 'a');
})();

(function testCaretOutsideAnyLink() {
  const text = '[a](./assets/a.png) plain text after';
  const caret = text.indexOf('plain');
  assert.strictEqual(FA.findLinkAt(text, caret), null);
})();

(function testCaretOnBracketEdges() {
  const text = '[a](./assets/a.png)';
  assert.ok(FA.findLinkAt(text, 0), 'caret at the very start of the link');
  assert.ok(FA.findLinkAt(text, text.length), 'caret at the very end of the link');
})();

(function testNoLinkAtAll() {
  assert.strictEqual(FA.findLinkAt('just some text', 5), null);
  assert.strictEqual(FA.findLinkAt('', 0), null);
})();

// ---- collectImageLinks ----------------------------------------------------------------------

(function testCollectImageLinksSkipsNonImagesAndRemote() {
  const text = '[doc](./a.pdf)\n![pic](./b.png)\n![remote](https://x.example/c.png)';
  const links = FA.collectImageLinks(text);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].target, './b.png');
})();

// ---- pathToFileUrl --------------------------------------------------------------------------

(function testWindowsPathWithSpace() {
  assert.strictEqual(FA.pathToFileUrl('C:\\Users\\a b\\file.txt'), 'file:///C:/Users/a%20b/file.txt');
})();

(function testWindowsPathWithHashAndPercent() {
  const url = FA.pathToFileUrl('C:\\notes\\a#1%.txt');
  assert.strictEqual(url, 'file:///C:/notes/a%231%25.txt');
})();

(function testPosixPathWithJapanese() {
  const url = FA.pathToFileUrl('/home/user/日本語 file.txt');
  assert.strictEqual(url, 'file:///home/user/' + encodeURIComponent('日本語 file.txt'));
})();

(function testEmptyOrInvalidPath() {
  assert.strictEqual(FA.pathToFileUrl(''), '');
  assert.strictEqual(FA.pathToFileUrl(undefined), '');
})();

// ---- resolveLocalImageSrc ---------------------------------------------------------------------

(function testResolveFileUrlToApiImage() {
  const src = FA.resolveLocalImageSrc('file:///C:/notes/x.png', '');
  assert.strictEqual(src, '/api/image?path=' + encodeURIComponent('C:/notes/x.png'));
})();

(function testResolveRelativeJoinsNoteDir() {
  const src = FA.resolveLocalImageSrc('./assets/x.png', 'C:\\notes');
  assert.strictEqual(src, '/api/image?path=' + encodeURIComponent('C:\\notes/./assets/x.png'));
})();

// ---- escapeLabel / isImageName / hasFiles ------------------------------------------------------

(function testEscapeLabel() {
  assert.strictEqual(FA.escapeLabel('a[1]b'), 'a\\[1\\]b');
  assert.strictEqual(FA.escapeLabel(''), '');
})();

(function testIsImageName() {
  assert.strictEqual(FA.isImageName('x.png'), true);
  assert.strictEqual(FA.isImageName('x.PDF'), false);
  assert.strictEqual(FA.isImageName('x', 'image/jpeg'), true);
})();

(function testHasFiles() {
  assert.strictEqual(FA.hasFiles({ types: ['Files', 'text/plain'] }), true);
  assert.strictEqual(FA.hasFiles({ types: ['text/plain'] }), false);
  assert.strictEqual(FA.hasFiles({ files: [{}] }), true);
  assert.strictEqual(FA.hasFiles({ files: [] }), false);
  assert.strictEqual(FA.hasFiles(null), false);
})();

(function testEncodeLinkTargetRoundTrips() {
  const encoded = FA.encodeLinkTarget('./assets/my photo (1).png');
  assert.strictEqual(encoded, './assets/my%20photo%20%281%29.png');
  const text = 'see ![pic](' + encoded + ') end';
  const hit = FA.findLinkAt(text, 8);
  assert.ok(hit && hit.isImage, 'an encoded target must be found as a link');
  assert.strictEqual(hit.target, encoded);
  assert.strictEqual(FA.encodeLinkTarget('./assets/日本語.png'), './assets/日本語.png');
  assert.strictEqual(FA.encodeLinkTarget(''), '');
})();

console.log('file_anchor_test.js: all assertions passed');
