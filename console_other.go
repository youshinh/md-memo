//go:build !windows

package main

func attachParentConsole() {
	// POSIX terminals automatically attach stdout/stderr
}

// systemDefaultCodepageSupportsJapaneseText: the Windows non-Unicode-codepage quirk this guards against
// (see console_windows.go) does not apply outside Windows.
func systemDefaultCodepageSupportsJapaneseText() bool {
	return false
}
