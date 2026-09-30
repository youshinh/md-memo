// The demo scenarios. Each one has
//   crop     [x, y, w, h]  the part of the 1120x720 page that ends up in the GIF (viewport pixels)
//   prepare  runs before recording: opens the note, installs the scripted backend answers
//   run      the recorded part: real key events into the real page, with pauses so a viewer can follow
//
// The answers of "the model", "the agent" and "the shell" are scripted here (the harness has no real backend);
// the UI state they lead to is the application's own: the results go back through the same callbacks the Go side
// calls (__onLLMResult, __onAutocompleteResult, __onCliFilterResult, __onSlotAgentResult, __onJevResult).

import { addStyle, installClipboardCard, installCaption } from './lib.mjs';

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

// ---- 8. proofread --------------------------------------------------------------------------------------
const PROOF_NOTE = [
  '# Beta notes',
  '',
  'teh beta launch is on firday. we shoud confrim the tester lsit',
  'befor sending the invties',
  '',
].join('\n');

const PROOF_FIXED = [
  'The beta launch is on Friday. We should confirm the tester list',
  'before sending the invites.',
].join('\n');

const proofread = {
  title: 'AI correction (Alt+C) fixes typos in place',
  viewport: [1120, 340],
  crop: [0, 40, 860, 300],
  keycapBottom: 68,
  async prepare(env) {
    await newNote(env, PROOF_NOTE, { caret: 'start' });
    await env.ev(`__docshot.setCaret(__docshot.lineStart(3))`);
    await env.ev('MdMemoBridge.getConfig().ghost_diff_duration_ms = 4000');
    // The scripted model: a corrected copy of exactly the two lines it is given.
    await env.ev(`(function () {
      var fixed = ${JSON.stringify(PROOF_FIXED)};
      window.backend.queryLLMAsync = function (reqId, prompt) {
        window.__docshot.calls.push({ fn: 'queryLLMAsync(correction)', args: [String(prompt).slice(0, 60)] });
        setTimeout(function () { window.__onLLMResult(reqId, fixed, ''); }, 900);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(900);
    // Select the two sloppy lines with the keyboard: one line down, then to the end of the line.
    await human.press('ArrowDown', { shift: true });
    await pause(250);
    await human.press('End', { shift: true });
    await pause(1200);
    await human.press('c', { alt: true }, 'Alt + C');
    await page.waitFor("__docshot.editor().value.indexOf('The beta launch is on Friday') !== -1", { timeout: 8000, label: 'corrected text' });
    await pause(2200);
  },
};

// ---- 9. mermaid-ai -------------------------------------------------------------------------------------
const FLOW_NOTE = [
  '# Order flow',
  '',
  '- Customer places order',
  '- Payment is checked',
  '- Stock is reserved',
  '- Package is shipped',
  '- Customer gets an email',
  '',
].join('\n');

const FLOW_MERMAID = [
  '```mermaid',
  'flowchart LR',
  '  A[Order] --> B[Payment]',
  '  B --> C[Stock]',
  '  C --> D[Shipping]',
  '  D --> E[Email]',
  '```',
].join('\n');

// Opens the preview to the side, drags the app's own divider so that the preview pane gets most of the width, and closes
// the preview again (the divider position is kept for the next time it opens). Setup only, not recorded.
async function widenPreviewPane(env, editorShare) {
  const { page, human } = env;
  await human.key('v', { ctrl: true, alt: true });
  await page.waitFor("!document.getElementById('secondary-pane').classList.contains('hidden')", { label: 'preview pane' });
  await env.sleep(400);
  const r = await env.ev("(function(){var b=document.getElementById('pane-resizer').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()");
  const target = Math.round(env.size[0] * editorShare);
  const mouse = (type, x, down) => page.cdp.send('Input.dispatchMouseEvent', { type, x, y: r.y, button: down ? 'left' : 'none', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mouseMoved', r.x, false);
  await mouse('mousePressed', r.x, true);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', r.x + ((target - r.x) * i) / 8, true);
  await mouse('mouseReleased', target, false);
  await env.sleep(300);
  await human.key('\\', { ctrl: true });
  await page.waitFor("document.getElementById('secondary-pane').classList.contains('hidden')", { label: 'preview pane closed' });
  await env.sleep(300);
}

// The diagram library (3 MB) is loaded on first use; load it and draw once now, so the recording shows the
// application's steady state and not the harness's first-load stall.
function warmMermaid(env) {
  return env.ev(`(async function () {
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
}

const mermaidAi = {
  title: 'AI draws a diagram: command palette "Convert Selection to Mermaid", diagram in the side preview',
  crop: [0, 40, 1120, 470],
  async prepare(env) {
    await newNote(env, FLOW_NOTE, { caret: 'start', zoom: 3 });
    await widenPreviewPane(env, 0.34);
    await env.ev(`__docshot.setCaret(__docshot.lineStart(3))`);
    await env.ev('MdMemoBridge.getConfig().ghost_diff_duration_ms = 4000');
    await warmMermaid(env);
    await env.ev(`(function () {
      var block = ${JSON.stringify(FLOW_MERMAID)};
      window.backend.queryLLMAsync = function (reqId, prompt) {
        window.__docshot.calls.push({ fn: 'queryLLMAsync(mermaid)', args: [String(prompt).slice(0, 60)] });
        setTimeout(function () { window.__onLLMResult(reqId, block, ''); }, 1400);
        return Promise.resolve(null);
      };
    })()`);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(400);
    await human.press('v', { ctrl: true, alt: true }, 'Ctrl + Alt + V');
    await page.waitFor("!document.getElementById('secondary-pane').classList.contains('hidden')", { label: 'preview pane' });
    await pause(800);
    // Select the five steps: four lines down, then to the end of the line.
    for (let i = 0; i < 4; i++) {
      await human.press('ArrowDown', { shift: true });
      await pause(130);
    }
    await human.press('End', { shift: true });
    await pause(600);
    await human.press('P', { ctrl: true, shift: true }, 'Ctrl + Shift + P');
    await page.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'quick-pick-input'", { label: 'command palette' });
    await pause(400);
    await human.type('flowchart');
    await pause(600);
    await human.press('Enter');
    await page.waitFor("__docshot.editor().value.indexOf('flowchart LR') !== -1", { timeout: 10000, label: 'mermaid block' });
    await page.waitFor("!!document.querySelector('#secondary-preview-pane svg')", { timeout: 15000, label: 'diagram in the preview' });
    await pause(1600);
  },
};

// ---- 10. paste-image -----------------------------------------------------------------------------------
const PASTE_NOTE = ['# Publishing flow', '', 'Whiteboard sketch from today:', '', ''].join('\n');

const PASTE_MERMAID = [
  '```mermaid',
  'flowchart LR',
  '  A[Idea] --> B[Draft]',
  '  B --> C[Review]',
  '  C --> D[Publish]',
  '```',
].join('\n');

// A hand-drawn-looking whiteboard sketch (Idea -> Draft -> Review -> Publish), drawn on a canvas in the recording page.
const SKETCH_JS = `(async function () {
  var W = 560, H = 190;
  var c = document.createElement('canvas'); c.width = W; c.height = H;
  var g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  var seed = 11;
  function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  function wob(v, a) { return v + (rnd() - 0.5) * a; }
  g.strokeStyle = '#1f2d3d'; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
  function line(x1, y1, x2, y2) {
    var n = 7; g.beginPath(); g.moveTo(wob(x1, 2.5), wob(y1, 2.5));
    for (var i = 1; i <= n; i++) { var t = i / n; g.lineTo(wob(x1 + (x2 - x1) * t, 3), wob(y1 + (y2 - y1) * t, 3)); }
    g.stroke();
  }
  function box(x, y, w, h, label) {
    line(x, y, x + w, y); line(x + w, y, x + w, y + h); line(x + w, y + h, x, y + h); line(x, y + h, x, y);
    line(x + 2, y + 1, x + w - 3, y + 2);
    g.fillStyle = '#1f2d3d'; g.font = 'italic 24px "Segoe Print", "Comic Sans MS", cursive';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, x + w / 2, y + h / 2 + 1);
  }
  function arrow(x1, y1, x2, y2) { line(x1, y1, x2, y2); line(x2 - 11, y2 - 8, x2, y2); line(x2 - 11, y2 + 8, x2, y2); }
  var xs = [22, 158, 294, 430], labels = ['Idea', 'Draft', 'Review', 'Publish'];
  for (var i = 0; i < 4; i++) {
    box(xs[i], 62, 108, 66, labels[i]);
    if (i < 3) arrow(xs[i] + 112, 95, xs[i + 1] - 4, 95);
  }
  g.font = 'italic 16px "Segoe Print", "Comic Sans MS", cursive'; g.fillStyle = '#5b6b7b'; g.textAlign = 'left';
  g.fillText('publishing flow', 24, 28);
  var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
  window.__gifClip = { file: new File([blob], 'screenshot.png', { type: 'image/png' }), url: c.toDataURL('image/png'), bytes: blob.size };
  return window.__gifClip.bytes;
})()`;

const pasteImage = {
  title: 'Paste a whiteboard screenshot (Ctrl+V): the picture becomes a Mermaid diagram',
  crop: [0, 40, 1120, 400],
  async prepare(env) {
    await newNote(env, PASTE_NOTE, { caret: 'end', zoom: 3 });
    await env.ev('MdMemoBridge.getConfig().ghost_diff_duration_ms = 4000');
    await warmMermaid(env);
    const bytes = await env.ev(SKETCH_JS);
    if (!(bytes > 1000)) throw new Error('the sketch PNG was not made');
    // The application reads the picture (base64) and asks the vision model; the scripted vision model answers with the
    // diagram that matches the sketch. The picture is checked to be really passed on.
    await env.ev(`(function () {
      var block = ${JSON.stringify(PASTE_MERMAID)};
      window.backend.queryVisionAsync = function (reqId, prompt, b64, mime) {
        window.__docshot.calls.push({ fn: 'queryVisionAsync', args: [mime, String(b64 || '').length] });
        setTimeout(function () { window.__onLLMResult(reqId, block, ''); }, 2200);
        return Promise.resolve(null);
      };
    })()`);
    await installClipboardCard(env.page, this.crop);
  },
  async run(env) {
    const { human, pause, page } = env;
    await pause(500);
    await human.press('v', { ctrl: true, alt: true }, 'Ctrl + Alt + V');
    await page.waitFor("!document.getElementById('secondary-pane').classList.contains('hidden')", { label: 'preview pane' });
    await pause(700);
    // The clipboard is invisible in a recording: this card (recording only) shows what it holds.
    await env.ev('window.__gifCard.show()');
    await pause(1500);
    if (human.keycap) await human.keycap('Ctrl + V');
    await pause(70);
    // A real Ctrl+V would paste whatever is on the user's real clipboard, so the paste is the docshots technique: a synthetic
    // paste event that carries the picture in a DataTransfer, through the same handler a real paste reaches.
    const handled = await env.ev(`(function () {
      var ed = __docshot.editor(); ed.focus();
      var dt = new DataTransfer(); dt.items.add(window.__gifClip.file);
      var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    if (!handled) throw new Error('the paste was not taken by the image handler');
    // The application must really have read the picture and handed it to the (scripted) vision model.
    const seen = await env.ev("(function(){var c=__docshot.calls.filter(function(x){return x.fn==='queryVisionAsync';}).pop();return c?c.args:null;})()");
    if (!seen || seen[0] !== 'image/png' || !(seen[1] > 1000)) throw new Error('the vision request did not carry the picture: ' + JSON.stringify(seen));
    await pause(500);
    await env.ev('window.__gifCard.hide()');
    await page.waitFor("__docshot.editor().value.indexOf('flowchart LR') !== -1", { timeout: 10000, label: 'mermaid block' });
    await page.waitFor("!!document.querySelector('#secondary-preview-pane svg')", { timeout: 15000, label: 'diagram in the preview' });
    await pause(1700);
  },
};

// ---- 11. parallel --------------------------------------------------------------------------------------
// Two AI requests are pending while the person keeps typing and then dictates: nothing waits for anything else.
const PAR_NOTE = [
  '# Weekly notes',
  '',
  'Ok so in the sync today we went back and forth about the launch date and nobody was sure.',
  'Ken said the beta invites keep bouncing, Mio wants to push the notes, Aya had no numbers.',
  'Anyway, see you Thursday.',
  '',
  'Dear tester, we hereby request that you confirm receipt of this message promptly.',
  'Failure to respond will forfeit your slot.',
  '',
].join('\n');

const PAR_SUMMARY = 'Launch date still open; beta invites bounce, notes may slip, decision on Thursday.';
const PAR_FRIENDLY = [
  'Hi! Could you let us know you got this message?',
  "If we don't hear back by Friday, your beta spot may go to someone else.",
].join('\n');
const PAR_DICTATED = 'Also remind Ken about the beta group.';

const parallel = {
  title: 'Nothing waits: two AI requests pending, typing and dictation at the same time',
  viewport: [1120, 500],
  crop: [0, 40, 860, 460],
  keycapBottom: 68,
  typing: { minMs: 45, maxMs: 60 },
  async prepare(env) {
    await newNote(env, PAR_NOTE, { caret: 'start' });
    await env.ev('__docshot.setCaret(__docshot.lineStart(3))');
    await env.ev('MdMemoBridge.getConfig().ghost_diff_duration_ms = 4000');
    // The scripted model answers each request late and in its own time (the summary at 6 s, the friendlier text at 4.5 s
    // after its own request), through the same callback the Go side uses. The answer is chosen by the instruction.
    await env.ev(`(function () {
      var summary = ${JSON.stringify(PAR_SUMMARY)};
      var friendly = ${JSON.stringify(PAR_FRIENDLY)};
      window.backend.queryLLMAsync = function (reqId, prompt) {
        var p = String(prompt);
        var isSummary = p.indexOf('Summarize in one line') !== -1;
        window.__docshot.calls.push({ fn: 'queryLLMAsync(' + (isSummary ? 'summary' : 'friendlier') + ')', args: [reqId] });
        setTimeout(function () { window.__onLLMResult(reqId, isSummary ? summary : friendly, ''); }, isSummary ? 6000 : 4500);
        return Promise.resolve(null);
      };
    })()`);
    // The microphone: a silent stream from the Web Audio API stands in for it (no real microphone is ever opened); the
    // recorder, the indicator and the note markers are the application's own. The silence auto-stop is set long.
    await env.ev(`(function () {
      var c = MdMemoBridge.getConfig(); c.voice = c.voice || {}; c.voice.silence_timeout_sec = 120;
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var dest = ac.createMediaStreamDestination();
      navigator.mediaDevices.getUserMedia = function () { try { ac.resume(); } catch (e) { /* stays silent */ } return Promise.resolve(dest.stream); };
      var said = ${JSON.stringify(PAR_DICTATED)};
      window.backend.transcribeAudioAsync = function (reqId, b64, mime) {
        window.__docshot.calls.push({ fn: 'transcribeAudioAsync', args: [reqId, mime, String(b64 || '').length] });
        setTimeout(function () { window.__onVoiceResult(reqId, said, '', '', ''); }, 1400);
        return Promise.resolve(null);
      };
    })()`);
    await installCaption(env.page, this.crop);
  },
  async run(env) {
    const { human, pause, page } = env;
    const barOpen = "!document.getElementById('inline-prompt-bar').classList.contains('hidden')";
    await pause(200);
    // Select paragraph A (three lines).
    await human.press('ArrowDown', { shift: true });
    await pause(150);
    await human.press('ArrowDown', { shift: true });
    await pause(150);
    await human.press('End', { shift: true });
    await pause(300);
    await human.press('l', { ctrl: true }, 'Ctrl + L');
    await page.waitFor(barOpen, { label: 'ask bar (A)' });
    await pause(250);
    await human.type('Summarize in one line');
    await pause(200);
    await human.press('Enter');
    await page.waitFor("__docshot.editor().value.indexOf('[AI Generating: Summarize') !== -1", { label: 'placeholder for A' });

    // Straight on to paragraph B: down to its first line, then select its two lines.
    await pause(150);
    const down = await env.ev(`(function () {
      var ed = __docshot.editor(), v = ed.value;
      var target = v.split('\\n').length - v.slice(v.indexOf('Dear tester')).split('\\n').length;   // 0-based line of B
      var cur = v.slice(0, ed.selectionStart).split('\\n').length - 1;
      return target - cur;
    })()`);
    for (let i = 0; i < down; i++) {
      await human.press('ArrowDown');
      await pause(60);
    }
    await human.press('Home');
    await pause(120);
    await human.press('ArrowDown', { shift: true });
    await pause(120);
    await human.press('End', { shift: true });
    await pause(250);
    await human.press('l', { ctrl: true }, 'Ctrl + L');
    await page.waitFor(barOpen, { label: 'ask bar (B)' });
    await pause(200);
    await human.type('Make it friendlier');
    await pause(200);
    await human.press('Enter');
    await page.waitFor("__docshot.editor().value.indexOf('[AI Generating: Make it friend') !== -1", { label: 'placeholder for B' });
    await env.ev('window.__gifCaption.show("2 AI requests + typing + voice, all at once")');

    // Both answers are pending: keep working. A new line at the end of the note.
    await pause(150);
    await human.press('End', { ctrl: true });
    await pause(100);
    await human.type('Next: send the invites to the testers');
    await pause(100);
    await human.press('Enter');
    await pause(150);
    // Dictate on the new line while the answers are still on their way.
    await human.press('R', { ctrl: true, shift: true }, 'Ctrl + Shift + R');
    await page.waitFor("!!document.querySelector('#stat-recording:not(.hidden)') && __docshot.editor().value.indexOf('Recording...') !== -1", { timeout: 6000, label: 'recording marker and indicator' });
    await pause(2050);
    await human.press('R', { ctrl: true, shift: true }, 'Ctrl + Shift + R');
    await page.waitFor("__docshot.editor().value.indexOf('Also remind Ken about the beta group.') !== -1", { timeout: 10000, label: 'dictated sentence' });
    await page.waitFor("__docshot.editor().value.indexOf('[AI Generating') === -1", { timeout: 10000, label: 'both answers landed' });
    // Every result must be in its own place and no marker may be left behind (the point of this clip): checked, not assumed.
    const text = await env.ev('__docshot.editor().value');
    const at = (needle) => text.indexOf(needle);
    const order = [at('Anyway, see you Thursday.'), at(PAR_SUMMARY), at('Dear tester'), at('Failure to respond'), at('Hi! Could you let us know'), at('Next: send the invites to the testers'), at(PAR_DICTATED)];
    const ordered = order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]));
    const leftovers = /⦅|⦆|\[AI Generating|Recording\.\.\.|Transcribing\.\.\./.test(text);
    console.log('  final note:\n' + text.split('\n').map((l, i) => '    ' + String(i + 1).padStart(2) + ' | ' + l).join('\n'));
    if (!ordered || leftovers) throw new Error('the results are not where they belong: order ' + JSON.stringify(order) + ' leftovers ' + leftovers);
    await pause(150);
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
  'proofread': proofread,
  'mermaid-ai': mermaidAi,
  'paste-image': pasteImage,
  'parallel': parallel,
};
