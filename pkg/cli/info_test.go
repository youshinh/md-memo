package cli

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/ipc"
)

// pinNow makes "today" 2026-09-25 for the test.
func pinNow(t *testing.T) {
	t.Helper()
	prev := nowFunc
	nowFunc = func() time.Time { return time.Date(2026, 9, 25, 10, 11, 12, 0, time.Local) }
	t.Cleanup(func() { nowFunc = prev })
}

func runInfoJSON(t *testing.T, extra ...string) (map[string]interface{}, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, err := NewHeadlessRunner(&out, &errOut).WithVersion("9.9.9").Run(append([]string{"info", "--json"}, extra...))
	if err != nil || code != 0 {
		t.Fatalf("info: code %d, err %v, stderr %q", code, err, errOut.String())
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &m); err != nil {
		t.Fatalf("info output is not JSON: %q", out.String())
	}
	return m, out.String()
}

func TestInfoReportsTheFakeConfig(t *testing.T) {
	home := withTempHome(t)
	pinNow(t)
	scrapDir := filepath.Join(home, "notes", "scraps")
	inboxDir := filepath.Join(home, "hot")
	writeConfigFile(t, `{
		"scraps": {"scrapDir": "~/notes/scraps", "gitRemoteUrl": "https://user:hunter2@example.com/me/notes.git"},
		"inbox": {"enabled": true, "dir": "~/hot"},
		"general": {"autoSave": false},
		"text": {"apiKey": "sk-TEXT-SECRET-1"}, "vision": {"apiKey": "sk-VISION-SECRET-2"},
		"discordBridge": {"botToken": "DISCORD-TOKEN-SECRET-3"}
	}`)
	writeFile(t, filepath.Join(scrapDir, "2026-09-25.md"), "today\n")

	m, raw := runInfoJSON(t)

	want := map[string]interface{}{
		"version":            "9.9.9",
		"config_dir":         appdir.AppConfigDir(),
		"config_file":        appdir.ConfigFilePath(),
		"scrap_dir":          scrapDir,
		"today_scrap_path":   filepath.Join(scrapDir, "2026-09-25.md"),
		"today_scrap_exists": true,
		"inbox_dir":          inboxDir,
		"inbox_enabled":      true,
		"autosave":           false,
		"gui_running":        false,
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %v, want %v", k, m[k], v)
		}
	}
	// Exactly these keys, all snake_case: adding one is a documented change.
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var wantKeys []string
	for k := range want {
		wantKeys = append(wantKeys, k)
	}
	sort.Strings(wantKeys)
	if strings.Join(keys, ",") != strings.Join(wantKeys, ",") {
		t.Errorf("keys = %v, want %v", keys, wantKeys)
	}

	for _, secret := range []string{"SECRET", "hunter2", "example.com", "TOKEN"} {
		if strings.Contains(raw, secret) {
			t.Errorf("info printed %q: %s", secret, raw)
		}
	}
}

func TestInfoDefaultsWithoutAConfigFileAndCreatesNothing(t *testing.T) {
	home := withTempHome(t)
	pinNow(t)

	m, _ := runInfoJSON(t)
	scrapDir := filepath.Join(home, "Documents", "md-memo", "scraps")
	if m["scrap_dir"] != scrapDir || m["today_scrap_path"] != filepath.Join(scrapDir, "2026-09-25.md") {
		t.Errorf("default scrap folder: %v / %v, want %s", m["scrap_dir"], m["today_scrap_path"], scrapDir)
	}
	if m["today_scrap_exists"] != false || m["inbox_enabled"] != false || m["autosave"] != true || m["gui_running"] != false {
		t.Errorf("defaults wrong: %v", m)
	}
	if m["inbox_dir"] != filepath.Join(home, "Documents", "md-memo", "inbox") {
		t.Errorf("inbox_dir = %v", m["inbox_dir"])
	}
	// Nothing was created: not the settings folder, not the scrap folder, not today's file.
	for _, p := range []string{appdir.AppConfigDir(), scrapDir, filepath.Join(home, "Documents")} {
		if exists(p) {
			t.Errorf("info created %s", p)
		}
	}
}

func TestInfoWithAnUnparsableConfigFallsBackToDefaults(t *testing.T) {
	home := withTempHome(t)
	pinNow(t)
	writeConfigFile(t, `{"scraps": {"scrapDir": `)
	m, _ := runInfoJSON(t)
	if m["scrap_dir"] != filepath.Join(home, "Documents", "md-memo", "scraps") {
		t.Errorf("scrap_dir = %v", m["scrap_dir"])
	}
}

