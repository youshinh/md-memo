# Demo GIFs for the README

Records short, English-only screen GIFs of MD-Memo (`img/demo/*.gif`) from the **real frontend** (`frontend/`), driven
through the docshots harness. The Japanese README reuses the same files.

The real MD-Memo is never involved. `md-memo.exe` is not started, no running MD-Memo window is focused or captured, and the
real `config.json` / `agents.yaml` / `.env` / notes are never read. Everything runs on the harness described in
[`../README.md`](../README.md): a local static server for `frontend/`, the mocked `window.backend`
(`../mock/backend.js`, demo data in `../data/demo.mjs`, UI language `en`), a request blocker (nothing leaves the machine),
and an isolated Edge window with its own temporary profile that is removed afterwards. Only the browser this run started is
ever stopped (by its process tree, never by image name).

## Run

```
node tools/docshots/gifs/record.mjs                       # every GIF -> img/demo/
node tools/docshots/gifs/record.mjs --list                # names and what they show
node tools/docshots/gifs/record.mjs --only ask-ai,ghost-text
node tools/docshots/gifs/record.mjs --out %TEMP%\gif-try  # write somewhere else while trying things
node tools/docshots/gifs/record.mjs --only quick-actions --preview %TEMP%\gif-prev --keep-frames
```

Options: `--width 860` (final width), `--fps 10`, `--colors 128`, `--hold 1500` (ms the last frame stays),
`--capture screencast|shots` (frame source, see below), `--tmp dir` (where the raw frames go, default the system temp
folder), `--keep-frames`, `--preview dir` with `--preview-count N` (see "Checking the result"), `--skip a-b,c-d` (cut
time ranges in ms out of a clip). `Ctrl+C` closes the harness browser before exiting.

Needs Node 24 (no npm packages), Python 3 with Pillow, and Microsoft Edge (`EDGE_PATH` overrides the location). An Edge
window appears at (40,40) on the desktop while recording (about 30-40 s per GIF); that is expected. Input goes through the
DevTools protocol, not the OS keyboard, but do not close or resize that window meanwhile.

## The GIFs

| File | Shows | Length |
| --- | --- | --- |
| `ask-ai.gif` | Select three rambling lines, `Ctrl+L`, type "Make this concise", the answer appears below the selection (the original stays) and the changed rows glow amber | about 9.7 s |
| `ghost-text.gif` | Type the start of a sentence, a grey prediction appears after the caret, `Tab` accepts it; a second short one | about 9.2 s |
| `command-bar.gif` | Select raw log words, `Ctrl+E`, `sort \| uniq -c \| sort -rn`, the output appears below the selection | about 9.3 s |
| `delegate-agent.gif` | `@claude ...` line, `Ctrl+Enter` (rewritten to a `{{ @claude-code ... }}` task), `Ctrl+Enter` (runs), `Alt+T` task panel with progress, result block with the green bar in the gutter | about 9.3 s |
| `live-preview.gif` | `Ctrl+Alt+V` preview to the side, a heading, a list and a Mermaid diagram typed, the diagram appears on the right, `Ctrl+P` full preview | about 9.8 s |
| `scrap-search.gif` | `Ctrl+Shift+F`, "limit" typed letter by letter (results narrow), `Down`, `Tab` quotes the hit into the note | about 8.6 s |
| `quick-actions.gif` | `Ctrl+J`, three suggestion cards, `Tab` moves to the second, `Enter` runs it, the new "Risks" section lands in the note | about 8.3 s |
| `proofread.gif` | Select two lines full of typos, `Alt+C`, the corrected text replaces them in place with the amber band and the "Text corrected by AI" toast | about 7.5 s |
| `mermaid-ai.gif` | `Ctrl+Alt+V` preview, select a list of steps, `Ctrl+Shift+P`, "flowchart", `Enter` (Diagram: Convert Selection to Mermaid); the Mermaid block arrives with the amber band and the diagram appears in the side preview | about 9.3 s |
| `paste-image.gif` | A whiteboard screenshot "on the clipboard" (a recording-only card shows it), `Ctrl+V`, the app transcribes the image, the Mermaid block arrives (amber band) and the diagram appears in the side preview | about 8.8 s |

