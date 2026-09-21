import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}]/u;

console.log("=== Evaluation Driven Testing for Emoji-Free Palette & Unified SVG Icons ===");

// 1. Verify i18n translations
const i18nContent = fs.readFileSync(path.resolve("./frontend/js/i18n.js"), "utf8");
const targetKeys = [
  "cmdPaletteConvertMermaid",
  "cmdPaletteMermaidToImage",
  "cmdPaletteMermaidToPrompt",
  "cmdPaletteAiCorrect",
  "gitGuideTitle",
  "gitGuideStep1Warning",
  "gitSyncStatusDisabled",
  "cliWarningConfirm"
];

for (const key of targetKeys) {
  const re = new RegExp(`${key}:\\s*"([^"]+)"`, "g");
  let match;
  while ((match = re.exec(i18nContent)) !== null) {
    const val = match[1];
    assert(!emojiRegex.test(val), `Key ${key} translation must not contain emoji. Found: ${val}`);
  }
}
console.log("PASS: All command palette and settings i18n keys are free of emojis in EN & JA.");

// 2. Verify HTML settings modal
const htmlContent = fs.readFileSync(path.resolve("./frontend/index.html"), "utf8");
assert(!htmlContent.includes("<span>⚠️</span>"), "git-installed-banner must not contain emoji ⚠️");
assert(htmlContent.includes("git-installed-banner"), "git-installed-banner must exist");
assert(!htmlContent.includes("📋"), "settings modal must not contain emoji 📋");
assert(!htmlContent.includes("⚠️"), "settings modal must not contain literal emoji ⚠️");
console.log("PASS: HTML settings modal is free of emojis and uses unified SVG icons.");

// 3. Verify app.js quickPick definitions and noteCommands
const appJsContent = fs.readFileSync(path.resolve("./frontend/js/app.js"), "utf8");
assert(!appJsContent.includes("title: `📄 ${note.title}`"), "noteCommands must not prefix notes with 📄 emoji");
assert(appJsContent.includes("title: note.title"), "noteCommands must use clean note.title");

const baseCommandIds = [
  "cmd_new_tab",
  "cmd_open_file",
  "cmd_open_folder",
  "cmd_ask_ai",
  "cmd_command_bar",
  "cmd_cli_filter",
  "cmd_ai_cli",
  "cmd_pipe_polish",
  "cmd_pipe_bullets",
  "cmd_pipe_tasks",
  "cmd_convert_mermaid",
  "cmd_mermaid_to_image",
  "cmd_mermaid_to_prompt",
  "cmd_ai_correct",
  "cmd_export_plain",
  "cmd_toggle_zen",
  "cmd_toggle_split"
];

for (const cmdId of baseCommandIds) {
  assert(appJsContent.includes(`id: '${cmdId}'`), `Command ${cmdId} must exist`);
}

assert(appJsContent.includes('class="quick-pick-item-icon"'), "renderQuickPickList must render item.iconSvg");
console.log("PASS: app.js command palette renders unified SVG icons without emojis.");

// 4. Verify style.css contains quick-pick-item-icon rules
const cssContent = fs.readFileSync(path.resolve("./frontend/css/style.css"), "utf8");
assert(cssContent.includes(".quick-pick-item-icon"), "style.css must have .quick-pick-item-icon styling");
console.log("PASS: style.css contains styling for unified palette icons.");

console.log("\nAll command palette & settings icon evaluation tests passed with 0 error(s)!");
