// How the Go side calls window.__mdMemoRPC (app_rpc.go CallJSWithResponse, app_rpc_write.go rpcCallExpr):
// the page-side wrapper evaluates an expression with eval and, if that THROWS, runs the same code again as a
// function body. A write that threw half way would be applied twice (a second append), so every RPC call goes
// through an async arrow function, which hands a rejected promise back instead of throwing. This test runs the
// REAL wrapper template and the REAL call prefix / suffix, read from the Go sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const rpcGo = read('app_rpc.go');
const writeGo = read('app_rpc_write.go');

const templateMatch = /template := `([\s\S]*?)`\n/.exec(rpcGo);
assert.ok(templateMatch, 'the wrapper template is in app_rpc.go');
const template = templateMatch[1];
const prefix = /rpcCallPrefix = "((?:[^"\\]|\\.)*)"/.exec(writeGo);
const suffix = /rpcCallSuffix = "((?:[^"\\]|\\.)*)"/.exec(writeGo);
assert.ok(prefix && suffix, 'rpcCallPrefix / rpcCallSuffix are in app_rpc_write.go');
const PREFIX = JSON.parse('"' + prefix[1] + '"');
const SUFFIX = JSON.parse('"' + suffix[1] + '"');

// What CallJSWithResponse does with an expression: wrap it, run it in the page, wait for the report.
async function callPage(expr, rpcObject) {
  const reports = [];
  const window = {
    __mdMemoRPC: rpcObject,
    backend_reportRPCResult: (reqId, data, err) => reports.push({ reqId, data, err })
  };
  // a plain context: it has its own eval, Function, Promise and JSON, like the page
  const context = vm.createContext({ window });
  const wrapped = template.replace('{{EXPR_JSON}}', JSON.stringify(expr)).split('{{REQ_ID}}').join('req_1');
  vm.runInContext(wrapped, context);
  for (let i = 0; i < 20 && reports.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(reports.length, 1, 'exactly one report');
  return reports[0];
}

function makeRpc(counter) {
  return {
    append(text) {
      counter.applied++;
      counter.text += text;
      throw new Error('the page refresh failed after the edit');
    },
    get(id) {
      counter.reads++;
      return { id };
    },
    async slow() {
      counter.slow++;
      throw new Error('async failure');
    }
  };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('the wrapper template still retries a THROWING expression as a function body (the hazard the call prefix avoids)', async () => {
  const counter = { applied: 0, text: '', reads: 0, slow: 0 };
  const raw = 'window.__mdMemoRPC && window.__mdMemoRPC.append("x")';
  const report = await callPage(raw, makeRpc(counter));
  assert.equal(counter.applied, 2, 'a bare call that throws after its edit runs twice: the note would get the text twice');
  assert.match(report.err, /refresh failed/);
});

check('an RPC call built with the real prefix / suffix runs once even when it throws, and the error is reported', async () => {
  const counter = { applied: 0, text: '', reads: 0, slow: 0 };
  const expr = PREFIX + 'append("x")' + SUFFIX;
  const report = await callPage(expr, makeRpc(counter));
  assert.equal(counter.applied, 1, 'applied once');
  assert.equal(counter.text, 'x');
  assert.equal(report.err, 'the page refresh failed after the edit');
  assert.equal(report.data, '');
});

check('a call that returns a value reports its JSON; an async function is awaited; a missing __mdMemoRPC reports null', async () => {
  const counter = { applied: 0, text: '', reads: 0, slow: 0 };
  const ok = await callPage(PREFIX + 'get("tab_1")' + SUFFIX, makeRpc(counter));
  assert.equal(ok.err, '');
  assert.deepEqual(JSON.parse(ok.data), { id: 'tab_1' });

  const slow = await callPage(PREFIX + 'slow()' + SUFFIX, makeRpc(counter));
  assert.equal(slow.err, 'async failure');
  assert.equal(counter.slow, 1, 'an async failure is not retried either');

  const missing = await callPage(PREFIX + 'get("x")' + SUFFIX, undefined);
  assert.equal(missing.err, '');
  assert.equal(missing.data, 'null', 'no window.__mdMemoRPC yet: the Go side reads null as "the page is not ready"');
});

let failures = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL: ' + name);
    console.error('  ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n  ') : err));
  }
}
console.log(`\n${checks.length - failures}/${checks.length} rpc call wrapper tests passed.`);
process.exit(failures > 0 ? 1 : 0);
