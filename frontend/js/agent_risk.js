// Agents that act without asking. Three things built on one reading of an agent definition ({ command, args,
// append_instruction } from agents.yaml):
//   - whether it is risky: a flag that skips the CLI's own permission prompts, or a shell that would run an appended
//     instruction as code (assess)
//   - the confirmation before such an agent runs, asked once per agent and exact command line (confirmRun); the answer
//     is kept in config.json under agentAck, never in a settings package
//   - the notice about agent definitions worth a look, which the Go side lists as agent_issues: copies of a retired
//     built-in definition, and shells that run the instruction (startupNotice, renderIssues)
// Pure functions, plus two small flows that get their host (dialog, config, clipboard) as an argument: loading this file
// only defines them, and it runs under Node for its tests.
(function (global) {
  'use strict';

  // Flags known to make an agent CLI skip its permission prompts, compared as a whole argument ("--yolo") or with a value
  // ("--yolo=true"), ignoring case. A disclosure aid, not a sandbox: a flag missing here is not caught.
  const AUTO_APPROVE_FLAGS = Object.freeze([
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--full-auto',
    '--auto-approve'
  ]);

  // Shells that join the arguments after their command switch into one command line, and those switches: an instruction
  // appended there is executed as code. Keep in step with shellCommands / shellCommandSwitches in pkg/slotagent/safety.go.
  const SHELL_COMMANDS = Object.freeze(['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh']);
  const SHELL_COMMAND_SWITCHES = Object.freeze(['-command', '/c', '-c']);

  const ACK_VERSION = 'v1:';

  function argsOf(def) {
    return def && Array.isArray(def.args) ? def.args.map((a) => String(a)) : [];
  }

  // The program name: no folder, lower case, no ".exe".
  function commandBase(command) {
    const c = String(command || '').trim();
    const cut = Math.max(c.lastIndexOf('/'), c.lastIndexOf('\\'));
    return c.slice(cut + 1).toLowerCase().replace(/\.exe$/, '');
  }

  // A run adds the instruction as the last argument: no argument holds {instruction}, and append_instruction is not false.
  function appendsInstruction(def) {
    if (!def || def.append_instruction === false) return false;
    return !argsOf(def).some((a) => a.indexOf('{instruction}') !== -1);
  }

  // What makes def run an appended instruction as code (the shell, or its command switch as written), or ''.
  function shellHazard(def) {
    if (!appendsInstruction(def)) return '';
    const base = commandBase(def.command);
    if (SHELL_COMMANDS.indexOf(base) !== -1) return base;
    const hit = argsOf(def).find((a) => SHELL_COMMAND_SWITCHES.indexOf(a.trim().toLowerCase()) !== -1);
    return hit ? hit.trim() : '';
  }

  // The permission-skipping flags among def's arguments, as written.
  function riskFlags(def) {
    return argsOf(def).filter((a) => {
      const flag = a.trim().toLowerCase().split('=')[0];
      return AUTO_APPROVE_FLAGS.indexOf(flag) !== -1;
    });
  }

  function assess(def) {
    const flags = riskFlags(def);
    const shell = shellHazard(def);
    return { risky: flags.length > 0 || shell !== '', flags: flags, shell: shell };
  }

  // A 53-bit string hash (cyrb53). The acknowledgement is a disclosure record, not a security boundary: whoever can edit
  // agents.yaml can change what runs anyway.
  function hash53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  // What an acknowledgement stands for: the command, every argument, and whether the instruction is appended.
  function signature(def) {
    const d = def || {};
    return ACK_VERSION + hash53(JSON.stringify([String(d.command || '').trim(), argsOf(d), d.append_instruction === false]));
  }

  function isAcknowledged(acks, key, def) {
    return !!(acks && typeof acks === 'object' && Object.prototype.hasOwnProperty.call(acks, key) && acks[key] === signature(def));
  }

  // A new acks object with key acknowledged for def's exact command line (acks itself is not changed).
  function acknowledge(acks, key, def) {
    const next = {};
    if (acks && typeof acks === 'object') Object.keys(acks).forEach((k) => { if (k !== '__proto__') next[k] = acks[k]; });
    next[key] = signature(def);
    return next;
  }

  function quoteArg(a) {
    return a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a;
  }

  // The command line as shown to the user, cut at 400 characters.
  function commandLine(def) {
    const text = [String((def && def.command) || '').trim()].concat(argsOf(def)).map(quoteArg).join(' ');
    return text.length > 400 ? text.slice(0, 399) + '…' : text;
  }

  // Fills {name} placeholders that params has (others, such as a literal {instruction}, stay); never interprets "$".
  function format(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (m, name) => (params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
  }

  // tr(key) -> the UI string for key (the app's t()).
  function confirmText(tr, key, def, verdict) {
    const v = verdict || assess(def);
    const lines = [format(tr('agentRiskIntro'), { agent: key })];
    v.flags.forEach((flag) => lines.push(format(tr('agentRiskFlag'), { flag: flag })));
    if (v.shell) lines.push(format(tr('agentRiskShell'), { shell: v.shell }));
    return lines.join('\n') + '\n\n' + format(tr('agentRiskCommand'), { command: commandLine(def) }) + '\n\n' + tr('agentRiskOutro');
  }

  // Before a run: true when def may run (not risky, or acknowledged before, or the user says Run now); false when the
  // user declines. host: { getAcks() -> object, setAcks(acks) (keeps and saves them), ask(text) -> Promise<boolean>,
  // t(key) -> string }.
  async function confirmRun(host, key, def) {
    const verdict = assess(def);
    if (!verdict.risky) return true;
    if (isAcknowledged(host.getAcks(), key, def)) return true;
    const ok = await host.ask(confirmText(host.t, key, def, verdict));
    if (!ok) return false;
    host.setAcks(acknowledge(host.getAcks(), key, def));
    return true;
  }

  // ---- the notice about agent definitions -------------------------------------------------------------------------
  // issues: the Go side's agent_issues, [{ agent, kind: 'outdated-default' | 'shell-append' | 'default-disabled', detail, suggested? }].
  // state: config.agentNotice, { shown: <signature the status-bar message was shown for>, dismissed: <signature hidden
  // in Settings> }. A different set of issues has a different signature, so it is told again.

  function validIssues(issues) {
    return (Array.isArray(issues) ? issues : []).filter((i) => i && typeof i.agent === 'string' && typeof i.kind === 'string');
  }

  function issuesSignature(issues) {
    const list = validIssues(issues).map((i) => [i.agent, i.kind, String(i.detail || '')].join('|')).sort();
    return list.length ? ACK_VERSION + hash53(list.join('\n')) : '';
  }

  // At start-up: { state, count } when the status-bar message is due (then keep state), else null.
  function startupNotice(state, issues) {
    const sig = issuesSignature(issues);
    if (!sig || (state && state.shown === sig)) return null;
    const agents = new Set(validIssues(issues).map((i) => i.agent));
    return { state: Object.assign({}, state && typeof state === 'object' ? state : {}, { shown: sig }), count: agents.size };
  }

  function showInSettings(state, issues) {
    const sig = issuesSignature(issues);
    return !!sig && !(state && state.dismissed === sig);
  }

  function dismissed(state, issues) {
    return Object.assign({}, state && typeof state === 'object' ? state : {}, { dismissed: issuesSignature(issues) });
  }

  const REASON_KEYS = { 'claude-code': 'agentIssueReasonClaude', codex: 'agentIssueReasonCodex', agy: 'agentIssueReasonAgy' };

  function issueText(tr, issue) {
    if (issue.kind === 'shell-append') return format(tr('agentIssueShell'), { agent: issue.agent, shell: issue.detail || '' });
    // default_agent names a disabled agent: detail is the agent that is the default instead ('' when every agent is disabled)
    if (issue.kind === 'default-disabled') return format(tr(issue.detail ? 'agentIssueDefaultDisabled' : 'agentIssueDefaultDisabledNone'), { agent: issue.agent, fallback: issue.detail || '' });
    const reason = REASON_KEYS[issue.detail] ? tr(REASON_KEYS[issue.detail]) : '';
    return format(tr('agentIssueOutdated'), { agent: issue.agent, builtin: issue.detail || '', reason: reason }).trim();
  }

  function yamlKey(key) {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  }

  // The agents.yaml entry that replaces an outdated one: today's command and args under the user's key, with the user's
  // description and aliases kept (JSON strings are valid YAML double-quoted scalars).
  function suggestedYaml(key, suggested, current) {
    const s = suggested || {};
    const cur = current || {};
    const lines = ['  ' + yamlKey(key) + ':', '    command: ' + JSON.stringify(String(s.command || ''))];
    lines.push('    args:');
    argsOf(s).forEach((a) => lines.push('      - ' + JSON.stringify(a)));
    const description = String(cur.description || s.description || '');
    if (description) lines.push('    description: ' + JSON.stringify(description));
    if (Array.isArray(cur.aliases) && cur.aliases.length) lines.push('    aliases: [' + cur.aliases.map((a) => JSON.stringify(String(a))).join(', ') + ']');
    return lines.join('\n') + '\n';
  }

  // Fills container (Settings > Agent) with the issues, or hides it. host: { t(key), doc, agents (the loaded
  // definitions, for descriptions and aliases), state, copy(text) -> Promise<boolean>, showMessage(text, ms),
  // onDismiss() }. Built with textContent only: agents.yaml text never becomes markup.
  function renderIssues(container, issues, host) {
    if (!container) return;
    const list = validIssues(issues);
    container.textContent = '';
    const show = list.length > 0 && showInSettings(host.state, list);
    container.classList.toggle('hidden', !show);
    if (!show) return;
    const doc = host.doc || global.document;
    const make = (tag, text, style) => {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (style) Object.assign(el.style, style);
      return el;
    };
    container.appendChild(make('strong', host.t('agentIssuesTitle'), { display: 'block', fontSize: '12px', marginBottom: '4px' }));
    const ul = make('ul', undefined, { margin: '0 0 6px', paddingLeft: '18px', fontSize: '12px' });
    list.forEach((issue) => {
      const li = make('li', undefined, { marginBottom: '4px' });
      li.appendChild(make('span', issueText(host.t, issue)));
      if (issue.kind === 'outdated-default' && issue.suggested) {
        const btn = make('button', host.t('agentIssueCopy'), { marginLeft: '6px', padding: '1px 8px', fontSize: '11px' });
        btn.type = 'button';
        btn.className = 'btn-secondary';
        btn.onclick = () => {
          const current = host.agents && host.agents[issue.agent];
          Promise.resolve(host.copy(suggestedYaml(issue.agent, issue.suggested, current))).then((ok) => {
            host.showMessage(host.t(ok ? 'agentIssueCopied' : 'agentIssueCopyFailed'), 5000);
          });
        };
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
    container.appendChild(ul);
    container.appendChild(make('small', host.t('agentIssuesHelp'), { display: 'block' }));
    const hide = make('button', host.t('agentIssuesDismiss'), { marginTop: '4px', padding: '1px 8px', fontSize: '11px' });
    hide.type = 'button';
    hide.className = 'btn-secondary';
    hide.onclick = () => {
      container.classList.add('hidden');
      if (typeof host.onDismiss === 'function') host.onDismiss(dismissed(host.state, list));
    };
    container.appendChild(hide);
  }

  const api = {
    AUTO_APPROVE_FLAGS,
    SHELL_COMMANDS,
    SHELL_COMMAND_SWITCHES,
    commandBase,
    appendsInstruction,
    shellHazard,
    riskFlags,
    assess,
    signature,
    isAcknowledged,
    acknowledge,
    commandLine,
    confirmText,
    confirmRun,
    issuesSignature,
    startupNotice,
    showInSettings,
    dismissed,
    issueText,
    suggestedYaml,
    renderIssues
  };

  global.AgentRisk = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
