//go:build windows

package slotagent

import "golang.org/x/sys/windows"

// platformLongPath is GetLongPathName: the long form of a short (8.3) path, with the case of the names on disk. The path
// must exist.
func platformLongPath(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	buf := make([]uint16, windows.MAX_PATH)
	for {
		n, err := windows.GetLongPathName(p, &buf[0], uint32(len(buf)))
		if err != nil {
			return "", err
		}
		if int(n) <= len(buf) {
			return windows.UTF16ToString(buf[:n]), nil // n: characters copied, without the terminating NUL
		}
		buf = make([]uint16, n) // too small: n is the size needed, with the NUL
	}
}
