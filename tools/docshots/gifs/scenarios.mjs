// The demo scenarios. Each one has
//   crop     [x, y, w, h]  the part of the 1120x720 page that ends up in the GIF (viewport pixels)
//   prepare  runs before recording: opens the note, installs the scripted backend answers
//   run      the recorded part: real key events into the real page, with pauses so a viewer can follow
//
// The answers of "the model", "the agent" and "the shell" are scripted here (the harness has no real backend);
// the UI state they lead to is the application's own: the results go back through the same callbacks the Go side
// calls (__onLLMResult, __onAutocompleteResult, __onCliFilterResult, __onSlotAgentResult, __onJevResult).

import { addStyle } from './lib.mjs';

// ---- helpers -----------------------------------------------------------------------------------------
// Opens a new note (Ctrl+N), puts `text` in it in one step (setup, not recorded) and places the caret.
async function newNote(env, text, { caret = 'end', zoom = 0 } = {}) {
  const { page } = env;
  await env.human.key('n', { ctrl: true });
  await page.waitFor("document.activeElement && document.activeElement.id === 'editor' && document.querySelectorAll('#tabs-list .tab-item').length >= 4", { label: 'new note' });
  // A new note starts with a date heading; the demo note replaces it.
  await env.ev('(function(){var ed=__docshot.editor(); ed.focus(); ed.setSelectionRange(0, ed.value.length);})()');
  if (text) await page.type(text);
  else await env.human.key('Backspace');
  for (let i = 0; i < zoom; i++) await env.human.key('=', { ctrl: true });
  if (caret === 'end') await env.ev('__docshot.setCaret(__docshot.editor().value.length)');
  else if (caret === 'start') await env.ev('__docshot.setCaret(0)');
  else if (typeof caret === 'number') await env.ev(`__docshot.setCaret(${caret})`);
  await env.ev("(function(){var m=document.getElementById('stat-message'); if(m) m.textContent=''; return true;})()");
  await env.sleep(500);
}

// Line n (1-based) start offset in the current editor text.
const lineStart = (env, n) => env.ev(`__docshot.lineStart(${n})`);

// ---- 1. ask-ai -----------------------------------------------------------------------------------------
const ASK_NOTE = [
  '# Team sync',
  '',
  'Ok so in the sync today we talked about the launch date for a long time and nobody agreed.',
  'Ken says the beta invites keep bouncing, and Mio thinks the notes could slip to next week.',
  'Anyway, Thursday then, I guess.',
  '',
].join('\n');

const ASK_ANSWER = [
  '- Launch date is still open; decision on Thursday.',
  '- Beta invites are bouncing (Ken); release notes may slip a week.',
].join('\n');

