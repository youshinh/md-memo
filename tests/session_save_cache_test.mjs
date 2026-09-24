// getSessionDataJson (used by savePersistentSession and the beforeunload handler)
// must always produce exactly the bytes JSON.stringify(getSessionData()) would have
// produced, for any sequence of tab edits/opens/closes/reorders/renames/active-tab
// changes - while skipping the O(n) JSON.stringify escaping scan for tabs whose
// session fields (id/title/path/content/isDirty/encoding/cursorPos) did not change
// since the last save. That matters because `content` can be tens of MB for a huge
// note, and the debounced save fires on every typing pause in ANY open tab.
//
// The functions are extracted from app.js the way the other suites here do it
// (see tests/huge_note_perf_test.mjs): getSessionData is still the plain,
// unoptimized reference implementation left in the source, so it is used directly
// as the oracle rather than re-implemented here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
  }
}

// String/comment-aware brace matcher: getSessionDataJson's body contains bare
// '{' / '}' characters inside string literals (JSON key/brace fragments like
// '{"tabs":' and '}'), so a naive char-counting brace matcher (as used by the
// other suites here, whose extracted functions happen not to contain such
// literals) would mismatch. This version skips braces found inside strings
// and comments.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  let state = 'code'; // 'code' | 'sq' | 'dq' | 'tpl' | 'line-comment' | 'block-comment'
  for (; i < source.length; i++) {
    const ch = source[i];
    if (state === 'code') {
      if (ch === "'") state = 'sq';
      else if (ch === '"') state = 'dq';
      else if (ch === '`') state = 'tpl';
      else if (ch === '/' && source[i + 1] === '/') state = 'line-comment';
      else if (ch === '/' && source[i + 1] === '*') state = 'block-comment';
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    } else if (state === 'sq' || state === 'dq' || state === 'tpl') {
      const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      if (ch === '\\') i++;
      else if (ch === quote) state = 'code';
    } else if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (ch === '*' && source[i + 1] === '/') {
        state = 'code';
        i++;
      }
    }
  }
  return source.substring(start, i + 1);
}

const FN_NAMES = ['getTab', 'syncActiveEditorsIntoTabs', 'getSessionData', 'sessionTabFragment', 'getSessionDataJson'];

// Deterministic pseudo-random numbers (failures must be reproducible).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Fresh vm context with its own JSON so JSON.stringify calls made by the extracted
// code can be spied on/counted without affecting the host realm's JSON.
function makeEnv() {
  let stringifyCalls = 0;
  const sandbox = {
    console,
    tabs: [],
    activeTabId: null,
    tabCounter: 1,
    isSplitMode: false,
    secondaryTabId: null,
    secondaryViewMode: 'editor',
    activePane: 'primary',
    isPreviewMode: false,
    editorEl: null,
    editorSecondary: null,
    sessionTabFragmentCache: new WeakMap(),
    JSON: {
      stringify: (...args) => {
        stringifyCalls++;
        return JSON.stringify(...args);
      },
      parse: (...args) => JSON.parse(...args)
    }
  };
  const ctx = vm.createContext(sandbox);
  const code = FN_NAMES.map((n) => extractFunction(appCode, n)).join('\n');
  vm.runInContext(`${code}\nglobalThis.__api = { ${FN_NAMES.join(', ')} };`, ctx);
  return {
    sandbox,
    api: ctx.__api,
    resetStringifyCalls: () => { stringifyCalls = 0; },
    getStringifyCalls: () => stringifyCalls
  };
}

// The reference string: what today's (unoptimized) code would have written.
function referenceJson(api) {
  return JSON.stringify(api.getSessionData());
}

function makeTab(id, overrides = {}) {
  return Object.assign(
    { id, title: `${id}.md`, path: '', content: `content of ${id}`, isDirty: false, encoding: 'utf-8', cursorPos: 0 },
    overrides
  );
}

