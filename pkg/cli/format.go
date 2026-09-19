package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// IsTerminal returns true if the specified file descriptor is a terminal (TTY).
func IsTerminal(f *os.File) bool {
	stat, err := f.Stat()
	if err != nil {
		return false
	}
	return (stat.Mode() & os.ModeCharDevice) != 0
}

// IsStdoutTerminal returns true if os.Stdout is attached to a terminal.
func IsStdoutTerminal() bool {
	return IsTerminal(os.Stdout)
}

// OutputFormat determines whether to format output as JSON or human-readable text.
type OutputFormat string

const (
	FormatText OutputFormat = "text"
	FormatJSON OutputFormat = "json"
)

// ResolveFormat determines the output format based on flags and terminal status.
func ResolveFormat(forceJSON bool) OutputFormat {
	return ResolveFormatCustom(forceJSON, false, IsStdoutTerminal())
}

// ResolveFormatCustom allows custom overrides for testing or explicit text mode.
func ResolveFormatCustom(forceJSON, forceText, isTerminal bool) OutputFormat {
	if forceJSON {
		return FormatJSON
	}
	if forceText {
		return FormatText
	}
	if !isTerminal {
		return FormatJSON
	}
	return FormatText
}

// PrintFormatted outputs either structured JSON or human-readable text to w.
func PrintFormatted(w io.Writer, format OutputFormat, textVal string, dataVal interface{}) {
	if format == FormatJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(dataVal)
		return
	}

	// Human-readable text format
	if textVal != "" {
		fmt.Fprintln(w, textVal)
	} else {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(dataVal)
	}
}