func TestInfoText(t *testing.T) {
	withTempHome(t)
	pinNow(t)
	var out, errOut bytes.Buffer
	code, err := NewHeadlessRunner(&out, &errOut).WithVersion("9.9.9").Run([]string{"info", "--text"})
	if err != nil || code != 0 {
		t.Fatalf("code %d, err %v", code, err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 10 {
		t.Fatalf("expected one line per field, got %d:\n%s", len(lines), out.String())
	}
	kv := map[string]string{}
	for _, l := range lines {
		k, v, ok := strings.Cut(l, ": ")
		if !ok {
			// a colon inside the value (a Windows path) is fine; a key without ": " is not
			t.Fatalf("line %q is not 'key: value'", l)
		}
		kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if kv["version"] != "9.9.9" || kv["gui_running"] != "false" || kv["autosave"] != "true" {
		t.Errorf("text fields wrong: %v", kv)
	}
}

func TestInfoVersionDefaultsToUnknown(t *testing.T) {
	withTempHome(t)
	var out bytes.Buffer
	if _, err := NewHeadlessRunner(&out, &bytes.Buffer{}).Run([]string{"info", "--json"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"version": "unknown"`) {
		t.Errorf("no version given: %s", out.String())
	}
}

func TestInfoFlagsAndArguments(t *testing.T) {
	withTempHome(t)
	var out, errOut bytes.Buffer
	r := NewHeadlessRunner(&out, &errOut)

	if code, err := r.Run([]string{"info", "extra"}); code != 1 || err == nil || !strings.Contains(err.Error(), "no arguments") {
		t.Errorf("an extra word must be refused: code %d err %v", code, err)
	}
	if code, err := r.Run([]string{"info", "--bogus"}); code != 1 || err == nil {
		t.Errorf("an unknown flag must be refused: code %d err %v", code, err)
	}
	// Flags may follow: info --json is the same as info with --json placed anywhere.
	if code, err := r.Run([]string{"info", "--json", "--text"}); code != 0 || err != nil {
		t.Errorf("code %d err %v", code, err)
	}
	// -h after other words asks for the usage (exit 0), it is not an error.
	out.Reset()
	if code, err := r.Run([]string{"info", "-h"}); code != 0 || err != nil || out.String() != SubcommandUsage("info") {
		t.Errorf("-h: code %d err %v out %q", code, err, firstLine(out.String()))
	}
}

// guiRunning must answer from the session file and the port alone, and must never delete or
// rewrite the file (LoadSession would delete a stale one).
func TestInfoGUIRunningIsReadOnly(t *testing.T) {
	withTempHome(t)
	pinNow(t)
	sessionPath := ipc.GetSessionFilePath()

	// 1. No session file: not running.
	if m, _ := runInfoJSON(t); m["gui_running"] != false {
		t.Error("no session file must mean not running")
	}

	// 2. A live listener on the recorded port: running. The token stays out of the output.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	session := ipc.SessionInfo{PID: os.Getpid(), Port: port, Token: "SESSION-TOKEN-SECRET", StartedAt: time.Now()}
	data, _ := json.Marshal(session)
	writeFile(t, sessionPath, string(data))

	m, raw := runInfoJSON(t)
	if m["gui_running"] != true {
		t.Errorf("a live port must mean running: %v", m)
	}
	if strings.Contains(raw, "SESSION-TOKEN-SECRET") {
		t.Errorf("the session token leaked into the output: %s", raw)
	}

	// 3. The listener goes away: not running, and the stale file is left exactly as it was.
	ln.Close()
	time.Sleep(20 * time.Millisecond)
	m, _ = runInfoJSON(t)
	if m["gui_running"] != false {
		t.Errorf("a closed port must mean not running: %v", m)
	}
	after, err := os.ReadFile(sessionPath)
	if err != nil || string(after) != string(data) {
		t.Errorf("info must leave a stale session file alone (err %v, now %q)", err, after)
	}

	// 4. Garbage or an impossible port: not running, and still no deletion.
	for _, junk := range []string{"not json", `{"port": 0}`, `{"port": 70000}`, `{"port": -1}`} {
		writeFile(t, sessionPath, junk)
		if m, _ := runInfoJSON(t); m["gui_running"] != false {
			t.Errorf("%q: gui_running = %v", junk, m["gui_running"])
		}
		if got, err := os.ReadFile(sessionPath); err != nil || string(got) != junk {
			t.Errorf("%q: the file was touched (err %v, now %q)", junk, err, got)
		}
	}
}