// ---------------------------------------------------------------------------
// Property test: randomized multi-tab state mutations, checked at every step.
// ---------------------------------------------------------------------------
check('getSessionDataJson matches JSON.stringify(getSessionData()) through randomized edit/open/close/reorder/rename sequences', () => {
  const { sandbox, api } = makeEnv();
  const r = rng(42);
  sandbox.tabs.push(makeTab('tab_1'), makeTab('tab_2'), makeTab('tab_3'));
  sandbox.activeTabId = 'tab_1';
  sandbox.tabCounter = 4;

  const ops = [
    // Edit a tab's content to a genuinely new value.
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.content = `edited-${Math.floor(r() * 1e9)}-${t.content}`;
    },
    // Re-assign content to an equal-but-different string reference (no-op value change).
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.content = String(t.content).slice(0);
    },
    // Rename a tab.
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.title = `renamed-${Math.floor(r() * 1000)}.md`;
    },
    // Toggle dirty flag.
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.isDirty = !t.isDirty;
    },
    // Change encoding.
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.encoding = r() < 0.5 ? 'utf-8' : 'shift_jis';
    },
    // Move the cursor.
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.cursorPos = Math.floor(r() * 5000);
    },
    // Change path (as if the tab got saved to disk).
    () => {
      if (sandbox.tabs.length === 0) return;
      const t = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)];
      t.path = r() < 0.5 ? '' : `C:/notes/n${Math.floor(r() * 100)}.md`;
    },
    // Open a new tab.
    () => {
      const id = `tab_${sandbox.tabCounter++}`;
      sandbox.tabs.push(makeTab(id, { content: `fresh-${id}`, title: `${id}.md` }));
    },
    // Close a tab.
    () => {
      if (sandbox.tabs.length === 0) return;
      const idx = Math.floor(r() * sandbox.tabs.length);
      sandbox.tabs.splice(idx, 1);
    },
    // Reorder tabs (move one to another position).
    () => {
      if (sandbox.tabs.length < 2) return;
      const from = Math.floor(r() * sandbox.tabs.length);
      let to = Math.floor(r() * sandbox.tabs.length);
      const [moved] = sandbox.tabs.splice(from, 1);
      if (to > sandbox.tabs.length) to = sandbox.tabs.length;
      sandbox.tabs.splice(to, 0, moved);
    },
    // Change the active tab (sometimes to a nonexistent id).
    () => {
      if (r() < 0.15 || sandbox.tabs.length === 0) {
        sandbox.activeTabId = `ghost_${Math.floor(r() * 1000)}`;
      } else {
        sandbox.activeTabId = sandbox.tabs[Math.floor(r() * sandbox.tabs.length)].id;
      }
    },
    // Toggle split mode / secondary pane fields.
    () => {
      sandbox.isSplitMode = !sandbox.isSplitMode;
      sandbox.secondaryTabId = sandbox.tabs.length ? sandbox.tabs[Math.floor(r() * sandbox.tabs.length)].id : null;
      sandbox.secondaryViewMode = r() < 0.5 ? 'editor' : 'preview';
    },
    // Toggle active pane / preview mode.
    () => {
      sandbox.activePane = r() < 0.5 ? 'primary' : 'secondary';
      sandbox.isPreviewMode = !sandbox.isPreviewMode;
    }
  ];

  for (let step = 0; step < 400; step++) {
    ops[Math.floor(r() * ops.length)]();
    const expected = referenceJson(api);
    const actual = api.getSessionDataJson();
    assert.equal(actual, expected, `mismatch at step ${step} (tabs=${sandbox.tabs.length})`);
  }
});

check('getSessionDataJson matches the reference with zero tabs and with undefined activeTabId/tabCounter', () => {
  const { sandbox, api } = makeEnv();
  assert.equal(api.getSessionDataJson(), referenceJson(api), 'empty session');

  sandbox.tabs.push(makeTab('tab_1'));
  sandbox.activeTabId = undefined;
  sandbox.tabCounter = undefined;
  assert.equal(api.getSessionDataJson(), referenceJson(api), 'undefined activeTabId and tabCounter');
});

