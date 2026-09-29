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

// 2b. B18: "local" is decided on the real host, never on how the text starts, and credentials never leave hostOf
{
  // names that only START like a private address are public hosts; so is anything that hides an address in the user part
  for (const remote of [
    'https://10.evil.example/v1', 'https://127.evil.com', 'https://192.168.evil.io/v1', 'https://172.16.evil.net', 'https://172.31.evil.net',
    'https://10.0.0.1@evil.example/v1', 'https://127.0.0.1:80@evil.example', 'https://localhost@evil.example/v1', 'https://localhost:11434@evil.example',
    'https://10.0.0.1.evil.example', 'https://10.0.0.256', 'https://300.1.1.1', 'https://192.168.1.1.nip.io', 'https://notlocalhost', 'https://evil-localhost',
    'https://localhost.evil.example', 'https://ollama.local.evil.example', 'https://[2001:db8::1]:8080', 'https://[::2]', 'http://172.15.0.1', 'http://192.169.0.1', 'http://10.0.0.1\\@evil.example/', 'http://evil.example\\@10.0.0.1/', 'http://[::1'
  ]) {
    assert.strictEqual(E.isLocal(remote), false, remote + ' is not local');
  }
  // the real thing still is, also with credentials, upper case, a scheme-less form and IPv6
  for (const local of [
    'http://user:pw@localhost:11434', 'HTTP://LOCALHOST:11434/v1', 'localhost:11434', '127.0.0.1:11434/v1', '10.0.0.5:1234', '192.168.0.9', '172.16.0.1', '172.31.255.255',
    'http://[::1]:8080', 'http://a.b.localhost', 'http://My-PC.local:11434', 'http://alice:p@ss@192.168.1.5:11434/v1'
  ]) {
    assert.strictEqual(E.isLocal(local), true, local + ' is local');
  }
  // what cannot be parsed is not trusted as local (only an empty setting is)
  assert.strictEqual(E.isLocal('http://'), false);
  assert.strictEqual(E.isLocal('http://exa mple.com'), false);
  assert.strictEqual(E.isLocal('   '), true);

  // credentials and the port: hostOf keeps the port (the bar shows "localhost:11434") and drops the user part, lower-cased
  assert.strictEqual(E.hostOf('https://alice:pw@llm.example.com/v1'), 'llm.example.com');
  assert.strictEqual(E.hostOf('https://alice:p@ss@LLM.Example.com:8443/v1?key=K'), 'llm.example.com:8443');
  assert.strictEqual(E.hostOf('https://10.0.0.1@evil.example/v1'), 'evil.example');
  assert.strictEqual(E.hostOf('HTTPS://Api.OpenAI.com'), 'api.openai.com');
  assert.strictEqual(E.hostOf('user:pw@example.com:1234/path'), 'example.com:1234');
  assert.strictEqual(E.hostOf('http://[::1]:8080/x'), '[::1]:8080');
  // even a URL the parser rejects does not bring the password back
  assert.ok(!/pw|alice/.test(E.hostOf('http://alice:pw@exa mple.com/v1')), E.hostOf('http://alice:pw@exa mple.com/v1'));
  assert.ok(!/secret/.test(E.hostOf('http://bob:secret@host:99999/v1')), E.hostOf('http://bob:secret@host:99999/v1'));
  console.log('PASS: B18 a private-looking name or a hidden address is public; hostOf never returns credentials.');
}

// 3. one line, bounded
{
  assert.strictEqual(E.oneLine('a\n  b\t c'), 'a b c');
  assert.strictEqual(E.oneLine('x'.repeat(400), 300).length, 301);
  assert.strictEqual(E.oneLine(null), '');
  console.log('PASS: oneLine collapses white space and bounds the length.');
}

console.log('\nAll LLM error tests PASSED!');
