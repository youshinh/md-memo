// Hermetic check of the smoke flows (tests/smoke/NN_*.mjs): no browser is started here. It only makes sure the flow files are
// well formed, so that a typo is caught by "node tools/run_js_tests.mjs" and not on the first real run of "node tests/smoke/run.mjs":
//   - every flow file loads (a name imported from lib.mjs that does not exist fails the import), numbers are unique
//   - every flow has a title, a run(), a session that is an object or a function, and knownFailing only as a non-empty reason
//   - the flows and the runner contain no emoji (the app rule), and the flows do not import the kit themselves (the runner owns sessions)
//   - lib.mjs: the language-independent waiting-marker check works for both UI languages
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve('tests/smoke');
const queue = [];
const check = (name, fn) => queue.push({ name, fn });

const files = fs.readdirSync(dir).filter((f) => /^\d\d_.+\.mjs$/.test(f)).sort();
const lib = await import(pathToFileURL(path.join(dir, 'lib.mjs')).href);

check('there are at least 10 flows, numbered without duplicates', () => {
  assert.ok(files.length >= 10, `flow count: ${files.length}`);
  const numbers = files.map((f) => f.slice(0, 2));
  assert.equal(new Set(numbers).size, numbers.length, `duplicate numbers in ${files.join(', ')}`);
});

for (const file of files) {
  check(`${file}: well formed`, async () => {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const flow = mod.default;
    assert.ok(flow && typeof flow === 'object', 'default export is an object');
    assert.equal(typeof flow.title, 'string');
    assert.ok(flow.title.trim().length > 0, 'title is not empty');
    assert.equal(typeof flow.run, 'function');
    assert.ok(typeof flow.session === 'object' || typeof flow.session === 'function' || flow.session === undefined, 'session is an object or a function');
    if (flow.knownFailing !== undefined) assert.ok(typeof flow.knownFailing === 'string' && flow.knownFailing.trim().length > 10, 'knownFailing says why');
    if (flow.timeoutMs !== undefined) assert.ok(Number.isFinite(flow.timeoutMs) && flow.timeoutMs >= 5000);
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\p{Extended_Pictographic}/u.test(source), 'no emoji');
    assert.ok(!/from\s+['"][^'"]*tools\/explore\/kit\.mjs['"]/.test(source), 'a flow gets its session from the runner');
    assert.ok(/\bt\.step\(/.test(source), 'a flow names its steps (the failure message says where it stopped)');
    assert.ok(!/new Promise\(\s*\(?\w*\)?\s*=>\s*setTimeout|\bsleep\(/.test(source), 'no fixed sleeps in a flow: wait for a condition (lib.settle is the one exception)');
  });
}

check('the runner and lib have no emoji', () => {
  for (const f of ['run.mjs', 'lib.mjs']) {
    assert.ok(!/\p{Extended_Pictographic}/u.test(fs.readFileSync(path.join(dir, f), 'utf8')), f);
  }
});

check('hasWaitingMarker finds the waiting marker in both UI languages and nothing else', () => {
  assert.equal(lib.hasWaitingMarker('a\n\n[AI Generating: translate...]\n'), true);
  assert.equal(lib.hasWaitingMarker('a\n\n[AI 生成中: translate...]\n'), true);
  assert.equal(lib.hasWaitingMarker('# Shopping\n\nBuy oat milk on Friday\n\nReply 1.\n'), false);
  assert.equal(lib.hasWaitingMarker('- [ ] a task\n- [x] done\n[link](http://example.com)\n'), false);
});

let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}`);
  }
}
if (failed) {
  console.error(`\n${failed} of ${queue.length} smoke suite shape test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} smoke suite shape tests passed with 0 error(s)!`);