## How it works

1. `record.mjs` starts the harness (`lib.mjs`), loads a fresh demo page for each scenario, sets the window size, installs the
   key-cap pill, runs the scenario's `prepare` (not recorded) and then records its `run`.
2. `scenarios.mjs` holds the scenarios. `prepare` opens a new note, fills it and installs the scripted backend answers;
   `run` is what you see: real CDP key events (`Input.dispatchKeyEvent`, printable characters with their text) into the
   real textarea at 45-80 ms per character (a scenario may narrow that), shortcuts as real key events with modifiers,
   and pauses of 0.5-1.2 s between steps.
3. **Answers are scripted.** The harness has no model, agent or shell, so the scenario overrides the mock in the page after
   load and calls the application's own result callbacks after a realistic delay: `__onLLMResult` (ask), 
   `__onAutocompleteResult` (ghost text, chosen by the text before the caret), `__onCliFilterResult` (the command bar; the
   output is really computed from the selected text by a tiny `sort` / `uniq` implementation, so it is truthful),
   `__onSlotAgentResult` (the agent; progress lines come through `getSlotHoverPeek`), `__onJevResult` and `jevPredict`
   (Quick Actions). The words of the answers are canned; everything on screen after they arrive is the application's own
   UI state, code path and styling.
4. `Recorder` (`lib.mjs`) samples the page with `Page.startScreencast` (PNG, acknowledged frame by frame) and keeps the
   compositor timestamp of every frame; `--capture shots` uses a timed `Page.captureScreenshot` loop instead.
5. `assemble.py` (Pillow) makes the GIF: the clip is sampled at 10 fps, taking the newest frame at each tick (so timing
   comes from the timestamps and a fade keeps its real length), identical neighbours are merged, delays are multiples of
   10 ms and at least 100 ms, the crop is scaled to 860 px wide only if it is not already that wide, one global palette of
   128 colours is built from the whole clip (frequent colours exact, the rest added by worst representation, so a thin
   accent bar keeps its hue), frames are mapped to it without dithering, the last frame is held 1.5 s and the GIF
   loops forever. Sizes are 10-350 KB per GIF (targets: 1.3 MB, hard cap 2 MB).

Pictures are 1120 px wide pages cropped per scenario. Where the text would shrink too much when scaled to 860 px, the
recording page gets a larger font through the application's own zoom (`Ctrl+=`, 2-3 steps) and, for panels with small
fixed text, a CSS `zoom: 1.3` on that panel. Text-only scenarios are cropped to exactly 860 px and are not scaled at all.
`delegate-agent` and `quick-actions` use a shorter window (1120x560 / 1120x500) because their panels sit at the bottom of
the window; the width is always 1120.

## Recording-only additions (never in `frontend/`)

* **Key-cap pill** (`lib.mjs`): a dark pill (`#2b2b2b`, `#f2f2f2` text, 1 px `#555` border, 13 px system font, `pointer-events: none`,
  highest z-index) near the bottom of the recorded area that names the shortcut for 0.8 s. Shown for `Ctrl + L`, `Ctrl + E`,
  `Ctrl + Enter`, `Alt + T`, `Tab` (when it accepts or moves), `Enter` (Quick Actions), `Ctrl + J`, `Ctrl + Shift + F`,
  `Ctrl + Alt + V`, `Ctrl + P`, `Alt + C`, `Ctrl + Shift + P` and `Ctrl + V`. A scenario can lift the pill above the status bar
  (`keycapBottom`) or move it sideways (`keycapX`).
* **Clipboard card** (`installClipboardCard` in `lib.mjs`, used by `paste-image`): the clipboard is invisible in a recording,
  so a card in the same family as the pill (dark, 1 px `#555` border, 13 px font, top right of the recorded area) shows the
  sketch thumbnail with the label "Clipboard: screenshot.png" from just before the paste until half a second after it.