const askAi = {
  title: 'Ask AI about a selection (Ctrl+L)',
  crop: [0, 40, 860, 290],
  async prepare(env) {
    await newNote(env, ASK_NOTE, { caret: 'start' });
    await env.ev(`__docshot.setCaret(__docshot.lineStart(3))`);
    // The default highlight length (the demo config sets a longer one for its still pictures).
    await env.ev('MdMemoBridge.getConfig().ghost_diff_duration_ms = 4000');
    await env.ev(`(function () {
      var answer = ${JSON.stringify(ASK_ANSWER)};
      window.backend.queryLLMAsync = function (reqId) {
        setTimeout(function () { window.__onLLMResult(reqId, answer, ''); }, 1900);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause } = env;
    await pause(600);
    // Select the three lines the way a keyboard user does: two lines down, then to the end of the line.
    await human.press('ArrowDown', { shift: true });
    await pause(240);
    await human.press('ArrowDown', { shift: true });
    await pause(240);
    await human.press('End', { shift: true });
    await pause(800);
    await human.press('l', { ctrl: true }, 'Ctrl + L');
    await env.page.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'ask bar' });
    await pause(600);
    await human.type('Make this concise');
    await pause(400);
    await human.press('Enter');
    await env.page.waitFor("__docshot.editor().value.indexOf('Launch date is still open') !== -1", { timeout: 8000, label: 'answer' });
    await pause(1500);
  },
};

// ---- 2. ghost-text -------------------------------------------------------------------------------------
const GHOST_NOTE = [
  '# Launch plan',
  '',
  'Goal: ship the beta to 50 testers by Friday.',
  'Risk: the invite emails still bounce.',
  '',
  '',
].join('\n');

const GHOST_RULES = [
  { after: 'Next steps for the launch:', text: ' confirm the tester list and fix the bounced invites.' },
  { after: 'Owner:', text: ' Aya (release notes), Ken (tester list).' },
];

const ghostText = {
  title: 'Ghost text prediction, accepted with Tab',
  crop: [0, 40, 860, 260],
  typing: { minMs: 45, maxMs: 65 },
  async prepare(env) {
    await newNote(env, GHOST_NOTE, { caret: 'end' });
    await env.ev(`(function () {
      var rules = ${JSON.stringify(GHOST_RULES)};
      window.backend.autocompleteAsync = function (reqId, prefix) {
        var out = '';
        rules.forEach(function (r) { if (prefix.slice(-r.after.length) === r.after) out = r.text; });
        setTimeout(function () { window.__onAutocompleteResult(reqId, out, ''); }, out ? 300 : 30);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    const ghostShown = "!!document.querySelector('#ghost-overlay .ghost-suggestion') && document.querySelector('#ghost-overlay .ghost-suggestion').textContent.length > 0";
    await pause(500);
    await human.type('Next steps for the launch:');
    await page.waitFor(ghostShown, { timeout: 6000, label: 'first suggestion' });
    await pause(900);
    await human.press('Tab', {}, 'Tab');
    await pause(600);
    await human.press('Enter');
    await pause(150);
    await human.type('Owner:');
    await page.waitFor(ghostShown, { timeout: 6000, label: 'second suggestion' });
    await pause(800);
    await human.press('Tab', {}, 'Tab');
    await pause(500);
  },
};

// ---- 3. command-bar ------------------------------------------------------------------------------------
const CMD_NOTE = ['error', 'info', 'warn', 'error', 'info', 'error', 'info', 'warn', 'error', ''].join('\n');
const CMD_LINE = 'sort | uniq -c | sort -rn';

const commandBar = {
  title: 'Command bar (Ctrl+E): run a shell one-liner on the selection',
  crop: [0, 40, 940, 330],
  async prepare(env) {
    await newNote(env, CMD_NOTE, { caret: 'start' });
    // Result below the selection, no extra tab, so the whole story stays in one note.
    await env.ev("(function(){var c=MdMemoBridge.getConfig();c.cli=c.cli||{};c.cli.openResultInNewTab=false;try{localStorage.removeItem('md_memo_cmdbar_mode');}catch(e){}})()");
    // The scripted shell: computes the real result of this pipeline (sort / uniq -c / sort -rn) from the text it is given.
    await env.ev(`(function () {
      function sortLines(lines, flags) {
        var out = lines.slice();
        var num = /n/.test(flags), rev = /r/.test(flags);
        out.sort(function (a, b) {
          if (num) {
            var x = parseFloat(a), y = parseFloat(b);
            x = isNaN(x) ? 0 : x; y = isNaN(y) ? 0 : y;
            if (x !== y) return x - y;
          }
          return a < b ? -1 : a > b ? 1 : 0;
        });
        if (rev) out.reverse();
        if (/u/.test(flags)) out = out.filter(function (l, i) { return i === 0 || l !== out[i - 1]; });
        return out;
      }
      function uniq(lines, flags) {
        var out = [];
        lines.forEach(function (l) {
          var last = out[out.length - 1];
          if (last && last.line === l) last.n++; else out.push({ line: l, n: 1 });
        });
        return out.map(function (o) {
          return /c/.test(flags) ? ('       ' + o.n).slice(-7) + ' ' + o.line : o.line;
        });
      }
      function run(cmd, input) {
        var lines = String(input).replace(/\\r\\n?/g, '\\n').replace(/\\n+$/, '').split('\\n');
        var stages = cmd.split('|').map(function (s) { return s.trim(); });
        for (var i = 0; i < stages.length; i++) {
          var p = stages[i].split(/\\s+/), name = p[0], flags = p.slice(1).join('').replace(/-/g, '');
          if (name === 'sort') lines = sortLines(lines, flags);
          else if (name === 'uniq') lines = uniq(lines, flags);
          else return { exitCode: 127, output: '', error: name + ': command not found' };
        }
        return { exitCode: 0, output: lines.join('\\n') + '\\n', error: '' };
      }
      window.backend.runCommandFilterAsync = function (reqId, cmd, input) {
        var res = run(cmd, input);
        setTimeout(function () { window.__onCliFilterResult(reqId, res, ''); }, 800);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(800);
    await human.press('a', { ctrl: true });
    await pause(900);
    await human.press('e', { ctrl: true }, 'Ctrl + E');
    await page.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden') && document.getElementById('cli-filter-input').hasAttribute('list')", { label: 'command bar in CLI mode' });
    await pause(500);
    await human.type(CMD_LINE);
    await pause(600);
    await human.press('Enter');
    await page.waitFor("__docshot.editor().value.indexOf('4 error') !== -1", { timeout: 8000, label: 'command output' });
    await pause(1800);
  },
};

// ---- 4. delegate-agent ---------------------------------------------------------------------------------
const AGENT_NOTE = [
  '# Beta release',
  '',
  '- [x] Draft the API design',
  '- [ ] Review the rate limits with Ken',
  '- [ ] Write the release notes',
  '- [ ] Send the invite list to the testers',
  '',
  '@claude Summarize the open TODOs above and draft the release notes',
].join('\n');

const AGENT_RESULT = [
  '**Open TODOs:** rate-limit review, release notes, tester invites.',
  '',
  '**Release notes (draft)**',
  '- The beta opens to 50 testers on 10-01.',
  '- Batch upload and QR pairing are included.',
  '- The rate limit stays at 60 requests per minute.',
].join('\n');

const delegateAgent = {
  title: 'Delegate to an agent (Ctrl+Enter twice, Alt+T for the task panel)',
  viewport: [1120, 560],
  crop: [0, 40, 1120, 520],
  keycapX: 0.3,
  async prepare(env) {
    await newNote(env, AGENT_NOTE, { caret: 'end', zoom: 3 });
    // The task panel has small text: a larger panel keeps it readable after the scale-down to 860 px.
    await addStyle(env.page, '__gif_panel', '#running-tasks-panel { zoom: 1.3; }');
    await env.ev(`(function () {
      var D = window.__docshot;
      var result = ${JSON.stringify(AGENT_RESULT)};
      D.peek = D.peek || {};
      window.backend.runSlotAgentAsync = function (reqId, filePath, text, cursor) {
        D.slotRuns.push({ reqId: reqId, filePath: filePath, cursor: cursor });
        [[400, 'Reading the note...'], [1200, 'Found 3 open TODOs'], [1900, 'Drafting the release notes...']].forEach(function (s) {
          setTimeout(function () { D.peek[reqId] = s[1]; }, s[0]);
        });
        setTimeout(function () {
          window.__onSlotAgentResult({ reqId: reqId, outputMode: 'below', status: 'completed', exitCode: 0, output: result });
        }, 3000);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(600);
    await human.press('Enter', { ctrl: true }, 'Ctrl + Enter');
    await page.waitFor("__docshot.editor().value.indexOf('{{ @claude-code') !== -1", { label: 'rewritten as an agent task' });
    await pause(1100);
    await human.press('Enter', { ctrl: true }, 'Ctrl + Enter');
    await page.waitFor("__docshot.editor().value.indexOf('md-memo:run') !== -1", { label: 'run marker' });
    await pause(500);
    await human.press('t', { alt: true }, 'Alt + T');
    await page.waitFor("!document.getElementById('running-tasks-panel').classList.contains('hidden')", { label: 'task panel' });
    await page.waitFor("__docshot.editor().value.indexOf('md-memo:res') !== -1", { timeout: 10000, label: 'result block' });
    await pause(1100);
    await human.press('t', { alt: true }, 'Alt + T');
    await pause(1200);
  },
};

// ---- 5. live-preview -----------------------------------------------------------------------------------
const PREVIEW_TEXT = [
  '# Launch',
  '',
  '- Beta',
  '- Docs',
  '',
  '```mermaid',
  'graph LR',
  'Plan-->Build-->Test-->Ship',
  '```',
].join('\n');

const livePreview = {
  title: 'Live preview to the side, then full preview',
  crop: [0, 40, 1120, 380],
  typing: { minMs: 45, maxMs: 52 },
  async prepare(env) {
    await newNote(env, '', { caret: 'start', zoom: 3 });
    // The diagram library (3 MB) is loaded on first use; load it and draw once now, so the recording shows the
    // application's steady state and not the harness's first-load stall.
    await env.ev(`(async function () {
      if (!window.mermaid) {
        await new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = 'vendor/mermaid.min.js';
          s.onload = resolve; s.onerror = reject;
          document.body.appendChild(s);
        });
      }
      try { await window.mermaid.render('warmup', 'graph LR\\nA-->B'); } catch (e) { /* only a warm-up */ }
      var w = document.getElementById('dwarmup'); if (w) w.remove();
      return true;
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(500);
    await human.press('v', { ctrl: true, alt: true }, 'Ctrl + Alt + V');
    await page.waitFor("!document.getElementById('secondary-pane').classList.contains('hidden')", { label: 'preview pane' });
    await pause(500);
    // The heading and the list with the usual small stops at line ends (the preview follows), then the diagram block in one
    // go: the preview redraws after every 120 ms of silence, so a half-typed diagram would flash a syntax error.
    const cut = PREVIEW_TEXT.indexOf('```');
    await human.type(PREVIEW_TEXT.slice(0, cut));
    await human.type(PREVIEW_TEXT.slice(cut), { extra: false });
    await page.waitFor("!!document.querySelector('#secondary-preview-pane svg')", { timeout: 20000, label: 'mermaid diagram' });
    await pause(800);
    await human.press('p', { ctrl: true }, 'Ctrl + P');
    await pause(700);
  },
};

// ---- 6. scrap-search -----------------------------------------------------------------------------------
const SCRAP_NOTE = ['# Beta launch', '', 'What did we decide about the rate limit?', '', ''].join('\n');

const scrapSearch = {
  title: 'Search the daily scraps (Ctrl+Shift+F) and quote a hit with Tab',
  crop: [0, 40, 860, 470],
  async prepare(env) {
    await newNote(env, SCRAP_NOTE, { caret: 'end' });
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(800);
    await human.press('F', { ctrl: true, shift: true }, 'Ctrl + Shift + F');
    await page.waitFor("!document.getElementById('scraps-search-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'scraps-search-input'", { label: 'search input' });
    await pause(700);
    for (const c of 'limit') {
      await human.char(c);
      await pause(330);
    }
    await page.waitFor("document.querySelectorAll('.scraps-match-item').length === 2", { timeout: 5000, label: 'two hits' });
    await pause(1100);
    await human.press('ArrowDown');
    await pause(900);
    await human.press('Tab', {}, 'Tab');
    await page.waitFor("__docshot.editor().value.indexOf('rate limits stay at 60') !== -1", { label: 'quote inserted' });
    await pause(1200);
  },
};

// ---- 7. quick-actions ----------------------------------------------------------------------------------
const QA_NOTE = [
  '# Beta launch',
  '',
  '- [x] Draft the API design',
  '- [ ] Review the rate limits',
  '- [ ] Prepare the release notes',
].join('\n');

const QA_CANDIDATES = [
  { action_type: 'ai', command: '{{ Turn the checklist above into three release note bullets }}', description: 'An agent drafts the release notes in the background' },
  { action_type: 'doc', command: 'Add a short "Risks" section under the checklist', description: 'The built-in AI writes the section for you' },
  { action_type: 'sh', command: 'git log --oneline -10', description: 'List the ten most recent commits and insert them' },
];

const QA_MARKDOWN = [
  '',
  '',
  '## Risks',
  '',
  '- The rate limit may block heavy testers.',
  '- Invite emails still bounce.',
].join('\n');

const quickActions = {
  title: 'Quick Actions (Ctrl+J): pick a suggestion with Tab and Enter',
  viewport: [1120, 500],
  crop: [0, 40, 1120, 460],
  keycapX: 0.3,
  async prepare(env) {
    await newNote(env, QA_NOTE, { caret: 'end', zoom: 3 });
    await addStyle(env.page, '__gif_panel', '#jev-action-panel { zoom: 1.3; }');
    await env.ev(`(function () {
      var cands = ${JSON.stringify(QA_CANDIDATES)};
      var md = ${JSON.stringify(QA_MARKDOWN)};
      window.backend.jevPredict = function () {
        return new Promise(function (resolve) { setTimeout(function () { resolve({ candidates: cands }); }, 900); });
      };
      window.backend.jevExecuteAsync = function (reqId) {
        setTimeout(function () { window.__onJevResult(reqId, { success: true, markdown: md }); }, 1200);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(800);
    await human.press('j', { ctrl: true }, 'Ctrl + J');
    await page.waitFor("!document.getElementById('jev-action-panel').classList.contains('hidden') && document.querySelectorAll('.jev-slot-card').length === 3", { timeout: 6000, label: 'three suggestion cards' });
    await pause(1300);
    await human.press('Tab', {}, 'Tab');
    await pause(900);
    await human.press('Enter', {}, 'Enter');
    await page.waitFor("__docshot.editor().value.indexOf('## Risks') !== -1", { timeout: 8000, label: 'section inserted' });
    await pause(1300);
  },
};

export const SCENARIOS = {
  'ask-ai': askAi,
  'ghost-text': ghostText,
  'command-bar': commandBar,
  'delegate-agent': delegateAgent,
  'live-preview': livePreview,
  'scrap-search': scrapSearch,
  'quick-actions': quickActions,
};
