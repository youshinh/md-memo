// Pure helpers for the macOS osascript dialogs (dialog_darwin.go). Split out of the
// darwin-only file, with no build tag, so the argv construction and result parsing are
// exercised by `go test` on every platform, including the Windows machine most development
// happens on.
package dialog

import "strings"

// Dialog kinds accepted by osascriptArgs.
const (
	kindOpenFile   = "file"
	kindSaveFile   = "save"
	kindOpenFolder = "folder"
)

// osascriptArgs builds the exact argv passed to the osascript binary for the given dialog
// kind. title and defaultName are always passed as separate argv elements - never
// interpolated into the AppleScript source - and the script reads them back with
// "item N of argv". This is what keeps a title or file name containing a double quote, a
// backslash, a newline, or literal AppleScript such as `" & do shell script "` from being
// able to break out of the script text: those characters only ever reach osascript as
// process argv, never as part of the string handed to `-e`.
func osascriptArgs(kind, title, defaultName string) []string {
	switch kind {
	case kindOpenFile:
		script := `on run argv
			return POSIX path of (choose file with prompt (item 1 of argv))
		end run`
		return []string{"-e", script, title}
	case kindSaveFile:
		script := `on run argv
			return POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv))
		end run`
		return []string{"-e", script, title, defaultName}
	case kindOpenFolder:
		script := `on run argv
			return POSIX path of (choose folder with prompt (item 1 of argv))
		end run`
		return []string{"-e", script, title}
	default:
		return nil
	}
}

// parseChooseResult turns osascript's raw stdout for one of the "choose ..." dialogs above
// into the path MD-Memo should use.
//
// Only the trailing newline(s) osascript itself appends when printing the script's return
// value ("\n" or "\r\n") are stripped, not all surrounding whitespace: the previous
// implementation used strings.TrimSpace on the same POSIX path output, which would also eat
// a leading or trailing space that is genuinely part of a file or folder name.
//
// When isFolder is true, one trailing "/" is stripped as well. AppleScript's
// "POSIX path of" always appends "/" for a folder, which Windows' folder picker never does;
// stripping it here keeps OpenFolderDialog's result shape identical across platforms. The
// filesystem root "/" is left as "/" rather than reduced to "".
func parseChooseResult(out string, isFolder bool) string {
	out = strings.TrimRight(out, "\r\n")
	if isFolder && len(out) > 1 && strings.HasSuffix(out, "/") {
		out = out[:len(out)-1]
	}
	return out
}
