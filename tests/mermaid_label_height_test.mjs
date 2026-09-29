// Mermaid nodes with several lines of label text lost their last line in the preview.
//
// Mermaid sizes each node to its label while the diagram is drawn in a temporary element outside the
// preview, where the line height is the browser's `normal` (24px per 16px line for the fonts in use;
// a node with N label lines is N*24px high). The finished <svg> is then put inside <pre class="mermaid-card">
// in .markdown-body, whose labels inherited the note text's `line-height: 1.7` (27.2px per line): a label of
// N lines was 3.2*N px taller than its box, so the last line was cut off, more so the more lines it had.
//
// The fix is one CSS rule on the card: the same `normal` at display time as at measuring time. This test keeps
// that rule from being removed or overridden by a fixed line height. (The pixel check itself needs a real
// browser: it was measured there, all nodes' label height == box height.)
import fs from 'fs';
import assert from 'assert';

console.log('=== Mermaid label height (line-height) tests ===');

// Comments removed: the rule's own explanation mentions "line-height: 1.7", which is not a declaration.
const css = fs.readFileSync('frontend/css/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

// 1. The card rule sets line-height: normal.
{
  const m = css.match(/\.markdown-body pre\.mermaid-card \{([^}]*)\}/);
  assert(m, 'the .markdown-body pre.mermaid-card rule must exist');
  assert(/(^|[\s;])line-height:\s*normal\s*;/.test(m[1]), 'the card must set line-height: normal (the value Mermaid measured its nodes with)');
  console.log('PASS: the mermaid card uses line-height: normal, as Mermaid measured.');
}

// 2. Nothing later gives the diagram's own elements a fixed line height again.
{
  const rules = [...css.matchAll(/([^{}]*\bmermaid[^{}]*|[^{}]*\bforeignObject[^{}]*)\{([^}]*)\}/g)];
  const offenders = rules
    .filter(([, sel, body]) => /line-height:(?!\s*(?:normal|inherit)\b)[^;]+;/.test(body) && !/\.mermaid-tone-btn/.test(sel))
    .map(([, sel]) => sel.trim());
  assert.deepStrictEqual(offenders, [], 'a fixed line-height on mermaid/foreignObject elements would bring the cut-off labels back: ' + offenders.join(' | '));
  console.log('PASS: no other rule fixes a line height on the diagram.');
}

console.log('\nAll mermaid label height tests PASSED!');
