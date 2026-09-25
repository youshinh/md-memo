package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"md-memo/pkg/ipc"
)

// ClientRunner handles CLI subcommands sent to a running md-memo instance via JSON-RPC.
type ClientRunner struct {
	session *ipc.SessionInfo
	stdout  io.Writer
	stderr  io.Writer
}

// NewClientRunner creates a new ClientRunner.
func NewClientRunner(session *ipc.SessionInfo, stdout, stderr io.Writer) *ClientRunner {
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}
	return &ClientRunner{
		session: session,
		stdout:  stdout,
		stderr:  stderr,
	}
}

// Run executes the command against the running instance.
func (c *ClientRunner) Run(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("subcommand required: " + strings.Join(CommandNames(false), ", "))
	}

	cmd := args[0]
	subargs := args[1:]

	// The commands that need the running app are listed in registry.go.
	if entry := findCommand(cmd); entry != nil && entry.app != nil {
		return entry.app(c, subargs)
	}
	return 1, fmt.Errorf("unknown subcommand: %s", cmd)
}

func (c *ClientRunner) runBuffer(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("buffer subcommand required: get, set, append, replace, or replace-selection")
	}

	action := args[0]
	rest := args[1:]

	fs := flag.NewFlagSet("buffer "+action, flag.ContinueOnError)
	fs.SetOutput(c.stderr)
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	tabID := fs.String("tab", "", "Target tab ID (default active)")

	switch action {
	case "get":
		selection := fs.Bool("selection", false, "Print only the currently selected text")
		out := fs.String("out", "", "Write the text to this file (UTF-8) instead of printing it")
		bom := fs.Bool("bom", false, "With --out: start the file with a UTF-8 byte order mark")
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		outSet := false
		fs.Visit(func(f *flag.Flag) { outSet = outSet || f.Name == "out" })
		if outSet && *out == "" {
			return 1, errors.New("--out needs a file path")
		}
		if *bom && !outSet {
			return 1, errors.New("--bom only applies together with --out")
		}
		outPath := ""
		if outSet {
			// Checked before asking the app anything: a bad path should fail at once.
			var err error
			if outPath, err = resolveOutPath(*out); err != nil {
				return 1, err
			}
		}

		if *selection {
			var sel ipc.SelectionInfo
			params := map[string]string{"tab_id": *tabID}
			if err := ipc.CallRPC(c.session, "buffer.get_selection", params, &sel, 3*time.Second); err != nil {
				return mapSelectionError(err)
			}

			format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
			if outSet {
				return c.writeBufferOut(outPath, sel.Text, "", nil, *bom, format)
			}
			if format == FormatJSON {
				PrintFormatted(c.stdout, FormatJSON, "", map[string]interface{}{
					"text":  sel.Text,
					"start": sel.Start,
					"end":   sel.End,
				})
			} else {
				fmt.Fprint(c.stdout, sel.Text)
			}
			return 0, nil
		}

		var info ipc.BufferInfo
		params := map[string]string{"tab_id": *tabID}
		if err := ipc.CallRPC(c.session, "buffer.get", params, &info, 3*time.Second); err != nil {
			return 1, err
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if outSet {
			gen := info.Generation
			return c.writeBufferOut(outPath, info.Content, info.Hash, &gen, *bom, format)
		}
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", info)
		} else {
			fmt.Fprint(c.stdout, info.Content)
		}
		return 0, nil

	case "set":
		expectedHash := fs.String("expected-hash", "", "Verify expected SHA-256 hash before replacing")
		expectedGen := fs.Uint64("expected-gen", 0, "Verify expected generation before replacing")
		if err := fs.Parse(sanitizeArgsForFlags(fs, rest)); err != nil {
			return 1, err
		}

		content := readRemainingInput(fs.Args())
		params := ipc.BufferSetParams{
			TabID:              *tabID,
			Content:            content,
			ExpectedHash:       *expectedHash,
			ExpectedGeneration: *expectedGen,
		}

		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "buffer.set", params, &res, 3*time.Second); err != nil {
			return 1, err
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", res)
		} else {
			fmt.Fprintf(c.stdout, "Buffer updated (Generation: %v, Hash: %v)\n", res["generation"], res["hash"])
		}
		return 0, nil

	case "append":
		if err := fs.Parse(sanitizeArgsForFlags(fs, rest)); err != nil {
			return 1, err
		}

		content := readRemainingInput(fs.Args())
		params := map[string]string{
			"content": content,
			"tab_id":  *tabID,
		}

		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "buffer.append", params, &res, 3*time.Second); err != nil {
			return 1, err
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", res)
		} else {
			fmt.Fprintln(c.stdout, "Content appended to buffer")
		}
		return 0, nil

	case "replace":
		start := fs.String("start", "1:1", "Start position line:col (1-indexed)")
		end := fs.String("end", "1:1", "End position line:col (1-indexed)")
		expectedHash := fs.String("expected-hash", "", "Verify expected SHA-256 hash")
		if err := fs.Parse(sanitizeArgsForFlags(fs, rest)); err != nil {
			return 1, err
		}

		sLine, sCol := parseLineCol(*start)
		eLine, eCol := parseLineCol(*end)
		content := readRemainingInput(fs.Args())

		params := ipc.BufferReplaceParams{
			TabID:        *tabID,
			StartLine:    sLine,
			StartCol:     sCol,
			EndLine:      eLine,
			EndCol:       eCol,
			Content:      content,
			ExpectedHash: *expectedHash,
		}

		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "buffer.replace", params, &res, 3*time.Second); err != nil {
			return 1, err
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", res)
		} else {
			fmt.Fprintf(c.stdout, "Range replaced (New Generation: %v)\n", res["generation"])
		}
		return 0, nil

	case "replace-selection":
		if err := fs.Parse(sanitizeArgsForFlags(fs, rest)); err != nil {
			return 1, err
		}

		content := normalizeCRLF(readRemainingInput(fs.Args()))
		params := ipc.ReplaceSelectionParams{
			TabID:   *tabID,
			Content: content,
		}

		var res ipc.ReplaceSelectionResult
		if err := ipc.CallRPC(c.session, "buffer.replace_selection", params, &res, 3*time.Second); err != nil {
			return mapSelectionError(err)
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", res)
		} else {
			fmt.Fprintf(c.stdout, "Selection replaced (New Generation: %v)\n", res.Generation)
		}
		return 0, nil

	default:
		return 1, fmt.Errorf("unknown buffer action: %s", action)
	}
}

