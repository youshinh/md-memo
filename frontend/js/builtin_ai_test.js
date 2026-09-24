// Unit tests for builtin_ai.js: feature-detection for the (currently
// unavailable in md-memo's real runtimes) Prompt API and WebMCP shims.
const assert = require('assert');

const modulePath = require.resolve('./builtin_ai.js');

// The module self-registers WebMCP tools once at require time and latches
// that with an internal flag, so each scenario needs a fresh module instance
// with its mocks already in place before requiring.
function freshLoad(mockWindow, mockDocument) {
  delete require.cache[modulePath];
  global.window = mockWindow;
  global.document = mockDocument;
  require(modulePath);
  return mockWindow.BuiltinAI;
}

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    try {
      await fn();
      console.log('PASS: ' + name);
    } catch (e) {
      console.error('FAIL: ' + name);
      throw e;
    }
  });
}

test('isPromptAPIAvailable / isWebMCPAvailable reflect the globals', () => {
  const mockWindow = {};
  const mockDocument = {};
  const BuiltinAI = freshLoad(mockWindow, mockDocument);
  assert.strictEqual(BuiltinAI.isPromptAPIAvailable(), false);
  assert.strictEqual(BuiltinAI.isWebMCPAvailable(), false);

  mockWindow.LanguageModel = {};
  mockDocument.modelContext = { registerTool: () => Promise.resolve() };
  assert.strictEqual(BuiltinAI.isPromptAPIAvailable(), true);
  assert.strictEqual(BuiltinAI.isWebMCPAvailable(), true);
});

test('generateText is a no-op when LanguageModel is absent', async () => {
  const BuiltinAI = freshLoad({}, {});
  const result = await BuiltinAI.generateText('hello');
  assert.strictEqual(result, null);
});

test('generateText never creates a session (or triggers a download) while unavailable', async () => {
  let createCalled = false;
  const mockWindow = {
    LanguageModel: {
      availability: async () => 'downloadable',
      create: async () => { createCalled = true; return { prompt: async () => 'x', destroy() {} }; }
    }
  };
  const BuiltinAI = freshLoad(mockWindow, {});
  const result = await BuiltinAI.generateText('hello');
  assert.strictEqual(result, null);
  assert.strictEqual(createCalled, false);
});

test('generateText returns the prompted text and always destroys the session', async () => {
  let destroyed = false;
  let seenOptions = null;
  const mockWindow = {
    LanguageModel: {
      availability: async () => 'available',
      create: async (options) => {
        seenOptions = options;
        return { prompt: async (text) => `echo:${text}`, destroy() { destroyed = true; } };
      }
    }
  };
  const BuiltinAI = freshLoad(mockWindow, {});
  const result = await BuiltinAI.generateText('hello', 'be helpful');
  assert.strictEqual(result, 'echo:hello');
  assert.strictEqual(destroyed, true);
  assert.deepStrictEqual(seenOptions.initialPrompts, [{ role: 'system', content: 'be helpful' }]);
});

test('generateText swallows errors and reports null instead of throwing', async () => {
  const mockWindow = {
    LanguageModel: {
      availability: async () => 'available',
      create: async () => { throw new Error('boom'); }
    }
  };
  const BuiltinAI = freshLoad(mockWindow, {});
  const result = await BuiltinAI.generateText('hello');
  assert.strictEqual(result, null);
});

test('registerWebMCPTools is a no-op when document.modelContext is absent', () => {
  const BuiltinAI = freshLoad({ backend: { searchScraps: async () => [] } }, {});
  // Must not throw when called again with WebMCP still absent.
  BuiltinAI.registerWebMCPTools();
});

test('registerWebMCPTools does not register a tool for a backend method that does not exist', () => {
  let registerToolCalled = false;
  const mockDocument = { modelContext: { registerTool: () => { registerToolCalled = true; return Promise.resolve(); } } };
  freshLoad({}, mockDocument);
  assert.strictEqual(registerToolCalled, false);
});

test('registerWebMCPTools registers searchNotes wired to backend.searchScraps', async () => {
  let registeredTool = null;
  const searchCalls = [];
  const mockDocument = {
    modelContext: { registerTool: (tool) => { registeredTool = tool; return Promise.resolve(); } }
  };
  const mockWindow = {
    backend: {
      searchScraps: async (query, maxResults) => {
        searchCalls.push([query, maxResults]);
        return [{ filePath: '2026-09-23.md' }];
      }
    }
  };
  freshLoad(mockWindow, mockDocument);

  assert.ok(registeredTool, 'searchNotes tool should have been registered');
  assert.strictEqual(registeredTool.name, 'searchNotes');
  assert.strictEqual(registeredTool.annotations.readOnlyHint, true);

  const output = await registeredTool.execute({ query: 'todo' });
  assert.deepStrictEqual(searchCalls, [['todo', 50]]);
  assert.deepStrictEqual(output, { results: [{ filePath: '2026-09-23.md' }] });
});

test('registerWebMCPTools only registers once even if called again', () => {
  let registerToolCallCount = 0;
  const mockDocument = { modelContext: { registerTool: () => { registerToolCallCount++; return Promise.resolve(); } } };
  const mockWindow = { backend: { searchScraps: async () => [] } };
  const BuiltinAI = freshLoad(mockWindow, mockDocument);
  assert.strictEqual(registerToolCallCount, 1, 'the top-level self-invocation on require should have registered once');

  BuiltinAI.registerWebMCPTools();
  BuiltinAI.registerWebMCPTools();
  assert.strictEqual(registerToolCallCount, 1, 'later calls must be no-ops');
});

pending.then(() => console.log('\nAll builtin_ai tests PASSED!')).catch((e) => {
  console.error(e);
  process.exit(1);
});
