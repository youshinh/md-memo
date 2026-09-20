// Parity tests for the per-keystroke hot-path refactors (T2, T3, T5, T12).
// Each test runs the NEW implementation (extracted from source) against a
// reference copy of the OLD implementation and asserts identical outputs on
// tricky inputs: empty text, caret at 0 / end, no trailing newline, whitespace
// only lines, date-header first lines, very long single lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');
const imeCode = fs.readFileSync(path.resolve('frontend/js/ime_guardian.js'), 'utf-8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

// Extract a top-level `function name(...) { ... }` block from source text by
// brace matching (the suites in this repo extract functions the same way).
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

function evalFunction(code, name, extraContext = {}) {
  const context = vm.createContext(Object.assign({ console }, extraContext));
  vm.runInContext(`${code}\nglobalThis.__fn = ${name};`, context);
  return context.__fn;
}

// ---------------------------------------------------------------------------
// Shared tricky inputs
// ---------------------------------------------------------------------------
const LONG_LINE = 'a'.repeat(20000);
const DOCS = [
  '',
  '\n',
  '\n\n\n',
  '   ',
  '   \n\t\n  ',
  'Single line without newline',
  'First line\nSecond line',
  'Trailing newline\n',
  '# 2026-09-20\n\nReal title here\nmore',
  '# 2026-09-20 18:28\n2026/09/11 18:28:30\n- [x] Task title\nbody',
  '2026-09-20\n',
  '   \n# 2026/01/02\n   \n* [ ] buy milk\n',
  '#\n## \n### Heading three',
  '- item one\n- item two',
  '1. numbered title\nrest',
  'x'.repeat(60) + '\nsecond',
  LONG_LINE,
  LONG_LINE + '\ntail',
  'a\r\nb\r\nc',
  '\\/:*?"<>|\nclean title',
  '# \\/:*?"<>|only bad chars\nfallback line'
];

// ---------------------------------------------------------------------------
// T2: deriveTitleFromContent
// ---------------------------------------------------------------------------
function deriveTitleFromContentOld(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let fallbackDateTitle = '';
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    const isDateOnly = /^(#+\s*)?\d{4}[-/]\d{2}[-/]\d{2}(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(line);
    if (isDateOnly) {
      if (!fallbackDateTitle) {
        fallbackDateTitle = line.replace(/^#+\s*/, '').replace(/[\\/:*?"<>|]/g, '-').trim();
      }
      continue;
    }
    if (line.startsWith('#')) {
      line = line.replace(/^#+\s*/, '');
    }
    line = line.replace(/^(\*|-|\+|\d+\.)\s+(\[[ xX]\]\s+)?/, '');
    line = line.replace(/[\\/:*?"<>|]/g, '').trim();
    if (line) {
      return line.length > 40 ? line.substring(0, 40) : line;
    }
  }
  return fallbackDateTitle || '';
}

check('T2 deriveTitleFromContent is byte-identical to the previous split() version', () => {
  const deriveNew = evalFunction(extractFunction(appCode, 'deriveTitleFromContent'), 'deriveTitleFromContent');
  for (const doc of DOCS) {
    assert.equal(
      deriveNew(doc),
      deriveTitleFromContentOld(doc),
      `mismatch for ${JSON.stringify(doc.length > 60 ? doc.slice(0, 60) + '...' : doc)}`
    );
  }
  // Explicit spot checks so the intent is readable.
  assert.equal(deriveNew(''), '');
  assert.equal(deriveNew(undefined), '');
  assert.equal(deriveNew('# 2026-09-20\n\nReal title here\nmore'), 'Real title here');
  assert.equal(deriveNew('2026-09-20\n'), '2026-09-20');
  assert.equal(deriveNew(LONG_LINE).length, 40, 'over-long lines are still truncated at 40');
});

// ---------------------------------------------------------------------------
// T3: Ln/Col computation in updateStatusBar
// ---------------------------------------------------------------------------
function lnColOld(text, start) {
  const textBeforeCursor = text.substring(0, start);
  const lines = textBeforeCursor.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function lnColNew(text, start) {
  let lineNum = 1;
  for (let i = 0; i < start; i++) {
    if (text.charCodeAt(i) === 10) lineNum++;
  }
  const lastNewline = start > 0 ? text.lastIndexOf('\n', start - 1) : -1;
  return { line: lineNum, col: start - lastNewline };
}

check('T3 Ln/Col matches the previous substring+split computation', () => {
  // Guard that app.js really carries the new form.
  assert.ok(
    appCode.includes("const lastNewline = start > 0 ? text.lastIndexOf('\\n', start - 1) : -1;") &&
    appCode.includes('const colNum = start - lastNewline;'),
    'app.js should compute Ln/Col without splitting the prefix'
  );
  assert.ok(
    !appCode.includes("const lines = textBeforeCursor.split('\\n');"),
    'the old prefix split must be gone'
  );

  for (const doc of DOCS) {
    const positions = new Set([0, 1, 2, doc.length, Math.max(0, doc.length - 1), Math.floor(doc.length / 2)]);
    for (const p of positions) {
      if (p < 0 || p > doc.length) continue;
      assert.deepEqual(lnColNew(doc, p), lnColOld(doc, p), `Ln/Col mismatch at ${p}`);
    }
  }
  assert.deepEqual(lnColNew('', 0), { line: 1, col: 1 }, 'empty document reports Ln 1, Col 1');
  assert.deepEqual(lnColNew('abc\n', 4), { line: 2, col: 1 }, 'caret after a trailing newline starts line 2');
  assert.deepEqual(lnColNew('abc\ndef', 7), { line: 2, col: 4 }, 'caret at end of a document without trailing newline');
});

// ---------------------------------------------------------------------------
// T5: IME guardian lexical shield + trailing token extraction
// ---------------------------------------------------------------------------
function isInsideCodeOrUrlOld(text, cursor) {
  if (cursor <= 0) return false;
  const prefix = text.substring(0, cursor);
  const codeFenceCount = (prefix.match(/```/g) || []).length;
  if (codeFenceCount % 2 !== 0) return true;
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const currentLinePrefix = prefix.substring(lineStart);
  const backtickCount = (currentLinePrefix.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) return true;
  const lastWordMatch = currentLinePrefix.match(/([^\s]+)$/);
  if (lastWordMatch) {
    const word = lastWordMatch[1];
    if (/^(https?:\/\/|ftp:\/\/|file:\/\/|www\.)/i.test(word) || word.startsWith('<')) {
      return true;
    }
  }
  return false;
}

const imeContext = vm.createContext({ console, window: {} });
vm.runInContext(imeCode, imeContext);
const guardian = new imeContext.window.IMEGuardian();

const SHIELD_DOCS = [
  '',
  'plain text kaisha',
  '```\nkaisha',
  '```go\nfunc main(){}\n```\nkaisha',
  '``\nkaisha',
  '````\nkaisha',
  'inline `kaisha',
  'inline `code` kaisha',
  'see https://example.com/kaisha',
  'see www.example.com',
  'tag <div kaisha',
  'ftp://host/arigatou',
  'file://c/temp/sayounara',
  'a'.repeat(5000) + ' kaisha',
  '```\n' + 'b'.repeat(5000) + ' kaisha',
  'line1\nline2 `tick\nline3 kaisha',
  '   \t  kaisha',
  'trailing space '
];

check('T5 isInsideCodeOrUrl matches the previous full-prefix implementation', () => {
  for (const doc of SHIELD_DOCS) {
    for (let cursor = 0; cursor <= doc.length; cursor++) {
      assert.equal(
        guardian.isInsideCodeOrUrl(doc, cursor),
        isInsideCodeOrUrlOld(doc, cursor),
        `shield mismatch at cursor ${cursor} of ${JSON.stringify(doc.length > 50 ? doc.slice(0, 50) + '...' : doc)}`
      );
    }
  }
});

check('T5 getRomajiSuggestion returns the same suggestions as the previous ordering', () => {
  // Reference: old ordering (shield first, then a $-anchored regex over the prefix).
  function oldSuggestion(fullText, cursor, isEnabled) {
    if (!isEnabled || cursor <= 0) return null;
    if (isInsideCodeOrUrlOld(fullText, cursor)) return null;
    const textBeforeCursor = fullText.substring(0, cursor);
    const match = textBeforeCursor.match(/([a-zA-Z]{3,})$/);
    if (!match) return null;
    const word = match[1];
    if (!guardian.isLikelyJapaneseRomaji(word)) return null;
    return {
      word,
      hiragana: imeContext.window.romajiToHiragana(word.toLowerCase()),
      startPos: cursor - word.length,
      endPos: cursor
    };
  }

  const docs = SHIELD_DOCS.concat([
    'konnichiha',
    'arigatou gozaimasu',
    'kaisha no kaigi',
    'ko',
    'the quick brown fox',
    'import express from',
    'sayounara',
    'x'.repeat(3000) + 'konnichiha',
    'a\nb\nkonnichiha',
    '`konnichiha',
    'https://konnichiha'
  ]);

  // The guardian's objects are created inside the vm realm, so normalize through
  // JSON before comparing (deepStrictEqual would trip on the foreign prototype).
  const norm = (s) => (s === null ? 'null' : JSON.stringify([s.word, s.hiragana, s.startPos, s.endPos]));

  for (const doc of docs) {
    for (let cursor = 0; cursor <= doc.length; cursor++) {
      assert.equal(
        norm(guardian.getRomajiSuggestion(doc, cursor, true)),
        norm(oldSuggestion(doc, cursor, true)),
        `suggestion mismatch at cursor ${cursor} of ${JSON.stringify(doc.length > 50 ? doc.slice(0, 50) + '...' : doc)}`
      );
    }
    assert.equal(guardian.getRomajiSuggestion(doc, doc.length, false), null, 'disabled guardian never suggests');
  }
});

// ---------------------------------------------------------------------------
// T12: memoized shortcut parsing
// ---------------------------------------------------------------------------
check('T12 matchShortcut is memoized and still matches the same events', () => {
  const parseCode = extractFunction(appCode, 'parseShortcutString');
  const matchCode = extractFunction(appCode, 'matchShortcut');
  assert.ok(appCode.includes('const shortcutParseCache = new Map();'), 'a parse cache exists');
  assert.ok(appCode.includes('clearShortcutParseCache'), 'the cache can be cleared when shortcuts are re-recorded');

  function buildMatcher(isMac) {
    const context = vm.createContext({ console, isMac, shortcutParseCache: new Map() });
    vm.runInContext(`${parseCode}\n${matchCode}\nglobalThis.__match = matchShortcut;`, context);
    return context.__match;
  }

  // Reference implementation: the pre-memoization version.
  function matchShortcutOld(e, shortcutStr, isMac) {
    if (!shortcutStr) return false;
    const parts = shortcutStr.split('+').map(p => p.trim());
    let hasCtrl = false, hasCmd = false, hasShift = false, hasAlt = false, mainKey = null;
    for (const p of parts) {
      if (p === 'Ctrl' || p === 'Control') hasCtrl = true;
      else if (p === 'Cmd' || p === 'Command' || p === '⌘') hasCmd = true;
      else if (p === 'Shift' || p === '⇧') hasShift = true;
      else if (p === 'Alt' || p === 'Option' || p === '⌥') hasAlt = true;
      else mainKey = p;
    }
    if (!mainKey) return false;
    if (isMac) {
      let reqMeta = hasCmd, reqCtrl = hasCtrl;
      if (hasCtrl && !hasCmd) { reqMeta = true; reqCtrl = false; }
      if (reqMeta !== Boolean(e.metaKey)) return false;
      if (reqCtrl !== Boolean(e.ctrlKey)) return false;
    } else {
      const reqCtrl = hasCtrl || hasCmd;
      if (reqCtrl !== Boolean(e.ctrlKey)) return false;
    }
    if (hasShift !== Boolean(e.shiftKey)) return false;
    if (hasAlt !== Boolean(e.altKey)) return false;
    const target = mainKey.toUpperCase();
    if (target === '\\' || target === 'BACKSLASH') return e.key === '\\' || e.code === 'Backslash';
    if (target === ',' || target === 'COMMA') return e.key === ',' || e.code === 'Comma';
    if (target === 'UP' || target === 'ARROWUP' || target === '↑') return e.key === 'ArrowUp';
    if (target === 'DOWN' || target === 'ARROWDOWN' || target === '↓') return e.key === 'ArrowDown';
    if (target === 'ENTER' || target === 'RETURN') return e.key === 'Enter';
    if (target.startsWith('F') && !isNaN(target.substring(1))) return e.key.toUpperCase() === target;
    return (e.key && e.key.toUpperCase() === target) || (e.code && e.code.toUpperCase() === 'KEY' + target);
  }

  const shortcuts = [
    '', 'Ctrl+S', 'Ctrl+Shift+S', 'Cmd+K', 'Ctrl+Alt+M', 'Alt+Enter', 'Ctrl+\\',
    'Ctrl+,', 'Alt+ArrowUp', 'Alt+Up', 'F3', 'Shift+F3', 'Ctrl+J', 'Ctrl', 'Shift+Alt',
    ' Ctrl + S ', 'Option+↓', '⌘+P'
  ];
  const events = [
    { key: 's', code: 'KeyS', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
    { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
    { key: 'k', code: 'KeyK', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true },
    { key: 'Enter', code: 'Enter', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false },
    { key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
    { key: ',', code: 'Comma', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
    { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false },
    { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false },
    { key: 'F3', code: 'F3', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false },
    { key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
    { key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false },
    { key: 'p', code: 'KeyP', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }
  ];

  for (const isMac of [false, true]) {
    const match = buildMatcher(isMac);
    for (const sc of shortcuts) {
      for (const e of events) {
        // Call twice to exercise both the cold and the memoized path.
        const first = match(e, sc);
        const second = match(e, sc);
        assert.equal(first, second, `memoized call diverged for "${sc}" (isMac=${isMac})`);
        assert.equal(first, matchShortcutOld(e, sc, isMac), `match mismatch for "${sc}" (isMac=${isMac})`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// matchShortcut: digit / punctuation fallback via e.code (macOS Option-composed
// characters). Recording "Option+1" or "Option+," must still match the actual
// keydown even though macOS composes '¡'/'≤' into e.key under Option.
// ---------------------------------------------------------------------------
check('matchShortcut falls back to the physical Digit/Numpad code for digit targets', () => {
  const parseCode = extractFunction(appCode, 'parseShortcutString');
  const matchCode = extractFunction(appCode, 'matchShortcut');

  function buildMatcher(isMac) {
    const context = vm.createContext({ console, isMac, shortcutParseCache: new Map() });
    vm.runInContext(`${parseCode}\n${matchCode}\nglobalThis.__match = matchShortcut;`, context);
    return context.__match;
  }

  const macMatch = buildMatcher(true);
  // macOS: Option+1 composes '¡' into e.key; e.code stays the physical 'Digit1'.
  assert.equal(
    macMatch({ key: '¡', code: 'Digit1', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, 'Option+1'),
    true,
    'Option+1 should match via the physical Digit1 code even though e.key is the composed "¡"'
  );
  assert.equal(
    macMatch({ key: '2', code: 'Numpad2', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, 'Option+2'),
    true,
    'a numpad digit code should also satisfy a digit target'
  );
  // A literal e.key match (no e.code at all) must still work — some engines /
  // synthetic events omit `.code`.
  assert.equal(
    macMatch({ key: '3', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, 'Option+3'),
    true,
    'plain e.key digit match must still work when e.code is absent'
  );
  assert.equal(
    macMatch({ key: '¡', code: 'Digit1', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, 'Option+1'),
    false,
    'without Option held, the same keystroke must not match an Option+1 shortcut'
  );

  const winMatch = buildMatcher(false);
  assert.equal(
    winMatch({ key: '1', code: 'Digit1', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, 'Alt+1'),
    true,
    'Windows Alt+1 (no composition problem) must still match as before'
  );
});

check('matchShortcut falls back to the physical code for recorder-producible punctuation targets', () => {
  const parseCode = extractFunction(appCode, 'parseShortcutString');
  const matchCode = extractFunction(appCode, 'matchShortcut');

  function buildMatcher(isMac) {
    const context = vm.createContext({ console, isMac, shortcutParseCache: new Map() });
    vm.runInContext(`${parseCode}\n${matchCode}\nglobalThis.__match = matchShortcut;`, context);
    return context.__match;
  }

  const macMatch = buildMatcher(true);
  const cases = [
    { key: '≤', code: 'Comma', combo: 'Option+,' },
    { key: '≥', code: 'Period', combo: 'Option+.' },
    { key: '÷', code: 'Slash', combo: 'Option+/' },
    { key: 'Ú', code: 'Semicolon', combo: 'Option+;' },
    { key: 'æ', code: 'Quote', combo: "Option+'" },
    { key: '“', code: 'BracketLeft', combo: 'Option+[' },
    { key: '‘', code: 'BracketRight', combo: 'Option+]' },
    { key: '–', code: 'Minus', combo: 'Option+-' },
    { key: '≠', code: 'Equal', combo: 'Option+=' },
    { key: '`', code: 'Backquote', combo: 'Option+`' }
  ];
  for (const c of cases) {
    assert.equal(
      macMatch({ key: c.key, code: c.code, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, c.combo),
      true,
      `${c.combo} should match via the physical ${c.code} code even though e.key is the composed "${c.key}"`
    );
  }
  // '\\' and ',' already had dedicated branches before this change; confirm they still work.
  assert.equal(
    macMatch({ key: '«', code: 'Backslash', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, 'Option+\\'),
    true,
    'the pre-existing backslash branch must still work'
  );
});

if (failures > 0) {
  console.error(`\n${failures} hot-path parity test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll hot-path parity tests passed with 0 error(s)!');
