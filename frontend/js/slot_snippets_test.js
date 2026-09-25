// Unit tests for slot_snippets.js: the built-in snippets (Japanese and English, Windows and Unix
// variants), user overrides, expansion and trigger matching. Plain Node, no DOM.
const assert = require('assert');

const SS = require('./slot_snippets.js');
const AS = require('./auto_selector.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error(e && e.stack ? e.stack : e);
  }
}

const byId = (list, id) => list.filter((s) => s.id === id);
const one = (list, id) => {
  const hits = byId(list, id);
  assert.strictEqual(hits.length, 1, id + ' x' + hits.length);
  return hits[0];
};

test('loading the module is free: one global, no timers, no regexps built at load', () => {
  const path = require.resolve('./slot_snippets.js');
  const saved = require.cache[path];
  const savedGlobal = globalThis.SlotSnippets;
  delete require.cache[path];
  delete globalThis.SlotSnippets;
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const RealRegExp = RegExp;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let built = 0;
  let timers = 0;
  globalThis.RegExp = function (...args) { built++; return new RealRegExp(...args); };
  globalThis.setTimeout = (...a) => { timers++; return realSetTimeout(...a); };
  globalThis.setInterval = (...a) => { timers++; return realSetInterval(...a); };
  let fresh;
  try {
    fresh = require('./slot_snippets.js');
  } finally {
    globalThis.RegExp = RealRegExp;
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert.deepStrictEqual(Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k)), ['SlotSnippets']);
  assert.strictEqual(built, 0);
  assert.strictEqual(timers, 0);
  assert.deepStrictEqual(Object.keys(fresh).sort(), Object.keys(SS).sort());

  let t0 = process.hrtime.bigint();
  const first = fresh.list({ lang: 'ja' });
  const cold = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) fresh.list({ kind: 'command', os: 'win', lang: 'ja' });
  const warm = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) fresh.expand(first[0], { selection: 'text' });
  const exp = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  console.log('  list() first call ' + cold.toFixed(3) + ' ms (builds the ja table), then ' + (warm * 1000).toFixed(1) + ' us; expand() ' + (exp * 1000).toFixed(1) + ' us');
  assert.ok(cold < 20 && warm < 1 && exp < 1);
  require.cache[path] = saved;
  globalThis.SlotSnippets = savedGlobal;
});

test('built-ins: every snippet the contract names exists, in both languages', () => {
  const need = {
    llm: ['llm-summarize', 'llm-translate-en', 'llm-translate-ja', 'llm-proofread', 'llm-rephrase', 'llm-bullets', 'llm-table', 'llm-ideas'],
    agent: ['agent-research', 'agent-implement', 'agent-test', 'agent-review', 'agent-refactor'],
    command: ['cmd-date', 'cmd-git-status', 'cmd-git-diff-stat', 'cmd-git-log', 'cmd-grep-word', 'cmd-rg-word', 'cmd-count-lines', 'cmd-sort-unique', 'cmd-jq', 'cmd-large-files'],
    text: ['text-llm-task', 'text-agent-task', 'text-command-task']
  };
  ['ja', 'en'].forEach((lang) => {
    Object.keys(need).forEach((kind) => {
      const ids = new Set(SS.list({ kind, lang }).map((s) => s.id));
      need[kind].forEach((id) => assert.ok(ids.has(id), lang + ' ' + kind + ' ' + id));
    });
  });
});

test('built-ins: shape, unique ids per os, labels in the right language, no emoji', () => {
  ['ja', 'en'].forEach((lang) => {
    const all = SS.list({ lang });
    assert.ok(all.length >= 30);
    const seen = new Set();
    all.forEach((s) => {
      assert.ok(SS.KINDS.includes(s.kind), s.id);
      assert.ok(['win', 'unix', 'any'].includes(s.os), s.id);
      assert.ok(s.label && s.body && s.id, s.id);
      assert.strictEqual(s.builtin, true);
      assert.ok(!seen.has(s.id + '/' + s.os), 'duplicate ' + s.id + '/' + s.os);
      seen.add(s.id + '/' + s.os);
      assert.ok(!/\p{Extended_Pictographic}/u.test(s.label + s.body), s.id);
      assert.ok(Object.isFrozen(s));
      if (lang === 'en' && s.kind !== 'command') assert.ok(/^[\x20-\x7e]+$/.test(s.label + s.body.replace(/\$\{[a-z]+\}/g, '')), s.id + ' should be ASCII in English: ' + s.label + ' / ' + s.body);
      if (lang === 'en') assert.ok(/^[\x20-\x7e]+$/.test(s.label), s.id + ' label');
      if (lang === 'ja' && s.kind !== 'command' && s.kind !== 'text') assert.ok(/[\u3040-\u30ff\u4e00-\u9fff]/.test(s.body), s.id + ' body should be Japanese');
      if (lang === 'ja') assert.ok(/[\u3040-\u30ff\u4e00-\u9fffA-Za-z]/.test(s.label));
    });
  });
  assert.notStrictEqual(one(SS.list({ lang: 'ja', os: 'unix' }), 'llm-summarize').body, one(SS.list({ lang: 'en', os: 'unix' }), 'llm-summarize').body);
  assert.strictEqual(one(SS.list({ lang: 'fr' }), 'llm-summarize').body, one(SS.list({ lang: 'ja' }), 'llm-summarize').body, 'unknown language falls back to Japanese');
  assert.strictEqual(one(SS.list({ lang: 'en-US' }), 'llm-summarize').body, one(SS.list({ lang: 'en' }), 'llm-summarize').body);
  assert.strictEqual(one(SS.list({}), 'llm-summarize').body, one(SS.list({ lang: 'ja' }), 'llm-summarize').body);
  assert.ok(SS.list().length > 0);
});