// mapSelectionError turns an RPCError with ErrCodeNoSelection into the plain, machine-checked
// "no active selection" message the CLI spec requires on stderr, and exit code 1 either way.
func mapSelectionError(err error) (int, error) {
	var rpcErr *ipc.RPCError
	if errors.As(err, &rpcErr) && rpcErr.Code == ipc.ErrCodeNoSelection {
		return 1, errors.New("no active selection")
	}
	return 1, err
}

// normalizeCRLF converts CRLF/CR line endings to LF; the editor's textarea stores LF only, and
// stdin piped from Windows tools commonly carries CRLF.
func normalizeCRLF(s string) string {
	if !strings.Contains(s, "\r") {
		return s
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

func (c *ClientRunner) runTab(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("tab subcommand required: list, switch, new, or close")
	}

	action := args[0]
	rest := args[1:]

	fs := flag.NewFlagSet("tab "+action, flag.ContinueOnError)
	fs.SetOutput(c.stderr)
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")

	switch action {
	case "list":
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}

		var tabs []map[string]interface{}
		if err := ipc.CallRPC(c.session, "tab.list", nil, &tabs, 3*time.Second); err != nil {
			return 1, err
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal())
		if format == FormatJSON {
			PrintFormatted(c.stdout, FormatJSON, "", tabs)
		} else {
			fmt.Fprintln(c.stdout, "Open Tabs:")
			for _, tab := range tabs {
				activeMarker := " "
				if isActive, _ := tab["isActive"].(bool); isActive {
					activeMarker = "*"
				}
				fmt.Fprintf(c.stdout, " %s [%v] %s (%s)\n", activeMarker, tab["id"], tab["title"], tab["path"])
			}
		}
		return 0, nil

	case "switch":
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		tabID := strings.Join(fs.Args(), " ")
		if tabID == "" {
			return 1, errors.New("tab ID required for tab switch")
		}

		params := map[string]string{"tab_id": tabID}
		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "tab.switch", params, &res, 3*time.Second); err != nil {
			return 1, err
		}
		fmt.Fprintf(c.stdout, "Switched to tab: %s\n", tabID)
		return 0, nil

	default:
		return 1, fmt.Errorf("unknown tab action: %s", action)
	}
}

func (c *ClientRunner) runUI(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("ui subcommand required: activate, toggle-split, or eval")
	}

	action := args[0]
	rest := args[1:]

	switch action {
	case "activate":
		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "ui.activate", nil, &res, 3*time.Second); err != nil {
			return 1, err
		}
		fmt.Fprintln(c.stdout, "Window activated")
		return 0, nil

	case "toggle-split":
		var res map[string]interface{}
		if err := ipc.CallRPC(c.session, "ui.toggle_split", nil, &res, 3*time.Second); err != nil {
			return 1, err
		}
		fmt.Fprintln(c.stdout, "Split view toggled")
		return 0, nil

	case "eval":
		expr := strings.Join(rest, " ")
		if expr == "" {
			return 1, errors.New("expression required for ui eval")
		}
		params := map[string]string{"expression": expr}
		var res string
		if err := ipc.CallRPC(c.session, "ui.eval", params, &res, 3*time.Second); err != nil {
			return 1, err
		}
		fmt.Fprintln(c.stdout, res)
		return 0, nil

	default:
		return 1, fmt.Errorf("unknown ui action: %s", action)
	}
}

func readRemainingInput(args []string) string {
	if len(args) > 0 {
		return strings.Join(args, " ")
	}
	// Try reading from stdin
	stat, err := os.Stdin.Stat()
	if err == nil && (stat.Mode()&os.ModeCharDevice) == 0 {
		data, _ := io.ReadAll(os.Stdin)
		return string(data)
	}
	return ""
}

func parseLineCol(s string) (int, int) {
	parts := strings.Split(s, ":")
	line, col := 1, 1
	if len(parts) >= 1 {
		if v, err := strconv.Atoi(parts[0]); err == nil && v > 0 {
			line = v
		}
	}
	if len(parts) >= 2 {
		if v, err := strconv.Atoi(parts[1]); err == nil && v > 0 {
			col = v
		}
	}
	return line, col
}

// sanitizeArgsForFlags inserts "--" before the first non-flag argument starting with "-" (e.g. Markdown "- [ ]")
func sanitizeArgsForFlags(fs *flag.FlagSet, args []string) []string {
	var sanitized []string
	flagEndInserted := false
	for _, arg := range args {
		if !flagEndInserted && strings.HasPrefix(arg, "-") && arg != "-" && arg != "--" {
			flagName := strings.TrimLeft(arg, "-")
			if eqIdx := strings.Index(flagName, "="); eqIdx != -1 {
				flagName = flagName[:eqIdx]
			}
			if fs.Lookup(flagName) == nil {
				// Not a known flag; insert "--" so flag.Parse treats it as positional argument
				sanitized = append(sanitized, "--")
				flagEndInserted = true
			}
		}
		sanitized = append(sanitized, arg)
	}
	return sanitized
}
