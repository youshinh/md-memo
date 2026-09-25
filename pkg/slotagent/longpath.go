package slotagent

import "os"

// The unsaved note is handed to the agent as a temporary file. On Windows os.TempDir() can be a short (8.3) path
// (C:\Users\LONGNA~1\AppData\Local\Temp) when the user name is long: the same folder under a name Claude Code cannot allow-list
// (skills/md-memo/references/claude-code-integration.md, trap 6). The path handed to the agent, in {file}, in the note-path
// hint and as the working folder, is therefore the long form.

// expandLongPath turns a short (8.3) path into the long one; the file or folder must exist. It is a variable so the logic
// around it is tested without a volume that has 8.3 names (longpath_test.go); the Windows implementation calls
// GetLongPathName, elsewhere it changes nothing.
var expandLongPath = platformLongPath

// longPathOrSame is path in its long form. A failed expansion, an empty answer, or one that names no existing file leaves
// path as it is: the run never fails over this.
func longPathOrSame(path string) string {
	long, err := expandLongPath(path)
	if err != nil || long == "" || long == path {
		return path
	}
	if _, err := os.Stat(long); err != nil {
		return path
	}
	return long
}
