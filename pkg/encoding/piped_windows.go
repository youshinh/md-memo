//go:build windows

package encoding

import "golang.org/x/sys/windows"

// pipedCodePage is the code page of the console the piped text came from: the console's output code page (what `chcp` shows, 932 on
// a Japanese Windows), or the system's non-Unicode code page when there is no console.
func pipedCodePage() int {
	if cp, err := windows.GetConsoleOutputCP(); err == nil && cp != 0 {
		return int(cp)
	}
	return int(windows.GetACP())
}
