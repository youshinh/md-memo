// Thin feature-detection shim for Chromium's experimental built-in AI surfaces:
// the Prompt API (window.LanguageModel) and WebMCP (document.modelContext).
// Neither ships in md-memo's actual runtimes today -- WebView2 stable on
// Windows and WKWebView on macOS -- so every function here returns/no-ops
// immediately when the global is absent. This exists purely so the app picks
// these up automatically if a runtime ever adds support, without another
// release; it has no observable effect today.
(function (global) {
  'use strict';

  function isPromptAPIAvailable() {
    return typeof global.LanguageModel !== 'undefined';
  }

  function isWebMCPAvailable() {
    return typeof document !== 'undefined' && !!document.modelContext;
  }

  // Resolves to generated text, or null if the API is absent, the on-device
  // model isn't already downloaded (this never triggers a multi-GB download
  // on the user's behalf), or generation fails for any reason. Callers treat
  // null exactly like "fall back to the existing backend path".
  async function generateText(promptText, systemPrompt) {
    if (!isPromptAPIAvailable()) return null;
    try {
      const availability = await global.LanguageModel.availability();
      if (availability !== 'available') return null;

      const options = {};
      if (systemPrompt) {
        options.initialPrompts = [{ role: 'system', content: systemPrompt }];
      }
      const session = await global.LanguageModel.create(options);
      try {
        return await session.prompt(promptText);
      } finally {
        session.destroy();
      }
    } catch (err) {
      console.warn('[BuiltinAI] Prompt API generation failed, falling back:', err);
      return null;
    }
  }

  let toolsRegistered = false;

  // Registers read-only WebMCP tools that mirror capabilities already exposed
  // on window.backend. Each tool checks the backend method it wraps still
  // exists before registering, so this stays purely additive against the
  // current bindings -- no new Go surface required.
  function registerWebMCPTools() {
    if (toolsRegistered || !isWebMCPAvailable()) return;
    toolsRegistered = true;

    const backend = global.backend;
    if (backend && typeof backend.searchScraps === 'function') {
      Promise.resolve(document.modelContext.registerTool({
        name: 'searchNotes',
        description: "Search the user's local md-memo notes (daily scraps) for a keyword or phrase.",
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword or phrase to search for' }
          },
          required: ['query']
        },
        execute: async ({ query }) => {
          const results = await backend.searchScraps(query, 50);
          return { results };
        },
        annotations: { readOnlyHint: true }
      })).catch((err) => console.warn('[BuiltinAI] WebMCP tool registration failed:', err));
    }
  }

  registerWebMCPTools();

  global.BuiltinAI = {
    isPromptAPIAvailable: isPromptAPIAvailable,
    isWebMCPAvailable: isWebMCPAvailable,
    generateText: generateText,
    registerWebMCPTools: registerWebMCPTools
  };
})(window);
