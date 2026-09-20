import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing escapeHtml/escapeHTML parity across app.js, jev_action.js, task_manager.js ===');

// The three files each keep their own private HTML-escaping helper (no
// cross-file dependency is introduced), but the bodies must stay byte-identical
// so behavior (which characters get escaped, falsy/non-string handling) can
// never silently drift between them. Extract each by regex, same technique the
// other regression tests in this repo already use, and run all three against a
// shared set of inputs.

function extractFunctionSource(src, name) {
  const re = new RegExp(`function ${name}\\(str\\) \\{[\\s\\S]*?\\n  \\}`);
  const m = src.match(re);
  assert.ok(m, `could not find function ${name}(str) { ... }`);
  return m[0];
}

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const jevJs = fs.readFileSync('frontend/js/jev_action.js', 'utf8');
const taskJs = fs.readFileSync('frontend/js/task_manager.js', 'utf8');

const appSrc = extractFunctionSource(appJs, 'escapeHtml');
const jevSrc = extractFunctionSource(jevJs, 'escapeHTML');
const taskSrc = extractFunctionSource(taskJs, 'escapeHTML');

// Normalize just the function name and line endings so the bodies compare
// structurally identical regardless of (a) the intentionally per-file
// escapeHtml/escapeHTML casing, and (b) app.js's CRLF vs. the other two files'
// LF line endings (a pre-existing, unrelated repo convention).
function normalize(src) {
  return src
    .replace(/function (escapeHtml|escapeHTML)\(str\)/, 'function ESCAPE_FN(str)')
    .replace(/\r\n/g, '\n')
    .trim();
}

assert.strictEqual(normalize(appSrc), normalize(jevSrc), 'app.js escapeHtml() must be byte-identical (aside from its name) to jev_action.js escapeHTML()');
assert.strictEqual(normalize(jevSrc), normalize(taskSrc), 'jev_action.js escapeHTML() must be byte-identical to task_manager.js escapeHTML()');
console.log('PASS: all three escaping helpers have identical bodies');

// Behavioral check: run each extracted implementation and confirm they all
// escape the full 5-entity set and handle falsy input the same way.
function runEscaper(src, name, input) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.__result = ${name}(${JSON.stringify(input)});`, ctx);
  return ctx.__result;
}

const cases = [
  '& < > " \' plain text',
  '<img src=x onerror=alert(1)>',
  `"quoted" 'single' & <tag>`,
  '',
  null,
  undefined,
];

for (const input of cases) {
  const fromApp = runEscaper(appSrc, 'escapeHtml', input);
  const fromJev = runEscaper(jevSrc, 'escapeHTML', input);
  const fromTask = runEscaper(taskSrc, 'escapeHTML', input);
  assert.strictEqual(fromApp, fromJev, `escapeHtml/escapeHTML must agree for input ${JSON.stringify(input)}`);
  assert.strictEqual(fromJev, fromTask, `escapeHTML implementations must agree for input ${JSON.stringify(input)}`);
}

// Spot-check the actual escaped output covers all 5 entities (this is what
// makes app.js's former 3-entity version unsafe inside an HTML attribute value).
const escaped = runEscaper(appSrc, 'escapeHtml', `"'&<>`);
assert.strictEqual(escaped, '&quot;&#039;&amp;&lt;&gt;');
console.log('PASS: escaping covers all 5 entities (&, <, >, ", \') and falsy input alike across all three files');

console.log('All escapeHtml/escapeHTML parity tests passed with 0 error(s)!');
