// AI answers often arrive wrapped in ```markdown ... ```; the wrapper must not reach the note,
// while code blocks the user actually asked for must survive.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8').replace(/\r\n/g, '\n');

function extractFunction(name) {
  const start = appCode.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  const end = appCode.indexOf('\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return appCode.slice(start, end + 4);
}

const sandbox = {};
vm.runInNewContext(
  `${extractFunction('stripMarkdownCodeFences')}\n${extractFunction('fencesAreNested')}\nthis.strip = stripMarkdownCodeFences;`,
  sandbox
);
const strip = sandbox.strip;
const F = '```';

// 1. The reported case: a ```markdown wrapper around a free-form answer is removed.
assert.equal(strip(`${F}markdown\n# Title\n\n- item\n${F}`, true), '# Title\n\n- item');
assert.equal(strip(`${F}md\nbody\n${F}\n`, true), 'body');
assert.equal(strip(`  ${F}Markdown\nbody\n${F}  `, true), 'body');

// 2. A wrapper that itself contains a code block keeps the inner block.
assert.equal(
  strip(`${F}markdown\n# T\n\n${F}python\nprint(1)\n${F}\n${F}`, true),
  `# T\n\n${F}python\nprint(1)\n${F}`
);

// 3. Code the user asked for is left alone in free-form answers.
const py = `${F}python\nprint(1)\n${F}`;
assert.equal(strip(py, true), py);
const bare = `${F}\nplain block\n${F}`;
assert.equal(strip(bare, true), bare);
const txt = `${F}text\nplain block\n${F}`;
assert.equal(strip(txt, true), txt);

// 4. Two separate blocks that merely start with ```markdown are not a wrapper.
const twoBlocks = `${F}markdown\nA\n${F}\nprose\n${F}python\nx\n${F}`;
assert.equal(strip(twoBlocks, true), twoBlocks);

// 5. Text after the closing fence means it is not a pure wrapper.
const trailing = `${F}markdown\nA\n${F}\nafterword`;
assert.equal(strip(trailing, true), trailing);

// 6. OCR / correction mode (no flag) keeps its broader behaviour.
assert.equal(strip(bare), 'plain block');
assert.equal(strip(txt), 'plain block');
assert.equal(strip(py), py);

// 7. Non-strings and unfenced text pass through.
assert.equal(strip('', true), '');
assert.equal(strip(null, true), null);
assert.equal(strip('no fence here', true), 'no fence here');

// 8. The generic LLM result path uses the markdown-only mode.
assert.match(appCode, /else \{\n\s+cleanedResult = stripMarkdownCodeFences\(cleanedResult, true\);/);

console.log('PASS: llm fence strip');
