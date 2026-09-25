// Package atomicfile writes a whole file so that a reader (or a crash) sees either the old file or
// the whole new one, never half of it.
package atomicfile

import (
	"os"
	"path/filepath"
)

// Write writes data to a temporary file in the folder of path and renames it over path.
//
// An existing file keeps its permission bits; a new one gets 0644 (the temporary file itself is
// created 0600). tmpPattern is the os.CreateTemp pattern of the temporary file (for example
// ".md-memo-save-*.tmp"): it lets the caller's leftovers be told apart. The folder must already
// exist: nothing is created. On any error the temporary file is removed and path is untouched.
func Write(path string, data []byte, tmpPattern string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), tmpPattern)
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	_ = os.Chmod(tmpName, mode)
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}
