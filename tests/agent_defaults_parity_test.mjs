// Guards against the three-way drift the settings audit found between:
//   - pkg/slotagent/config.go   DefaultSlotConfig()   (Go, source of truth)
//   - frontend/js/slot_agent.js the in-memory `slotConfig` default object
//   - pkg/slotagent/loader.go   the agents.yaml template's agents block
// This test parses the Go literal out of config.go's source text (no Go
// toolchain needed) and asserts the JS defaults match it field by field, so
// the two can no longer silently drift apart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const goSrc = fs.readFileSync(path.resolve('pkg/slotagent/config.go'), 'utf-8').replace(/\r\n/g, '\n');
const jsSrc = fs.readFileSync(path.resolve('frontend/js/slot_agent.js'), 'utf-8').replace(/\r\n/g, '\n');

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

// --- Minimal Go-literal parsing helpers (tailored to this one file's shape) ---

// Returns every top-level `{ ... }` group found inside `text`, matching
// braces by depth (ignores any `[`/`]` it walks over). Works for both keyed
// entries (`"key": { ... }`) and bare struct-literal entries (`{ ... }`).
function findTopLevelGroups(text) {
  const groups = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        groups.push({ start, text: text.substring(start, i + 1) });
      }
    }
  }
  return groups;
}

// Extracts a balanced `open ... close` block (delimiters included) starting
// at the first `open` char found after `marker` in `text`.
function extractDelimitedBlockAfter(text, marker, open, close) {
  const markerIdx = text.indexOf(marker);
  assert.ok(markerIdx !== -1, `marker not found: ${marker}`);
  const openIdx = text.indexOf(open, markerIdx);
  assert.ok(openIdx !== -1, `no opening "${open}" after marker: ${marker}`);
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.substring(openIdx, i + 1);
    }
  }
  throw new Error(`unbalanced "${open}"/"${close}" after marker: ${marker}`);
}

// Go's `Field: []Type{ {...}, {...} }` uses `{` as both the slice literal's
// own delimiter and each element's — the outer `{` immediately follows the
// marker, so a brace-matching group extraction works directly.
function extractBlockAfter(text, marker) {
  return extractDelimitedBlockAfter(text, marker, '{', '}');
}

// JS's `field: [ {...}, {...} ]` uses `[`/`]` for the array itself, with
// each element still being its own `{...}` — bracket-matched, not brace-matched.
function extractArrayBlockAfter(text, marker) {
  return extractDelimitedBlockAfter(text, marker, '[', ']');
}

// All double-quoted string literals in `text`, in source order, unescaped
// via JSON.parse (Go's and JSON's escaping rules coincide for the plain
// \n / \\ / \" this file uses).
function extractAllStrings(text) {
  const matches = text.match(/"(?:[^"\\]|\\.)*"/g) || [];
  return matches.map((m) => JSON.parse(m));
}

