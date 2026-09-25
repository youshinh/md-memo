//go:build !windows

package slotagent

// platformLongPath: only Windows has short (8.3) names; the path is already the one to use.
func platformLongPath(path string) (string, error) {
	return path, nil
}
