package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"time"

	"md-memo/pkg/ipc"
	"md-memo/pkg/scrap"
)

// nowFunc is time.Now behind a variable so tests can pin "today".
var nowFunc = time.Now

// infoResult is the JSON of `md-memo info`. Every key is snake_case and none of them can carry a
// secret: paths, booleans and the version, nothing read from the api-key or token fields of
// config.json and nothing from the IPC session file except whether a live app is behind it.
type infoResult struct {
	Version          string `json:"version"`
	ConfigDir        string `json:"config_dir"`
	ConfigFile       string `json:"config_file"`
	ScrapDir         string `json:"scrap_dir"`
	TodayScrapPath   string `json:"today_scrap_path"`
	TodayScrapExists bool   `json:"today_scrap_exists"`
	InboxDir         string `json:"inbox_dir"`
	InboxEnabled     bool   `json:"inbox_enabled"`
	Autosave         bool   `json:"autosave"`
	GUIRunning       bool   `json:"gui_running"`
}

// flagErr turns the error of a quiet flag set into a command result: an undefined -h / -help asks
// for the command's usage (printed, exit 0), anything else is an error for main to print.
func (r *HeadlessRunner) flagErr(command string, err error) (int, error) {
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(r.stdout, SubcommandUsage(command))
		return 0, nil
	}
	return 1, err
}

func (r *HeadlessRunner) runInfo(args []string) (int, error) {
	fs := newQuietFlagSet("info")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("info", err)
	}
	if len(rest) > 0 {
		return 1, fmt.Errorf("info takes no arguments, got %q", rest[0])
	}

	cfg := LoadConfig()
	scrapDir := cfg.ScrapDirResolved()
	today := scrap.DailyPath(scrapDir, nowFunc())
	res := infoResult{
		Version:          r.version,
		ConfigDir:        cfg.Dir(),
		ConfigFile:       cfg.Path,
		ScrapDir:         scrapDir,
		TodayScrapPath:   today,
		TodayScrapExists: isRegularFile(today),
		InboxDir:         cfg.InboxDir(),
		InboxEnabled:     cfg.InboxEnabled(),
		Autosave:         cfg.AutoSave(),
		GUIRunning:       guiRunning(),
	}
	if res.Version == "" {
		res.Version = "unknown"
	}

	if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", res)
		return 0, nil
	}
	for _, kv := range [][2]string{
		{"version", res.Version},
		{"config_dir", res.ConfigDir},
		{"config_file", res.ConfigFile},
		{"scrap_dir", res.ScrapDir},
		{"today_scrap_path", res.TodayScrapPath},
		{"today_scrap_exists", fmt.Sprint(res.TodayScrapExists)},
		{"inbox_dir", res.InboxDir},
		{"inbox_enabled", fmt.Sprint(res.InboxEnabled)},
		{"autosave", fmt.Sprint(res.Autosave)},
		{"gui_running", fmt.Sprint(res.GUIRunning)},
	} {
		fmt.Fprintf(r.stdout, "%-19s %s\n", kv[0]+":", kv[1])
	}
	return 0, nil
}

func isRegularFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// guiRunning reports whether a live MD-Memo answers on the port recorded in ipc-session.json.
//
// It is ipc.LoadSession without its side effect: LoadSession deletes a session file it finds stale
// (dead pid, closed port), which is right for a command about to talk to the app but not for a
// question that must change nothing. So the file is only read, and the answer is "does something
// accept a connection on that port" - the same probe LoadSession ends with. The pid check LoadSession
// does first (a cheap shortcut) is not repeated: it is unexported and only saves the connect
// timeout. The token in the file is not kept and never printed.
func guiRunning() bool {
	data, err := os.ReadFile(ipc.GetSessionFilePath())
	if err != nil {
		return false
	}
	var s ipc.SessionInfo
	if json.Unmarshal(data, &s) != nil || s.Port <= 0 || s.Port > 65535 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", s.Port), 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