// ---------------------------------------------------------------------------
// Proof that an untouched tab (in particular its `content`) is not re-serialized.
// ---------------------------------------------------------------------------
check('editing one small tab does not re-stringify an untouched huge tab', () => {
  const { sandbox, api, resetStringifyCalls, getStringifyCalls } = makeEnv();
  const hugeContent = 'H'.repeat(500000);
  sandbox.tabs.push(
    makeTab('tab_a', { content: 'small a' }),
    makeTab('tab_huge', { content: hugeContent }),
    makeTab('tab_c', { content: 'small c' })
  );
  sandbox.activeTabId = 'tab_a';

  // Warm the fragment cache.
  const warm = api.getSessionDataJson();
  assert.equal(warm, referenceJson(api));

  resetStringifyCalls();
  sandbox.tabs[0].content = 'small a, edited';
  const after = api.getSessionDataJson();
  assert.equal(after, referenceJson(api));
  // Exactly 2 JSON.stringify calls: the small "head" object, and tab_a's fragment.
  // If the huge tab were re-serialized this would be 3.
  assert.equal(getStringifyCalls(), 2, `expected 2 JSON.stringify calls, got ${getStringifyCalls()}`);

  // A change to a top-level (non-tab) field touches no tab fragment at all: only the head.
  resetStringifyCalls();
  sandbox.isPreviewMode = !sandbox.isPreviewMode;
  const afterTopLevel = api.getSessionDataJson();
  assert.equal(afterTopLevel, referenceJson(api));
  assert.equal(getStringifyCalls(), 1, `expected 1 JSON.stringify call (head only), got ${getStringifyCalls()}`);

  // Sanity: the huge content string itself is still exactly the reference it was.
  assert.ok(after.includes(hugeContent), 'huge tab content is still present in the output');
});

// ---------------------------------------------------------------------------
// Micro-benchmark: before (plain JSON.stringify(getSessionData())) vs after
// (getSessionDataJson(), fragment cache warm) for a 3-tab session with one
// 80,000-line / ~7.8MB note, editing only a small tab between saves. Not
// asserted - printed for the record.
// ---------------------------------------------------------------------------
check('benchmark: 3-tab session with one 80,000-line note', () => {
  const { sandbox, api } = makeEnv();
  const lines = [];
  for (let i = 0; i < 80000; i++) lines.push(`Line ${i}: ${'x'.repeat(85)}`);
  const hugeContent = lines.join('\n');
  console.log(`  fixture: huge tab content is ${(hugeContent.length / (1024 * 1024)).toFixed(2)} MB, ${lines.length} lines`);

  sandbox.tabs.push(
    makeTab('tab_a', { content: 'small tab A' }),
    makeTab('tab_huge', { content: hugeContent }),
    makeTab('tab_c', { content: 'small tab C' })
  );
  sandbox.activeTabId = 'tab_a';

  const ROUNDS = 10;

  // "Before": every save re-stringifies the whole session object, as the old code did.
  let beforeTotal = 0;
  for (let i = 0; i < ROUNDS; i++) {
    sandbox.tabs[0].content = `small tab A, edit ${i}`;
    const t0 = process.hrtime.bigint();
    referenceJson(api);
    const t1 = process.hrtime.bigint();
    beforeTotal += Number(t1 - t0) / 1e6;
  }

  // Warm the fragment cache once, matching the state referenceJson last left tabs in.
  api.getSessionDataJson();

  // "After": only the edited small tab (and the head) are re-stringified.
  let afterTotal = 0;
  for (let i = 0; i < ROUNDS; i++) {
    sandbox.tabs[0].content = `small tab A, edit v2 ${i}`;
    const t0 = process.hrtime.bigint();
    api.getSessionDataJson();
    const t1 = process.hrtime.bigint();
    afterTotal += Number(t1 - t0) / 1e6;
  }

  console.log(`  before (JSON.stringify(getSessionData())): avg ${(beforeTotal / ROUNDS).toFixed(3)} ms/save over ${ROUNDS} rounds`);
  console.log(`  after  (getSessionDataJson(), cache warm): avg ${(afterTotal / ROUNDS).toFixed(3)} ms/save over ${ROUNDS} rounds`);
});

if (failures > 0) {
  console.error(`\n${failures} session-save-cache test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll session-save-cache tests passed with 0 error(s)!');
