import assert from 'node:assert/strict';

// Helper functions to be tested (same logic as will be implemented in app.js)
function getLineBoundaries(val, start, end) {
  const lineStart = val.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = val.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = val.length;
  return { lineStart, lineEnd };
}

function computeMoveLineUp(val, start, end) {
  const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
  if (lineStart === 0) return null; // Already at top

  const prevLineStart = val.lastIndexOf('\n', lineStart - 2) + 1;
  const prevLineText = val.substring(prevLineStart, lineStart - 1);
  const targetText = val.substring(lineStart, lineEnd);

  const newBlock = targetText + '\n' + prevLineText;
  const newVal = val.substring(0, prevLineStart) + newBlock + val.substring(lineEnd);
  const shift = prevLineText.length + 1;
  return {
    value: newVal,
    selectionStart: start - shift,
    selectionEnd: end - shift
  };
}

function computeMoveLineDown(val, start, end) {
  const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
  if (lineEnd >= val.length) return null; // Already at bottom

  const nextLineEndIdx = val.indexOf('\n', lineEnd + 1);
  const nextLineEnd = nextLineEndIdx === -1 ? val.length : nextLineEndIdx;
  const nextLineText = val.substring(lineEnd + 1, nextLineEnd);
  const targetText = val.substring(lineStart, lineEnd);

  const newBlock = nextLineText + '\n' + targetText;
  const newVal = val.substring(0, lineStart) + newBlock + val.substring(nextLineEnd);
  const shift = nextLineText.length + 1;
  return {
    value: newVal,
    selectionStart: start + shift,
    selectionEnd: end + shift
  };
}

function computeDuplicateLineDown(val, start, end) {
  const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
  const targetText = val.substring(lineStart, lineEnd);
  const newVal = val.substring(0, lineEnd) + '\n' + targetText + val.substring(lineEnd);
  const shift = targetText.length + 1;
  return {
    value: newVal,
    selectionStart: start + shift,
    selectionEnd: end + shift
  };
}

function computeDuplicateLineUp(val, start, end) {
  const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
  const targetText = val.substring(lineStart, lineEnd);
  const newVal = val.substring(0, lineStart) + targetText + '\n' + val.substring(lineStart);
  const shift = targetText.length + 1;
  return {
    value: newVal,
    selectionStart: start + shift,
    selectionEnd: end + shift
  };
}

function computeDeleteLine(val, start, end) {
  const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
  let deleteStart = lineStart;
  let deleteEnd = lineEnd;

  if (deleteEnd < val.length && val[deleteEnd] === '\n') {
    deleteEnd += 1;
  } else if (deleteStart > 0 && val[deleteStart - 1] === '\n') {
    deleteStart -= 1;
  }

  const newVal = val.substring(0, deleteStart) + val.substring(deleteEnd);
  const newPos = Math.min(lineStart, newVal.length);
  return {
    value: newVal,
    selectionStart: newPos,
    selectionEnd: newPos
  };
}

function computeInsertLineBelow(val, start, end) {
  let lineEnd = val.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = val.length;
  const newVal = val.substring(0, lineEnd) + '\n' + val.substring(lineEnd);
  return {
    value: newVal,
    selectionStart: lineEnd + 1,
    selectionEnd: lineEnd + 1
  };
}

function computeInsertLineAbove(val, start, end) {
  const lineStart = val.lastIndexOf('\n', start - 1) + 1;
  const newVal = val.substring(0, lineStart) + '\n' + val.substring(lineStart);
  return {
    value: newVal,
    selectionStart: lineStart,
    selectionEnd: lineStart
  };
}

console.log("=== Line Operations Evaluation Tests ===");

// 1. Move Line Up & Down
{
  const text = "line1\nline2\nline3";
  // Cursor on line2 (index 8)
  const movedUp = computeMoveLineUp(text, 8, 8);
  assert.equal(movedUp.value, "line2\nline1\nline3");
  assert.equal(movedUp.selectionStart, 2);

  // Move top line up should return null
  assert.equal(computeMoveLineUp("line1\nline2", 2, 2), null);

  // Move down
  const movedDown = computeMoveLineDown(text, 8, 8);
  assert.equal(movedDown.value, "line1\nline3\nline2");
  assert.equal(movedDown.selectionStart, 14);

  // Move bottom line down should return null
  assert.equal(computeMoveLineDown(text, 14, 14), null);
  console.log("PASS: Test 1 (Move line up/down)");
}

// 2. Multi-line Selection Move
{
  const text = "line1\nline2\nline3\nline4";
  // Select line2 to line3
  const start = 6; // 'l' in line2
  const end = 17; // '3' in line3
  const movedDown = computeMoveLineDown(text, start, end);
  assert.equal(movedDown.value, "line1\nline4\nline2\nline3");
  console.log("PASS: Test 2 (Multi-line selection move)");
}

// 3. Duplicate Line
{
  const text = "alpha\nbeta\ngamma";
  const dupDown = computeDuplicateLineDown(text, 7, 7); // on 'beta'
  assert.equal(dupDown.value, "alpha\nbeta\nbeta\ngamma");

  const dupUp = computeDuplicateLineUp(text, 7, 7);
  assert.equal(dupUp.value, "alpha\nbeta\nbeta\ngamma");
  console.log("PASS: Test 3 (Duplicate line up/down)");
}

// 4. Delete Line
{
  const text = "one\ntwo\nthree";
  const delMid = computeDeleteLine(text, 5, 5); // on 'two'
  assert.equal(delMid.value, "one\nthree");

  const delTop = computeDeleteLine("one\ntwo", 1, 1);
  assert.equal(delTop.value, "two");

  const delBottom = computeDeleteLine("one\ntwo", 5, 5);
  assert.equal(delBottom.value, "one");
  console.log("PASS: Test 4 (Delete line)");
}

// 5. Insert Line Above & Below
{
  const text = "hello\nworld";
  const insBelow = computeInsertLineBelow(text, 2, 2);
  assert.equal(insBelow.value, "hello\n\nworld");
  assert.equal(insBelow.selectionStart, 6);

  const insAbove = computeInsertLineAbove(text, 8, 8); // on 'world'
  assert.equal(insAbove.value, "hello\n\nworld");
  assert.equal(insAbove.selectionStart, 6);
  console.log("PASS: Test 5 (Insert line above/below)");
}

console.log("All 5 Line Operations evaluation tests passed successfully!");