test('built-ins: each trigger belongs to one id and starts with ";"', () => {
  const owner = new Map();
  SS.list({ lang: 'en' }).forEach((s) => {
    assert.ok(/^;[a-z]+$/.test(s.trigger), s.id + ' ' + s.trigger);
    if (owner.has(s.trigger)) assert.strictEqual(owner.get(s.trigger), s.id, s.trigger);
    owner.set(s.trigger, s.id);
  });
});

test('command variants: Windows bodies are PowerShell, Unix bodies are sh, and both exist where they differ', () => {
  const win = SS.list({ kind: 'command', os: 'win', lang: 'en' });
  const unix = SS.list({ kind: 'command', os: 'unix', lang: 'en' });
  assert.deepStrictEqual(win.map((s) => s.id).sort(), unix.map((s) => s.id).sort(), 'same commands on both systems');
  assert.strictEqual(new Set(win.map((s) => s.id)).size, win.length);
  assert.strictEqual(new Set(unix.map((s) => s.id)).size, unix.length);
  win.filter((s) => s.os === 'win').forEach((s) => assert.ok(/\b(?:Get|Select|Sort|Measure)-[A-Z]/.test(s.body), s.id + ': ' + s.body));
  unix.filter((s) => s.os === 'unix').forEach((s) => assert.ok(!/\b(?:Get|Select|Sort|Measure)-[A-Z]/.test(s.body), s.id + ': ' + s.body));
  assert.strictEqual(one(win, 'cmd-date').body, 'Get-Date -Format "yyyy-MM-dd HH:mm"');
  assert.strictEqual(one(unix, 'cmd-date').body, 'date "+%Y-%m-%d %H:%M"');
  assert.strictEqual(one(win, 'cmd-git-status').body, 'git status');
  assert.strictEqual(one(unix, 'cmd-git-status').body, 'git status');
  assert.strictEqual(one(win, 'cmd-git-diff-stat').body, 'git diff --stat');
  assert.strictEqual(one(unix, 'cmd-git-log').body, 'git log --oneline -20');
  assert.strictEqual(one(unix, 'cmd-jq').body, 'jq . "${selection}$0"');
  assert.strictEqual(byId(SS.list({ kind: 'command', lang: 'en' }), 'cmd-date').length, 2, 'without an os filter both variants come back');
  assert.deepStrictEqual(SS.list({ kind: 'command', os: 'auto' }).map((s) => s.id + s.os), SS.list({ kind: 'command', os: SS.detectOS() }).map((s) => s.id + s.os));
});