// One `{ ... }` agent entry -> { command, args, description, aliases }, read field by field
// (the first-string/last-string scheme this replaced broke as soon as a field was appended).
// `lang` picks the Go (`Command: "..."`, `Args: []string{...}`) or JS (`command: "..."`,
// `args: [...]`) spelling; gofmt pads Go keys with spaces, hence the \s*.
function parseAgentEntry(text, lang) {
  const go = lang === 'go';
  const open = go ? '{' : '[';
  const close = go ? '}' : ']';
  const readString = (field) => {
    const m = text.match(new RegExp(`\\b${field}:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    assert.ok(m, `${lang} agent entry has no ${field} field: ${text.slice(0, 50)}...`);
    return JSON.parse(m[1]);
  };
  const readList = (fieldRe) => {
    const m = fieldRe.exec(text);
    if (!m) return [];
    const openIdx = m.index + m[0].length - 1;
    assert.equal(text[openIdx], open);
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return extractAllStrings(text.substring(openIdx, i + 1));
    }
    throw new Error(`unbalanced list in ${lang} agent entry: ${text.slice(0, 50)}...`);
  };
  return {
    command: readString(go ? 'Command' : 'command'),
    args: readList(go ? /\bArgs:\s*\[\]string\{/ : /\bargs:\s*\[/),
    description: readString(go ? 'Description' : 'description'),
    aliases: readList(go ? /\bAliases:\s*\[\]string\{/ : /\baliases:\s*\[/)
  };
}

function parseGoAgents(goSrc) {
  const block = extractBlockAfter(goSrc, 'Agents: map[string]AgentDef{');
  const inner = block.substring(1, block.length - 1);
  const groups = findTopLevelGroups(inner);
  const agents = {};
  for (const g of groups) {
    const before = inner.substring(0, g.start);
    const keyMatch = before.match(/"([a-zA-Z0-9_-]+)":\s*$/);
    assert.ok(keyMatch, `could not find key for Go agent entry: ${g.text.slice(0, 40)}...`);
    agents[keyMatch[1]] = parseAgentEntry(g.text, 'go');
  }
  return agents;
}

function parseGoSlotProfiles(goSrc) {
  const block = extractBlockAfter(goSrc, 'SlotProfiles: []SlotProfile{');
  const inner = block.substring(1, block.length - 1);
  return findTopLevelGroups(inner).map((g) => {
    const [triggerOpen, triggerClose, name, agent, systemInstruction] = extractAllStrings(g.text);
    return { trigger_open: triggerOpen, trigger_close: triggerClose, name, agent, system_instruction: systemInstruction };
  });
}

function parseGoRecipes(goSrc) {
  const block = extractBlockAfter(goSrc, 'Recipes: []Recipe{');
  const inner = block.substring(1, block.length - 1);
  return findTopLevelGroups(inner).map((g) => {
    const stepsBlock = extractBlockAfter(g.text, 'Steps: []string{');
    const steps = extractAllStrings(stepsBlock);
    // Everything before "Steps:" carries TriggerOpen/TriggerClose/Name/Description in order.
    const headText = g.text.substring(0, g.text.indexOf('Steps: []string{'));
    const [triggerOpen, triggerClose, name, description] = extractAllStrings(headText);
    const requiresApprovalMatch = g.text.match(/RequiresApprovalStep:\s*(\d+)/);
    const selfRefineMatch = g.text.match(/SelfRefine:\s*(true|false)/);
    return {
      trigger_open: triggerOpen,
      trigger_close: triggerClose,
      name,
      description,
      steps,
      requires_approval_step: requiresApprovalMatch ? parseInt(requiresApprovalMatch[1], 10) : null,
      self_refine: selfRefineMatch ? selfRefineMatch[1] === 'true' : null
    };
  });
}

const goDefaultAgents = parseGoAgents(goSrc);
const goDefaultProfiles = parseGoSlotProfiles(goSrc);
const goDefaultRecipes = parseGoRecipes(goSrc);

// frontend/js/slot_agent.js keeps its default as a plain top-level `let
// slotConfig = { ... }` object literal — parse it exactly like the Go one
// (same helpers), since re-implementing a JS parser here would be overkill.
function parseJsAgents(jsSrc) {
  const block = extractBlockAfter(jsSrc, 'agents: {');
  const inner = block.substring(1, block.length - 1);
  const groups = findTopLevelGroups(inner);
  const agents = {};
  for (const g of groups) {
    const before = inner.substring(0, g.start);
    const keyMatch = before.match(/"([a-zA-Z0-9_-]+)":\s*$/);
    assert.ok(keyMatch, `could not find key for JS agent entry: ${g.text.slice(0, 40)}...`);
    agents[keyMatch[1]] = parseAgentEntry(g.text, 'js');
  }
  return agents;
}

function parseJsSlotProfiles(jsSrc) {
  const block = extractArrayBlockAfter(jsSrc, 'slot_profiles: [');
  const inner = block.substring(1, block.length - 1);
  return findTopLevelGroups(inner).map((g) => {
    const [triggerOpen, triggerClose, name, agent, systemInstruction] = extractAllStrings(g.text);
    return { trigger_open: triggerOpen, trigger_close: triggerClose, name, agent, system_instruction: systemInstruction };
  });
}

function parseJsRecipes(jsSrc) {
  const block = extractArrayBlockAfter(jsSrc, 'recipes: [');
  const inner = block.substring(1, block.length - 1);
  return findTopLevelGroups(inner).map((g) => {
    const stepsBlock = extractArrayBlockAfter(g.text, 'steps: [');
    const steps = extractAllStrings(stepsBlock);
    const headText = g.text.substring(0, g.text.indexOf('steps: ['));
    const [triggerOpen, triggerClose, name, description] = extractAllStrings(headText);
    const requiresApprovalMatch = g.text.match(/requires_approval_step:\s*(\d+)/);
    const selfRefineMatch = g.text.match(/self_refine:\s*(true|false)/);
    return {
      trigger_open: triggerOpen,
      trigger_close: triggerClose,
      name,
      description,
      steps,
      requires_approval_step: requiresApprovalMatch ? parseInt(requiresApprovalMatch[1], 10) : null,
      self_refine: selfRefineMatch ? selfRefineMatch[1] === 'true' : null
    };
  });
}

const jsDefaultAgents = parseJsAgents(jsSrc);
const jsDefaultProfiles = parseJsSlotProfiles(jsSrc);
const jsDefaultRecipes = parseJsRecipes(jsSrc);

check('Go and JS agents default to the same set of keys', () => {
  assert.deepEqual(Object.keys(goDefaultAgents).sort(), Object.keys(jsDefaultAgents).sort());
});

for (const key of Object.keys(goDefaultAgents)) {
  check(`agent "${key}" command/args/description/aliases match between Go and JS`, () => {
    assert.deepEqual(jsDefaultAgents[key], goDefaultAgents[key]);
  });
}

check('default agents parse completely (no field dropped or shifted)', () => {
  const claude = goDefaultAgents['claude-code'];
  assert.equal(claude.command, 'claude');
  assert.deepEqual(claude.args, ['-p', '対象ノート: {file}\n指示: {instruction}'], 'print mode, the note path and the instruction in one prompt');
  assert.match(claude.description, /^Claude Code/);
  assert.deepEqual(goDefaultAgents['codex'].args, ['exec', '{instruction}']);
  const agy = goDefaultAgents['agy'];
  assert.deepEqual(agy.args, ['-p', '対象ノート: {file}\n指示: {instruction}']);
  assert.match(agy.description, /^Google Antigravity/);
});

// The agents.yaml template ("Open agents.yaml", pkg/slotagent/loader.go) is the third copy of the defaults. Its agents
// block has a fixed shape: key, command, args (one "- " line each), description, and the aliases as a comment.
function parseTemplateAgents(src) {
  const start = src.indexOf('\nagents:\n');
  assert.ok(start !== -1, 'the template has an agents: block');
  const agents = {};
  let cur = null;
  let inArgs = false;
  const quoted = '("(?:[^"\\\\]|\\\\.)*")';
  for (const line of src.slice(start + '\nagents:\n'.length).split('\n')) {
    if (/^\S/.test(line)) break; // the next top-level key or section comment
    let m;
    if ((m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line))) {
      cur = agents[m[1]] = { command: null, args: [], description: null, aliases: [] };
      inArgs = false;
    } else if (!cur || !line.trim()) {
      continue;
    } else if ((m = new RegExp('^ {4}command:\\s*' + quoted + '\\s*$').exec(line))) {
      cur.command = JSON.parse(m[1]);
      inArgs = false;
    } else if (/^ {4}args:\s*$/.test(line)) {
      inArgs = true;
    } else if (inArgs && (m = new RegExp('^ {6}- ' + quoted + '\\s*$').exec(line))) {
      cur.args.push(JSON.parse(m[1]));
    } else if ((m = new RegExp('^ {4}description:\\s*' + quoted + '\\s*$').exec(line))) {
      cur.description = JSON.parse(m[1]);
      inArgs = false;
    } else if ((m = /^ {4}# aliases: (\[[^\]]*\])/.exec(line))) {
      cur.aliases = JSON.parse(m[1]);
    } else {
      throw new Error('unexpected line in the template agents block: ' + JSON.stringify(line));
    }
  }
  return agents;
}

const loaderSrc = fs.readFileSync(path.resolve('pkg/slotagent/loader.go'), 'utf-8').replace(/\r\n/g, '\n');
const templateAgents = parseTemplateAgents(loaderSrc);

check('the agents.yaml template defines the same agents as the Go default (command, args, description, alias hint)', () => {
  assert.deepEqual(Object.keys(templateAgents).sort(), Object.keys(goDefaultAgents).sort());
  for (const key of Object.keys(goDefaultAgents)) assert.deepEqual(templateAgents[key], goDefaultAgents[key], key);
});

check('no built-in agent, in any of the three copies, skips permission prompts or runs its instruction through a shell', () => {
  const AgentRisk = createRequire(import.meta.url)('../frontend/js/agent_risk.js');
  for (const [where, agents] of [['Go', goDefaultAgents], ['JS', jsDefaultAgents], ['template', templateAgents]]) {
    for (const [key, def] of Object.entries(agents)) {
      assert.deepEqual(AgentRisk.assess(def), { risky: false, flags: [], shell: '' }, `${where} ${key}`);
    }
  }
});

check('default @mention aliases: claude-code -> claude, cc; agy -> antigravity, gemini; others none', () => {
  for (const agents of [goDefaultAgents, jsDefaultAgents]) {
    assert.deepEqual(agents['claude-code'].aliases, ['claude', 'cc']);
    assert.deepEqual(agents['agy'].aliases, ['antigravity', 'gemini']);
    assert.deepEqual(agents['hermes'].aliases, []);
    assert.deepEqual(agents['codex'].aliases, []);
  }
});

check('Go wire names: AgentDef.aliases, SlotConfig.snippets and the SnippetDef fields', () => {
  assert.match(goSrc, /Aliases\s+\[\]string\s+`json:"aliases,omitempty" yaml:"aliases,omitempty"`/);
  assert.match(goSrc, /Snippets\s+\[\]SnippetDef\s+`json:"snippets" yaml:"snippets,omitempty"`/);
  const block = extractBlockAfter(goSrc, 'type SnippetDef struct');
  const tags = [...block.matchAll(/`json:"([a-z]+)(?:,omitempty)?"/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['id', 'label', 'kind', 'trigger', 'body', 'os', 'agent']);
});

check('Go OutputMode constants stay "replace" / "below"', () => {
  const mentionSrc = fs.readFileSync(path.resolve('pkg/slotagent/mention.go'), 'utf-8');
  assert.match(mentionSrc, /OutputModeReplace\s*=\s*"replace"/);
  assert.match(mentionSrc, /OutputModeBelow\s*=\s*"below"/);
});

check('slot_profiles match between Go and JS (trigger/agent/instruction)', () => {
  assert.deepEqual(jsDefaultProfiles, goDefaultProfiles);
});

check('recipes match between Go and JS (trigger/steps/approval/self-refine)', () => {
  assert.deepEqual(jsDefaultRecipes, goDefaultRecipes);
});

if (failures > 0) {
  console.error(`\n${failures} agent-defaults parity test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll agent-defaults parity tests passed with 0 error(s)!');
