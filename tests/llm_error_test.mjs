// Sorting the raw failure of an AI request into a few kinds (frontend/js/llm_error.js).
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== LLM error tests ===');
const require = createRequire(import.meta.url);
const E = require('../frontend/js/llm_error.js');

// 1. kinds, from the lines the Go client really produces
{
  const cases = [
    ['ローカルLLM/API接続エラー (http://localhost:11434): Post "http://localhost:11434/v1/chat/completions": dial tcp 127.0.0.1:11434: connectex: No connection could be made because the target machine actively refused it.', 'conn', null],
    ['Ollama接続エラー (http://localhost:11434): Post "http://localhost:11434/api/chat": EOF', 'conn', null],
    ['Gemini接続エラー: Post "https://generativelanguage.googleapis.com/...": dial tcp: lookup generativelanguage.googleapis.com: no such host', 'conn', null],
    ['APIエラー (401): {"error":{"message":"Incorrect API key provided: sk-***"}}', 'auth', 401],
    ['Gemini APIエラー (403): {"error":{"status":"PERMISSION_DENIED"}}', 'auth', 403],
    ['Gemini APIエラー (400): API key not valid. Please pass a valid API key.', 'auth', 400],
    ['Ollama APIエラー (404): {"error":"model \'qwen2.5:latest\' not found, try pulling it first"}', 'model', 404],
    ['APIエラー (429): {"error":{"message":"You exceeded your current quota"}}', 'rate', 429],
    ['Gemini APIエラー (503): {"error":{"code":503,"message":"The model is overloaded."}}', 'server', 503],
    ['推敲が5秒以内に終わりませんでした', 'timeout', null],
    ['No response from the model (timed out)', 'timeout', null],
    ['モデルから応答がありませんでした (タイムアウト)', 'timeout', null],
    ['something else entirely', 'other', null],
    ['', 'other', null],
    [null, 'other', null]
  ];
  for (const [text, kind, status] of cases) {
    const got = E.classify(text);
    assert.strictEqual(got.kind, kind, 'kind of: ' + String(text).slice(0, 60));
    assert.strictEqual(got.status, status, 'status of: ' + String(text).slice(0, 60));
  }
  console.log('PASS: classify sorts ' + cases.length + ' real-looking failures into conn / auth / model / rate / server / timeout / other.');
}

// 2. the server the message names, and whether it is local
{
  assert.strictEqual(E.hostOf('http://localhost:11434'), 'localhost:11434');
  assert.strictEqual(E.hostOf('https://api.openai.com/v1'), 'api.openai.com');
  assert.strictEqual(E.hostOf('  http://192.168.1.20:1234/v1/chat  '), '192.168.1.20:1234');
  assert.strictEqual(E.hostOf(''), '');
  assert.strictEqual(E.hostOf(undefined), '');
  for (const local of ['http://localhost:11434', 'http://127.0.0.1:8080', 'http://192.168.0.5:1234', 'http://10.1.2.3', 'http://172.20.0.9', 'http://mybox.local:11434', '']) {
    assert.strictEqual(E.isLocal(local), true, local + ' is local');
  }
  for (const remote of ['https://api.openai.com/v1', 'https://generativelanguage.googleapis.com', 'https://openrouter.ai/api', 'http://172.32.0.1', 'http://example.com:11434']) {
    assert.strictEqual(E.isLocal(remote), false, remote + ' is not local');
  }
  console.log('PASS: hostOf and isLocal.');
}

// 3. one line, bounded
{
  assert.strictEqual(E.oneLine('a\n  b\t c'), 'a b c');
  assert.strictEqual(E.oneLine('x'.repeat(400), 300).length, 301);
  assert.strictEqual(E.oneLine(null), '');
  console.log('PASS: oneLine collapses white space and bounds the length.');
}

console.log('\nAll LLM error tests PASSED!');