test('command defaults are read-only: nothing destructive, no redirects, no chaining, no downloads', () => {
  const banned = /(^|[\s|(])(?:rm|rmdir|rd|del|erase|mv|move|cp|copy|xcopy|robocopy|chmod|chown|kill|killall|taskkill|shutdown|reboot|format|mkfs|dd|sudo|su|reg|mkdir|md|touch|ren|rename|ln|tee|sed|curl|wget|iex|Remove-Item|Set-Content|Add-Content|Out-File|Stop-Process|New-Item|Move-Item|Copy-Item|Rename-Item|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|Set-ExecutionPolicy)(\s|$)/i;
  ['ja', 'en'].forEach((lang) => {
    SS.list({ kind: 'command', lang }).forEach((s) => {
      assert.ok(!banned.test(s.body), s.id + ': ' + s.body);
      assert.ok(!/[<>;&`]/.test(s.body.replace(/\$\{selection\}/g, '')), s.id + ' has redirect / chaining: ' + s.body);
      assert.ok(!/-(?:delete|exec|ok)\b/.test(s.body), s.id);
      assert.ok(!/\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd)\b/i.test(s.body), s.id);
      assert.ok(!/\bgit\s+(?!status\b|diff\b|log\b)/.test(s.body), s.id + ': only read-only git');
    });
  });
  assert.ok(SS.list({ kind: 'command' }).every((s) => s.body.length < 200));
});

test('list: kind and os filters, aliases for os names', () => {
  assert.ok(SS.list({ kind: 'llm' }).every((s) => s.kind === 'llm'));
  assert.deepStrictEqual(Array.from(new Set(SS.list({ kind: ['llm', 'agent'] }).map((s) => s.kind))).sort(), ['agent', 'llm']);
  assert.strictEqual(SS.list({ kind: 'nope' }).length, 0);
  ['windows', 'win32', 'WIN'].forEach((os) => assert.ok(SS.list({ kind: 'command', os }).every((s) => s.os !== 'unix')));
  ['unix', 'linux', 'mac', 'darwin', 'macOS'].forEach((os) => assert.ok(SS.list({ kind: 'command', os }).every((s) => s.os !== 'win')));
  assert.strictEqual(SS.list({ kind: 'llm', os: 'win' }).length, SS.list({ kind: 'llm' }).length, 'os-independent snippets are always kept');
  assert.ok(['win', 'unix'].includes(SS.detectOS()));
});

test('user snippets: replace a built-in by id in place, append the rest, drop the unusable', () => {
  const user = [
    { id: 'cmd-git-status', label: 'My status', kind: 'command', body: 'git status -sb' },
    { id: 'mine-1', label: 'Mine', kind: 'llm', trigger: ';m1', body: 'do the thing: ${selection}$0' },
    { ID: 'mine-2', Label: 'Go style', Kind: 'AGENT', Trigger: ';m2', Body: 'fix it', OS: 'Windows', Agent: 'codex' },
    { id: 'no-body', kind: 'llm', body: '   ' },
    { id: 'bad-kind', kind: 'macro', body: 'x' },
    null, 5, 'text', {}
  ];
  const base = SS.list({ lang: 'en' });
  const merged = SS.list({ lang: 'en', user });
  assert.strictEqual(merged.length, base.length + 2);
  const at = base.findIndex((s) => s.id === 'cmd-git-status');
  assert.strictEqual(merged[at].id, 'cmd-git-status');
  assert.strictEqual(merged[at].body, 'git status -sb');
  assert.strictEqual(merged[at].builtin, false);
  assert.strictEqual(merged[at].os, 'any');
  assert.strictEqual(merged[at + 1].id, base[at + 1].id, 'the rest keeps its order');
  assert.deepStrictEqual(merged.slice(-2).map((s) => s.id), ['mine-1', 'mine-2']);
  assert.deepStrictEqual(merged[merged.length - 1], { id: 'mine-2', label: 'Go style', kind: 'agent', body: 'fix it', os: 'win', builtin: false, trigger: ';m2', agent: 'codex' });
  assert.deepStrictEqual(merged[merged.length - 2], { id: 'mine-1', label: 'Mine', kind: 'llm', body: 'do the thing: ${selection}$0', os: 'any', builtin: false, trigger: ';m1' });
  assert.strictEqual(byId(merged, 'cmd-git-status').length, 1);
  assert.strictEqual(SS.list({ lang: 'en', user: 'garbage' }).length, base.length);
  assert.strictEqual(SS.list({ lang: 'en', user: [] }).length, base.length);
  assert.strictEqual(SS.list({ lang: 'en', user, kind: 'agent', os: 'unix' }).some((s) => s.id === 'mine-2'), false, 'os filter applies to user snippets too');
  assert.strictEqual(SS.list({ lang: 'en', user, kind: 'agent', os: 'win' }).some((s) => s.id === 'mine-2'), true);
});

test('user snippets: one id replaces both variants of a command; missing ids and labels get defaults; later duplicates win', () => {
  const merged = SS.list({ lang: 'en', kind: 'command', user: [{ id: 'cmd-date', kind: 'command', body: 'echo mine' }] });
  assert.strictEqual(byId(merged, 'cmd-date').length, 1);
  assert.strictEqual(byId(merged, 'cmd-date')[0].body, 'echo mine');
  const two = SS.list({ kind: 'command', lang: 'en', user: [
    { id: 'cmd-date', kind: 'command', os: 'win', body: 'W' },
    { id: 'cmd-date', kind: 'command', os: 'unix', body: 'U' },
    { id: 'cmd-date', kind: 'command', os: 'unix', body: 'U2' }
  ] });
  assert.deepStrictEqual(byId(two, 'cmd-date').map((s) => s.os + s.body), ['winW', 'unixU2']);
  const anon = SS.normalizeUser([{ kind: 'llm', body: 'a' }, { kind: 'text', body: 'b', label: ' Bee ' }]);
  assert.deepStrictEqual(anon.map((s) => [s.id, s.label]), [['user-1', 'user-1'], ['user-2', 'Bee']]);
});

const SAMPLE = (id, os, lang) => one(SS.list({ lang: lang || 'en', os: os || 'unix' }), id);

test('expand: llm and command snippets are wrapped, with the caret where $0 was', () => {
  const summarize = SAMPLE('llm-summarize');
  const r = SS.expand(summarize, { selection: 'long text here' });
  assert.strictEqual(r.text, '[[ @llm Summarize this text in 3 lines: long text here ]]');
  assert.strictEqual(r.caret, r.text.length - 3);
  const empty = SS.expand(summarize, {});
  assert.strictEqual(empty.text, '[[ @llm Summarize this text in 3 lines ]]', 'nothing selected: a whole sentence, no dangling colon');
  assert.strictEqual(empty.caret, empty.text.length - 3);
  const jp = SS.expand(SAMPLE('llm-translate-en', 'unix', 'ja'), { selection: 'こんにちは' });
  assert.strictEqual(jp.text, '[[ @llm この文章を英語に翻訳して: こんにちは ]]');
  const status = SS.expand(SAMPLE('cmd-git-status'), {});
  assert.deepStrictEqual(status, { text: '[[ $ git status ]]', caret: 'git status'.length + 5 });
  const jq = SS.expand(SAMPLE('cmd-jq'), { selection: 'data/x.json' });
  assert.strictEqual(jq.text, '[[ $ jq . "data/x.json" ]]');
  assert.strictEqual(jq.caret, jq.text.indexOf('" ]]'));
  const grep = SS.expand(SAMPLE('cmd-grep-word'), {});
  assert.strictEqual(grep.text, '[[ $ grep -rnF "" . | head -50 ]]');
  assert.strictEqual(grep.caret, grep.text.indexOf('""') + 1, 'the caret sits between the quotes');
  const kanji = String.fromCodePoint(0x20BB7);
  const astral = SS.expand(SAMPLE('llm-summarize'), { selection: kanji });
  assert.strictEqual(astral.caret, astral.text.length - 3, 'caret is a UTF-16 index');
  assert.strictEqual(astral.text.slice(astral.caret - 2, astral.caret), kanji);
});

test('expand: agent snippets pick the agent from the snippet, the default, or the first that exists', () => {
  const research = SAMPLE('agent-research');
  assert.ok(SS.expand(research, {}).text.startsWith('{{ @claude-code '), 'nothing known: the built-in default');
  const agents = { agy: { aliases: ['antigravity', 'gemini'] }, 'claude-code': { aliases: ['claude'] } };
  assert.ok(SS.expand(research, { agents, defaultAgent: 'agy' }).text.startsWith('{{ @agy '));
  assert.ok(SS.expand(research, { agents, defaultAgent: 'Claude' }).text.startsWith('{{ @claude-code '), 'alias, any case');
  assert.ok(SS.expand(research, { agents, defaultAgent: 'missing' }).text.startsWith('{{ @agy '), 'unknown default: the first agent');
  const pinned = Object.assign({}, research, { agent: 'gemini' });
  assert.ok(SS.expand(pinned, { agents, defaultAgent: 'claude-code' }).text.startsWith('{{ @agy '), 'snippet agent wins, resolved to the key');
  assert.ok(SS.expand(Object.assign({}, research, { agent: 'gone' }), { agents: ['only-one'], defaultAgent: 'nope' }).text.startsWith('{{ @only-one '));
  assert.ok(SS.expand(Object.assign({}, research, { agent: 'my bot' }), {}).text.startsWith('{{ @mybot '), 'agent names cannot break the notation');
  const r = SS.expand(SAMPLE('agent-test'), { defaultAgent: 'codex' });
  assert.strictEqual(r.text, '{{ @codex Run the tests and explain the cause of any failure }}');
  assert.strictEqual(r.caret, r.text.length - 3);
});

test('expand: blank task templates are text with the caret inside', () => {
  assert.deepStrictEqual(SS.expand(SAMPLE('text-llm-task'), {}), { text: '[[ @llm  ]]', caret: 8 });
  assert.deepStrictEqual(SS.expand(SAMPLE('text-command-task'), {}), { text: '[[ $  ]]', caret: 5 });
  const agent = SS.expand(SAMPLE('text-agent-task'), { agents: { 'claude-code': {} } });
  assert.deepStrictEqual(agent, { text: '{{ @claude-code  }}', caret: '{{ @claude-code '.length });
});

test('expand: ${selection}, ${line}, ${date}, $0 and the escapes', () => {
  const t = (body, ctx, extra) => SS.expand(Object.assign({ kind: 'text', body }, extra), ctx);
  assert.deepStrictEqual(t('a ${selection} b ${line} c', { selection: 'S', line: 'L' }), { text: 'a S b L c', caret: 9 });
  assert.strictEqual(t('${date}', { date: '2026-05-03' }).text, '2026-05-03');
  assert.strictEqual(t('${date}', { date: new Date(2026, 4, 3, 12) }).text, '2026-05-03');
  assert.strictEqual(t('${date}', { date: new Date(2026, 11, 31, 23, 59) }).text, '2026-12-31');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t('${date}', {}).text));
  assert.deepStrictEqual(t('x$0y$0z', {}), { text: 'xyz', caret: 1 });
  assert.deepStrictEqual(t('no caret marker', {}), { text: 'no caret marker', caret: 15 });
  assert.deepStrictEqual(t('$0', {}), { text: '', caret: 0 });
  assert.deepStrictEqual(t("awk '{print $$0}' $0", {}), { text: "awk '{print $0}' ", caret: 17 });
  assert.strictEqual(t('$${selection} ${selection}', { selection: 'S' }).text, '${selection} S');
  assert.strictEqual(t('${nope} $ $$ ${', { selection: 'S' }).text, '${nope} $ $$ ${');
  assert.strictEqual(t('echo $$', {}).text, 'echo $$');
  assert.strictEqual(t('${selection}', { selection: '$0 and ${line}', line: 'X' }).text, '$0 and ${line}', 'values are never re-expanded');
  assert.strictEqual(t('${selection}', { selection: 'a\nb\n\nc' }).text, 'a\nb\n\nc', 'text keeps line breaks');
  assert.deepStrictEqual(SS.expand(null, null), { text: '', caret: 0 });
  assert.deepStrictEqual(SS.expand({ body: 'x' }), { text: 'x', caret: 1 });
  assert.deepStrictEqual(SS.expand({ kind: 'weird', body: 'x' }), { text: 'x', caret: 1 });
});

test('expand: ${name:fallback} writes the fallback when the value is empty or only white space', () => {
  const t = (body, ctx, extra) => SS.expand(Object.assign({ kind: 'text', body }, extra), ctx);
  const body = 'use ${selection:the note} now';
  assert.strictEqual(t(body, {}).text, 'use the note now');
  assert.strictEqual(t(body, { selection: '' }).text, 'use the note now');
  assert.strictEqual(t(body, { selection: null }).text, 'use the note now');
  assert.strictEqual(t(body, { selection: ' \t\r\n\u3000\u00a0 ' }).text, 'use the note now', 'white space only counts as empty');
  assert.strictEqual(t(body, { selection: 'X' }).text, 'use X now');
  assert.strictEqual(t(body, { selection: '  X  ' }).text, 'use   X   now', 'a value is written as it is, not trimmed');
  assert.strictEqual(t(body, { selection: 'a\nb\n\nc' }).text, 'use a\nb\n\nc now', 'a multi-line value keeps its line breaks in a text snippet');
  assert.strictEqual(t('${selection:}', {}).text, '', 'an empty fallback is allowed');
  assert.strictEqual(t('[${selection: }]', {}).text, '[ ]', 'a fallback of one space is kept');
  assert.deepStrictEqual(t('a${selection:bc}$0d', {}), { text: 'abcd', caret: 3 }, 'the caret follows what was written');
  assert.deepStrictEqual(t('a${selection:bc}$0d', { selection: 'Z' }), { text: 'aZd', caret: 2 });
  assert.strictEqual(t('${selection}|${selection:x}|${selection:y}', { selection: 'S' }).text, 'S|S|S', 'a bare placeholder and the forms with a text can share a body');
});

test('expand: ${name?prefix} writes the prefix and then the value, and nothing when the value is empty', () => {
  const t = (body, ctx, extra) => SS.expand(Object.assign({ kind: 'text', body }, extra), ctx);
  const body = 'Explain${selection?, using this: }$0.';
  assert.deepStrictEqual(t(body, {}), { text: 'Explain.', caret: 7 });
  assert.deepStrictEqual(t(body, { selection: '' }), { text: 'Explain.', caret: 7 });
  assert.deepStrictEqual(t(body, { selection: ' \n\t' }), { text: 'Explain.', caret: 7 }, 'white space only counts as empty');
  const some = t(body, { selection: 'the plan' });
  assert.strictEqual(some.text, 'Explain, using this: the plan.');
  assert.strictEqual(some.caret, some.text.length - 1, 'the caret is after the value');
  assert.strictEqual(t('T${selection?: }', { selection: '  x ' }).text, 'T:   x ', 'the value is not trimmed');
  assert.strictEqual(t('T:${selection?\n}', { selection: 'a\nb' }).text, 'T:\na\nb', 'a multi-line value and prefix keep their line breaks in a text snippet');
  assert.strictEqual(t('${selection?}', { selection: 'S' }).text, 'S', 'an empty prefix is the bare value');
  assert.strictEqual(t('${selection?}x', {}).text, 'x');
  assert.strictEqual(t('${selection?$0!}', { selection: 'S' }).text, '$0!S', 'the prefix is plain text: no placeholder inside it');
  assert.strictEqual(t('${selection?A}${selection?B}', { selection: 'S' }).text, 'ASBS', 'each placeholder writes its own prefix');
  // a value that looks like placeholders is text, never expanded again, whatever the form
  const tricky = '$0 ${line} ${selection:zz} ${selection?q} $${x}';
  assert.strictEqual(t('${selection}', { selection: tricky, line: 'X' }).text, tricky);
  assert.strictEqual(t('${selection:fb}', { selection: tricky, line: 'X' }).text, tricky);
  assert.deepStrictEqual(t('>${selection?P: }<', { selection: tricky, line: 'X' }), { text: '>P: ' + tricky + '<', caret: 5 + tricky.length });
  // braces in the value are just characters
  assert.strictEqual(t('${selection?T: }', { selection: '{x} } {{ \\}' }).text, 'T: {x} } {{ \\}');
});

test('expand: "\\}" is a brace and "\\\\" a backslash in the text of a placeholder; nothing nests', () => {
  const text = (body, ctx) => SS.expand({ kind: 'text', body }, ctx || {}).text;
  assert.strictEqual(text('${selection:a\\}b}'), 'a}b');
  assert.strictEqual(text('${selection?\\}\\}: }', { selection: 'v' }), '}}: v');
  assert.strictEqual(text('${selection:x\\\\}y'), 'x\\y', 'an escaped backslash before the closing brace: the brace closes');
  assert.strictEqual(text('${selection:x\\\\\\}y}'), 'x\\}y', 'a backslash, then a brace');
  assert.strictEqual(text('${selection:C:\\dir\\n}'), 'C:\\dir\\n', 'any other backslash stays as it is');
  assert.strictEqual(text('a\\}b \\\\ ${selection}', { selection: 'S' }), 'a\\}b \\\\ S', 'outside a placeholder a backslash means nothing');
  assert.strictEqual(text('${selection:{a\\}b}'), '{a}b', 'a "{" needs no escape');
  assert.strictEqual(text('${selection:{a}b}'), '{ab}', 'no nesting: the first "}" that is not escaped closes it, the rest is plain text');
  assert.strictEqual(text('$${selection:x}'), '${selection:x}', '"$$" still writes a literal "$" first');
  assert.deepStrictEqual(SS.expand({ kind: 'text', body: '${selection:$0}' }, {}), { text: '$0', caret: 2 }, 'no placeholder inside the text, so this "$0" is not the caret');
  assert.strictEqual(text('${selection:${line}}', { line: 'L' }), '${line}', 'nor is ${line}: "}" closes the text after "${line"');
});

test('expand: an unknown name or a placeholder that is never closed stays as it is', () => {
  const t = (body, ctx) => SS.expand({ kind: 'text', body }, ctx || { selection: 'S' });
  const same = ['${nope:x} ${nope?y} ${nope}', '${Selection:x} ${selectionx:a} ${ selection:a}', 'a ${selection:abc', 'a ${selection?abc', '${selection:', '${selection?', '${selection', 'a ${selection:abc\\}', 'a ${selection?abc\\'];
  same.forEach((body) => assert.strictEqual(t(body).text, body, body));
  assert.deepStrictEqual(t('${selection:abc $0 d'), { text: '${selection:abc  d', caret: 16 }, 'a $0 after an unclosed placeholder still counts');
  assert.strictEqual(t('x ${selection:abc ${line}', { line: 'L' }).text, 'x abc ${line', 'the first unescaped "}" closes it, even one that belongs to a later ${');
  assert.strictEqual(t('${selection?a}${nope?b}${selection:c', { selection: 'S' }).text, 'aS${nope?b}${selection:c');
});

test('expand: ${line}, ${date} and ${agent} take a text too', () => {
  const t = (body, ctx) => SS.expand({ kind: 'text', body }, ctx || {}).text;
  assert.strictEqual(t('${line:no line}', { line: '' }), 'no line');
  assert.strictEqual(t('${line:no line}', { line: 'L' }), 'L');
  assert.strictEqual(t('${line?Line: }', { line: 'L' }), 'Line: L');
  assert.strictEqual(t('[${line?Line: }]', { line: '   ' }), '[]');
  assert.strictEqual(t('${date:unknown}', { date: new Date(NaN) }), 'unknown');
  assert.strictEqual(t('${date:unknown}', { date: '2026-05-03' }), '2026-05-03');
  assert.strictEqual(t('${date?on }', { date: '2026-05-03' }), 'on 2026-05-03');
  assert.strictEqual(t('${agent:x} ${agent?@}', { agents: ['codex'] }), 'codex @codex');
});

test('expand: the text is the snippet author\'s own, the value is still made safe, and a task stays one line', () => {
  const llm = (body, selection) => SS.expand({ kind: 'llm', body }, { selection }).text;
  assert.strictEqual(llm('Explain${selection?: }$0', ''), '[[ @llm Explain ]]');
  assert.strictEqual(llm('Explain${selection?: }$0', 'a\nb'), '[[ @llm Explain: a b ]]');
  assert.strictEqual(llm('Explain ${selection:the\nnote}', ''), '[[ @llm Explain the note ]]', 'a line break in the text is one space, like the rest of the body');
  assert.strictEqual(llm('Explain${selection?:\n  }', 'a'), '[[ @llm Explain: a ]]');
  assert.strictEqual(llm('Explain ${selection:a ]] b}', ''), '[[ @llm Explain a ] ] b ]]', 'the text cannot break the notation either');
  assert.strictEqual(llm('Explain${selection?: }', 'x'.repeat(3000)).length, '[[ @llm Explain: '.length + 2000 + ' ]]'.length, 'the value is cut at 2000, the prefix is not counted');
  const cmd = (body, selection, os) => SS.expand({ kind: 'command', os, body }, { selection }).text;
  const ls = 'ls${selection? -- }';
  assert.strictEqual(cmd(ls, ''), '[[ $ ls ]]');
  assert.strictEqual(cmd(ls, 'a;b'), '[[ $ ls -- a b ]]', 'the prefix is the author\'s, the value has no shell syntax');
  assert.strictEqual(cmd('echo "${selection:none}"', ';;'), '[[ $ echo "none" ]]', 'a value that the shell filter empties counts as empty');
  assert.strictEqual(cmd('echo "${selection:none}"', 'a"b'), '[[ $ echo "a b" ]]');
  const agent = SS.expand({ kind: 'agent', agent: 'codex', body: 'go${selection?: }' }, { agents: ['codex'] });
  assert.strictEqual(agent.text, '{{ @codex go }}');
  assert.strictEqual(AS.findTaskAt(agent.text, 4).end, agent.text.length);
  const brace = SS.expand({ kind: 'agent', agent: 'codex', body: 'go ${selection:a \\}\\} b}' }, { agents: ['codex'] });
  assert.strictEqual(AS.findTaskAt(brace.text, 4).end, brace.text.length, 'a "}}" that an escaped fallback writes cannot end the task early');
  assert.ok(brace.text.indexOf('\n') < 0);
});

test('usesSelection: true for every form of ${selection}, false for everything that is not one', () => {
  ['a ${selection}', 'a ${selection:x}', 'a ${selection?x}', '${selection?\\}}', '${selection:}', '$0${selection}'].forEach((b) => assert.strictEqual(SS.usesSelection(b), true, b));
  ['', 'plain', '${line}', '${line:x}', '${date?x}', '$${selection}', '$${selection:x}', '${selection', '${selection:abc', '${selection?abc\\}', '${Selection}', '${selection2}', '$0'].forEach((b) => assert.strictEqual(SS.usesSelection(b), false, b));
  assert.strictEqual(SS.usesSelection(null), false);
  assert.strictEqual(SS.usesSelection(undefined), false);
  assert.strictEqual(SS.usesSelection('${line?a}${selection:b}'), true);
});

test('built-ins: the snippets that take a selection read as a whole sentence without one and add ": <selection>" with one', () => {
  const ctx = { agents: { 'claude-code': {} }, defaultAgent: 'claude-code' };
  let checked = 0;
  ['ja', 'en'].forEach((lang) => ['win', 'unix'].forEach((os) => {
    SS.list({ lang, os }).forEach((s) => {
      if (s.kind !== 'llm' && s.kind !== 'agent') return;
      const head = s.kind === 'llm' ? '[[ @llm ' : '{{ @claude-code ';
      const tail = s.kind === 'llm' ? ' ]]' : ' }}';
      const inner = (r) => {
        assert.ok(r.text.startsWith(head) && r.text.endsWith(tail), s.id + ': ' + r.text);
        return r.text.slice(head.length, r.text.length - tail.length);
      };
      const none = SS.expand(s, ctx);
      const some = SS.expand(s, Object.assign({ selection: 'SEL' }, ctx));
      const a = inner(none);
      assert.ok(a && a === a.trim() && !/\s{2}/.test(a) && !/[:\uff1a]$/.test(a) && !/\$\{|\$0/.test(a), lang + ' ' + s.id + ' with nothing selected: ' + JSON.stringify(a));
      assert.strictEqual(none.caret, head.length + a.length, s.id + ': the caret ends the sentence');
      assert.ok(!/\$\{selection\}/.test(s.body), s.id + ': no bare ${selection} in a sentence');
      assert.strictEqual(inner(some), SS.usesSelection(s.body) ? a + ': SEL' : a, lang + ' ' + s.id + ' with a selection');
      assert.strictEqual(some.caret, head.length + inner(some).length, s.id + ': the caret follows the selection');
      if (s.id !== 'agent-test') assert.ok(SS.usesSelection(s.body), s.id + ' takes the selection');
      checked++;
    });
  }));
  assert.ok(checked >= 52, 'checked ' + checked);
  const pins = [
    ['en', 'llm-summarize', '[[ @llm Summarize this text in 3 lines ]]', '[[ @llm Summarize this text in 3 lines: SEL ]]'],
    ['ja', 'llm-summarize', '[[ @llm この文章を3行で要約して ]]', '[[ @llm この文章を3行で要約して: SEL ]]'],
    ['en', 'llm-translate-en', '[[ @llm Translate this text into English ]]', '[[ @llm Translate this text into English: SEL ]]'],
    ['en', 'agent-review', '{{ @claude-code Review these changes and point out problems }}', '{{ @claude-code Review these changes and point out problems: SEL }}'],
    ['ja', 'agent-research', '{{ @claude-code Webで調べて、要点を出典付きでまとめて }}', '{{ @claude-code Webで調べて、要点を出典付きでまとめて: SEL }}'],
    ['en', 'agent-test', '{{ @claude-code Run the tests and explain the cause of any failure }}', '{{ @claude-code Run the tests and explain the cause of any failure }}']
  ];
  pins.forEach(([lang, id, none, some]) => {
    const s = SAMPLE(id, 'unix', lang);
    assert.strictEqual(SS.expand(s, ctx).text, none, id);
    assert.strictEqual(SS.expand(s, Object.assign({ selection: 'SEL' }, ctx)).text, some, id);
  });
});

test('built-ins: a command keeps its caret between the quotes and its body still has the bare placeholder', () => {
  ['ja', 'en'].forEach((lang) => ['win', 'unix'].forEach((os) => {
    const sel = SS.list({ lang, os, kind: 'command' }).filter((s) => SS.usesSelection(s.body));
    assert.ok(sel.length >= 5);
    sel.forEach((s) => {
      const empty = SS.expand(s, {});
      assert.ok(empty.text.slice(empty.caret - 1, empty.caret + 1) === '""', s.id + ': ' + empty.text);
      assert.ok(SS.expand(s, { selection: 'abc' }).text.includes('"abc"'), s.id);
    });
  }));
});

test('preview: the body as one line with nothing selected', () => {
  assert.strictEqual(SS.preview('Summarize this${selection?: }$0'), 'Summarize this', 'a prefix shows nothing');
  assert.strictEqual(SS.preview('Translate: ${selection:the note}$0'), 'Translate: the note', 'a fallback shows its text');
  assert.strictEqual(SS.preview('Rewrite "${line}": ${selection}'), 'Rewrite "\u2026": \u2026', 'a bare placeholder stays an ellipsis');
  assert.strictEqual(SS.preview('${date} ${agent:x} ${line?L: }'), '\u2026 \u2026 L: \u2026', 'the other names cannot be known: an ellipsis, a prefix is shown');
  assert.strictEqual(SS.preview('a\n  b\t$0 c'), 'a b c', 'one line, the caret marker dropped');
  assert.strictEqual(SS.preview('$$0 and $${selection} ${selection:a\\}b}'), '$0 and ${selection} a}b', 'escapes are resolved like expand does');
  assert.strictEqual(SS.preview('x ${selection:abc'), 'x ${selection:abc', 'an unclosed placeholder stays as it is');
  assert.strictEqual(SS.preview(null), '');
  assert.strictEqual(SS.preview(undefined), '');
  ['ja', 'en'].forEach((lang) => SS.list({ lang }).forEach((s) => {
    const p = SS.preview(s.body);
    assert.ok(p && !/\$\{|\$0|\n/.test(p), s.id + ': ' + p);
    if (s.kind === 'llm' || s.kind === 'agent') assert.strictEqual(p, SS.expand(s, { agents: { 'claude-code': {} } }).text.replace(/^(?:\[\[ @llm |\{\{ @claude-code )/, '').replace(/ (?:\]\]|\}\})$/, ''), s.id + ': the preview is what an empty selection gives');
  }));
});

test('expand: a task stays one line and cannot be broken by the values or a multi-line body', () => {
  const llm = { kind: 'llm', body: 'first line\n  second line: ${selection}\r\nthird$0' };
  assert.strictEqual(SS.expand(llm, { selection: 'a\nb\r\nc' }).text, '[[ @llm first line second line: a b c third ]]');
  const bad = SS.expand(llm, { selection: 'x ]] y [[ z' });
  assert.ok(bad.text.indexOf('\n') < 0);
  const task = AS.findTaskAt(bad.text, 3);
  assert.ok(task && task.kind === 'llm' && task.end === bad.text.length, bad.text);
  assert.ok(task.instruction.indexOf('x ] ] y [ [ z') >= 0);
  assert.strictEqual(bad.caret, bad.text.length - 3, 'caret survives the escaping');
  const ok = SS.expand(llm, { selection: 'see [[Note]] please' });
  assert.ok(ok.text.indexOf('[[Note]]') > 0, 'balanced wiki links are left alone');
  assert.strictEqual(AS.findTaskAt(ok.text, 3).end, ok.text.length);
  const agent = SS.expand({ kind: 'agent', agent: 'codex', body: 'go ${selection}' }, { selection: 'a }} b' });
  assert.strictEqual(AS.findTaskAt(agent.text, 4).end, agent.text.length);
  assert.strictEqual(SS.expand({ kind: 'llm', body: 'x' + 'y'.repeat(3000) + ' ${selection}' }, { selection: 's'.repeat(3000) }).text.length, 8 + 1 + 3000 + 1 + 2000 + 3, 'selection is cut at 2000');
});

test('expand: values placed in a command cannot add quotes, variables or shell syntax', () => {
  const win = SAMPLE('cmd-grep-word', 'win');
  const evil = 'a"b;c|d$e`f%g&h<i>j^k!l\nm\'n';
  assert.strictEqual(SS.expand(win, { selection: evil }).text,
    '[[ $ Get-ChildItem -Recurse -File -Include *.md,*.txt | Select-String -SimpleMatch -Pattern "a b c d e f g h i j k l m n" | Select-Object -First 50 ]]');
  assert.strictEqual(SS.expand(SAMPLE('cmd-count-lines', 'win'), { selection: 'C:\\notes\\todo.md' }).text, '[[ $ Get-Content "C:\\notes\\todo.md" | Measure-Object -Line ]]', 'Windows paths keep their backslashes');
  assert.strictEqual(SS.expand(SAMPLE('cmd-count-lines', 'unix'), { selection: 'C:\\notes\\todo.md' }).text, '[[ $ wc -l "C: notes todo.md" ]]', 'the sh variant drops backslashes');
  assert.strictEqual(SS.expand(SAMPLE('cmd-jq'), { selection: 'x'.repeat(1000) }).text.length, '[[ $ jq . "" ]]'.length + 300);
  const kanji = String.fromCodePoint(0x20BB7);
  const cutAtPair = SS.expand(SAMPLE('cmd-jq'), { selection: 'x'.repeat(299) + kanji }).text;
  assert.ok(!/[\ud800-\udbff]"/.test(cutAtPair), 'no lone surrogate when the cut lands inside a pair');
  assert.strictEqual(SS.expand(SAMPLE('cmd-git-status'), { selection: 'ignored; rm -rf /' }).text, '[[ $ git status ]]');
  assert.strictEqual(SS.expand({ kind: 'command', body: 'echo ${line}' }, { line: '$(whoami) `id`' }).text, '[[ $ echo (whoami) id ]]');
});

test('expand: every built-in expands to something AutoSelector recognises as the right task', () => {
  const kinds = { llm: 'llm', agent: 'agent', command: 'command' };
  ['ja', 'en'].forEach((lang) => ['win', 'unix'].forEach((os) => {
    SS.list({ lang, os }).forEach((s) => {
      [{}, { selection: 'サンプル text' }, { selection: 'tricky ]] }} $(x) "q"', line: 'l' }].forEach((ctx) => {
        const r = SS.expand(s, Object.assign({ agents: { 'claude-code': { aliases: ['claude'] }, agy: {} }, defaultAgent: 'claude-code' }, ctx));
        assert.ok(r.caret >= 0 && r.caret <= r.text.length, s.id);
        assert.ok(r.text.indexOf('\n') < 0, s.id);
        const task = AS.findTaskAt(r.text, r.caret);
        if (kinds[s.kind]) {
          assert.ok(task, s.id + ': ' + r.text);
          assert.strictEqual(task.kind, kinds[s.kind], s.id);
          assert.strictEqual(task.start, 0);
          assert.strictEqual(task.end, r.text.length, s.id + ': ' + r.text);
          assert.strictEqual(AS.classify(r.text).kind, 'content', 'an inserted task is never re-classified as a request');
        } else {
          assert.ok(task, s.id + ': ' + r.text);
          assert.strictEqual(task.instruction, '', 'blank templates have no instruction yet');
        }
      });
    });
  }));
});

test('matchTrigger: exact matches first, then prefixes; IME full-width input and case do not matter', () => {
  const list = SS.list({ lang: 'en', os: 'unix' });
  assert.deepStrictEqual(SS.matchTrigger(';sum', list).map((s) => s.id), ['llm-summarize']);
  assert.deepStrictEqual(SS.matchTrigger('；ＳＵＭ', list).map((s) => s.id), ['llm-summarize']);
  assert.deepStrictEqual(SS.matchTrigger('  ;Sum  ', list).map((s) => s.id), ['llm-summarize']);
  assert.deepStrictEqual(SS.matchTrigger(';g', list).map((s) => s.trigger).sort(), [';gdiff', ';glog', ';grep', ';gst']);
  const both = SS.matchTrigger(';re', list).map((s) => s.id);
  assert.deepStrictEqual(both.sort(), ['agent-refactor', 'agent-research', 'agent-review', 'llm-rephrase']);
  const exactFirst = SS.matchTrigger(';rg', [{ id: 'a', trigger: ';rgx' }, { id: 'b', trigger: ';rg' }]);
  assert.deepStrictEqual(exactFirst.map((s) => s.id), ['b', 'a']);
  assert.deepStrictEqual(SS.matchTrigger('', list), []);
  assert.deepStrictEqual(SS.matchTrigger('   ', list), []);
  assert.deepStrictEqual(SS.matchTrigger(';zzz', list), []);
  assert.deepStrictEqual(SS.matchTrigger(';sum', null), []);
  assert.deepStrictEqual(SS.matchTrigger(';sum', [null, {}, { id: 'x' }]), []);
  assert.strictEqual(SS.matchTrigger(';date', SS.list({ os: 'win' })).length, 1);
  assert.strictEqual(SS.matchTrigger(';date', SS.list({})).length, 2, 'an unfiltered list carries both variants');
  assert.strictEqual(SS.normalizeTrigger('；Ｓｕｍ\u3000'), ';sum');
});

test('findByTrigger: the exact match or null', () => {
  const list = SS.list({ lang: 'en', os: 'win' });
  assert.strictEqual(SS.findByTrigger(';gst', list).id, 'cmd-git-status');
  assert.strictEqual(SS.findByTrigger('；GST', list).id, 'cmd-git-status');
  assert.strictEqual(SS.findByTrigger(';gs', list), null, 'a prefix is not an exact match');
  assert.strictEqual(SS.findByTrigger('', list), null);
  const user = SS.list({ lang: 'en', user: [{ id: 'mine', kind: 'text', body: 'x', trigger: ';gst' }] });
  assert.strictEqual(SS.findByTrigger(';gst', user).id, 'cmd-git-status', 'the first exact match wins');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
