// One command to run every frontend JS test (frontend/js/*_test.js + tests/*.mjs)
// in a single pass. Usage: node tools/run_js_tests.mjs  (run from the repo root).
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function listTestFiles(dir, suffixCheck) {
  let entries;
  try {
    entries = readdirSync(path.join(repoRoot, dir));
  } catch (e) {
    return [];
  }
  return entries
    .filter((name) => suffixCheck(name))
    .sort()
    .map((name) => path.join(dir, name));
}

const testFiles = [
  ...listTestFiles('frontend/js', (name) => name.endsWith('_test.js')),
  ...listTestFiles('tests', (name) => name.endsWith('.mjs')),
];

if (testFiles.length === 0) {
  console.error('No test files found under frontend/js/*_test.js or tests/*.mjs');
  process.exit(1);
}

console.log(`Running ${testFiles.length} JS test file(s)...\n`);

const results = [];

for (const relPath of testFiles) {
  const absPath = path.join(repoRoot, relPath);
  const res = spawnSync(process.execPath, [absPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  const passed = res.status === 0;
  results.push({ relPath, passed });

  if (passed) {
    console.log(`PASS  ${relPath}`);
  } else {
    console.log(`FAIL  ${relPath}`);
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const tail = output.split('\n').filter(Boolean).slice(-20).join('\n');
    if (tail) {
      console.log('      --- last output lines ---');
      tail.split('\n').forEach((line) => console.log(`      ${line}`));
      console.log('      -------------------------');
    }
  }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} test file(s) passed.`);

if (failed.length > 0) {
  console.log(`Failed: ${failed.map((r) => r.relPath).join(', ')}`);
  process.exit(1);
}

process.exit(0);