* **English-only patch** (`installCosmetics` in `lib.mjs`): a few strings of the application are Japanese even in the
  English UI because they are hard-coded and not in `i18n.js`: the task panel's "クリア" button and its elapsed time ("2秒",
  `task_manager.js` `formatElapsed`), and the running / error lines of the Quick Actions panel ("実行中:", "エラー:",
  `jev_action.js`). Inside those two panels the recording page shows "Clear", "2s", "Running:" and "Error:" instead. Remove
  this once the application localises them.
* **Mermaid warm-up** (`live-preview`, `mermaid-ai`, `paste-image`): the 3 MB diagram library is loaded and one diagram drawn before recording, so the clip
  does not contain the harness's first-load stall.
* The diagram block of `live-preview` is typed without stopping: the preview redraws after every 120 ms of silence, and a
  half-typed diagram would flash a Mermaid syntax error.
* **Synthetic paste** (`paste-image`): a real `Ctrl+V` would paste whatever is on the real clipboard of the person running the
  recorder. The pill is shown, and the paste itself is a synthetic `paste` event whose `DataTransfer` carries the sketch (a
  PNG made on a canvas in the recording page: white background, four wobbly boxes and arrows, Idea, Draft, Review, Publish).
  It reaches the application's own paste handler, which reads the picture, inserts its "Transcribing Image" line and asks
  the vision model; the scenario checks that the request really carried a PNG. The vision model's answer is scripted.
* **Wider preview pane** (`mermaid-ai`): before recording, the scenario opens the preview, drags the application's own divider
  with real mouse events so the preview gets two thirds of the width (the note is narrow), and closes the preview again; the
  divider position is kept, so the recorded `Ctrl+Alt+V` opens the wide preview. Five nodes side by side need that width.
* `proofread` uses a 1120x340 window and includes the status bar, because the "Text corrected by AI" toast lives there.
  `Ctrl+Z` after the correction is not shown: it first goes back to the "[AI Correcting...]" placeholder and only a second
  press restores the original, which does not read well in a GIF.
* `command-bar` sets "open the result in a new tab" off for the page so that the output stays in the note.
* `ask-ai` sets the change-highlight duration to the application's default (4 s); the demo config used for still pictures
  has 8 s.

## Checking the result

`--preview dir` (with `--keep-frames` if you also want the raw frames) writes N evenly spaced frames of each finished GIF
as PNG (`<name>-01.png` ...) and, for every key-cap event, one frame just before the key (`-keyNNpre`) and one shortly
after (`-keyNNpost`). Open them and check: the feature is visibly happening, text is readable, no browser chrome, no leftover
toast, the pill matches the action, the last frame shows the outcome.

## Files

| File | Purpose |
| --- | --- |
| `record.mjs` | CLI: harness, per-scenario loop, recording, calls `assemble.py`, cleanup |
| `scenarios.mjs` | The ten scenarios (crop, window size, prepare, run, scripted answers) |
| `lib.mjs` | Harness launch, human-looking input, key-cap pill, clipboard card, English-only patch, frame recorder |
| `assemble.py` | Frames + timestamps -> GIF (crop, scale, palette, delays, previews) |

Apart from the temporary raw frames and the temporary Edge profile (both in the temp folder, deleted afterwards), nothing
outside `tools/docshots/gifs/` and `img/demo/` is written, and none of the existing docshots files is changed.

## Adding or changing a scenario

Add an entry to `SCENARIOS` in `scenarios.mjs` with `title`, `crop`, `prepare` and `run` (optional: `viewport`, `typing`,
`keycapX`), then `node tools/docshots/gifs/record.mjs --only <name> --out %TEMP%\gif-try --preview %TEMP%\gif-prev` and look
at the preview frames. Keep a clip between 5 and 10 s and the note short. Use `human.press(key, mods, 'Label')` for a
shortcut that should show a pill and `human.type(text)` for typing; wait for the application's own state with
`page.waitFor(expression)` instead of guessing with long sleeps.

## Known limits

* The pictures show the frontend working tree as it is when the recorder runs. Re-record after UI changes.
* Timings of scripted answers (1-3 s) are chosen for readability, not measured from a real model.
* No mouse pointer is drawn (the screencast is of the page, not of the desktop); all scenarios use the keyboard.
