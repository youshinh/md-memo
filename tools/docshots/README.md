# docshots: manual screenshots without touching the real app

Produces the pictures in `img/manual/ja/` and `img/manual/en/` (same file names in both) and the brief for the
documentation writers, `img/manual/shots.md`.

The real MD-Memo is never involved. `md-memo.exe` is not started, no running MD-Memo window is focused, clicked or
captured, and the real `config.json` / `agents.yaml` / `.env` / notes are never read. Instead:

1. `server.mjs` serves `frontend/` as it is (nothing under `frontend/` is modified). `/` is an in-memory copy of
   `index.html` with a unique `<title>` (`DOCSHOT-xxxx`) and the mock backend injected.
2. `mock/backend.js` replaces `window.backend` (the functions `window_windows.go` binds), fixes the clock at
   2026-09-18 10:24, blocks every request that leaves the local server and seeds the demo config, note tabs,
   workspace notes and scraps from `data/demo.mjs` (UI language = `general.language` of the mocked config).
3. `cdp.mjs` starts an isolated Microsoft Edge (`--app`, own temporary `--user-data-dir`, `--force-device-scale-factor=1`)
   and drives it through the Chrome DevTools Protocol: real key and mouse events for shortcuts and typing;
   synthetic paste / drag events (a real Ctrl+V would paste the user's actual clipboard).
4. `capture.uws` (UWSCR) finds the window by the unique title token only (never by "MD-Memo"; it refuses that token),
   checks title, exe path and process id, and saves the client area with `saveimg(..., WGCAPI=TRUE)` (Windows Graphics
   Capture, by window id, so overlapping windows cannot leak in).
5. `postprocess.py` (Pillow) cuts the page viewport out of the capture (the client area also holds the browser caption
   bar), verifies it (not blank; pixel-compared with a CDP screenshot of the same state, which a capture of any other
   window would fail), crops, scales, draws the numbered markers, and optimizes the PNG.

## Run

```
node tools/docshots/run.mjs                       # every shot, both languages
node tools/docshots/run.mjs --lang ja             # one language (ja | en | both)
node tools/docshots/run.mjs --only ui-map,cli-bar # some shots (names from shots.json; --list prints them)
node tools/docshots/run.mjs --method cdp          # skip UWSCR, use CDP Page.captureScreenshot
node tools/docshots/run.mjs --method uwscr        # UWSCR only: fail instead of falling back
node tools/docshots/run.mjs --out <dir>           # write <dir>/ja|en/*.png instead of img/manual (for trials)
node tools/docshots/run.mjs --cleanup             # stop a harness browser left behind by a crashed run
```

Needs Node 24 (global `WebSocket` / `fetch`, no npm packages), Python with Pillow, Microsoft Edge, and UWSCR
(`C:\Users\yoush\Documents\uwscr.exe`, override with `UWSCR_PATH`; Edge with `EDGE_PATH`). Nothing else is installed.

`--method auto` (the default) probes UWSCR once at the start: it captures the freshly loaded page. If UWSCR cannot deliver
a picture, the run falls back to `Page.captureScreenshot` for every shot and says so in the log
(`cdp-fallback`). Each shot is checked against the CDP reference; a capture that does not match is retried once with the
window brought to the front, then falls back.

Important: Windows Graphics Capture only produces frames while the interactive Windows session is connected. In a
disconnected or locked Remote Desktop session `saveimg` waits forever (the probe times out after 20 s). Reconnect the
session and re-run. While a run is going the harness Edge window is open (40,40) on the desktop; do not use the machine.

The window client area is 1120x720 (device scale factor 1). Full pictures are exactly that; crops are cut from a
full picture. The two phone pictures use a 390x844 viewport.

## Files

| File | Purpose |
| --- | --- |
| `run.mjs` | CLI and orchestration: server, browser, per-shot loop, capture, `shots.md` |
| `shots.json` | Every shot: name, English description, crop / scale, markers (position source + meaning), page / viewport |
| `setups.mjs` | Per-shot state setup functions (named by `setup` in `shots.json`) |
| `server.mjs` | Static server, index.html injection, `/api/image` demo diagram, phone page rendering |
| `mock/backend.js` | Mock `window.backend`, fixed clock, network block, in-page helpers (`window.__docshot`) |
| `data/demo.mjs` | Demo config, notes, workspace notes, scraps (ja and en) |
| `data/qr.txt` | QR data URI for the fake pairing URL; regenerate with `go run ./tools/docshots/qrdemo > tools/docshots/data/qr.txt` |
| `qrdemo/main.go` | Renders that QR with the repo's `pkg/qrgen`; starts no server |
| `cdp.mjs` | Edge launcher / shutdown (only the browser this run started) and a small CDP client |
| `capture.uws` | UWSCR capture script |
| `postprocess.py` | Verify, crop, marker drawing, PNG optimization |
| `shots_md.mjs` | Writes `img/manual/shots.md` from `shots.json` and the files on disk |

The phone page is not rendered by a Go program: `renderPage` in `pkg/dropzone/html.go` is unexported, so `server.mjs`
reads the `pageSource` raw string from that file and substitutes a fake token. The page therefore always matches the
current source. The `isSecureContext` flag is forced off, as on a phone that reaches the PC over plain HTTP.

## Markers

Numbered call-outs are a filled circle `#e8743b` with a 2 px white ring and a white bold digit, 26 px (22 px in small
crops, 30 px in the 2x status-bar crop). Positions come from the live layout through `getBoundingClientRect()` at capture
time (a CSS `selector`, or a `js` expression returning `{x,y,w,h}`), plus an anchor (`at`: tl, t, tr, l, c, r, bl, b, br)
and an offset (`dx`, `dy`). Nothing is hard-coded to pixels except the offsets. The digits are language independent.

## Adding or changing a shot

1. Add a setup function in `setups.mjs` (it receives a freshly loaded demo page; `ctx.key`, `ctx.type`, `ctx.ev`,
   `ctx.waitFor`, `ctx.clickSel`, `ctx.pick(en, ja)` ...).
2. Add the entry to `shots.json` (`size`: `full` or `crop`, `crop`, `scale`, `markers` with English `meaning`).
3. Try it: `node tools/docshots/run.mjs --lang en --only <name> --method cdp --out %TEMP%\shots-try`, look at the picture,
   then run it for real.

`requires` lists ids the frontend must contain (for a shot that depends on a change that may still be landing);
`last: true` runs the shot at the end of a run. If a required id is missing the result is flagged
"Needs re-run" in `shots.md`.

## Known limits

* Timing-based UI (toasts, the 3 s Ghost Diff, the running-task clock, the Mobile Drop countdown) is made stable by
  pinning text, freezing the clock and pausing the animation right before the capture.
* The pictures show the frontend working tree as it is when the harness runs. Re-run after UI changes.
* The Windows Graphics Capture path needs a connected session (see above).
* A UWSCR capture also records the real mouse pointer when it rests over the harness window (a white arrow in the
  picture; `postprocess.py` still passes it). Look at every picture; move the pointer away, or capture that shot with
  `--method cdp` (Page.captureScreenshot never contains the pointer) and say so in the report.
* A dialog taller than the 1120x720 window scrolls inside itself (the package dialogs, for example). Show it in two shots
  (`packExport` scrolls `#pack-body` to the top, `packExportItems` to the bottom) and point the markers only at elements
  that are visible in that position: a marker whose target is scrolled out of view is drawn at the wrong place.
