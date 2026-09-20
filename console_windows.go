//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

var (
	modKernel32Console = windows.NewLazySystemDLL("kernel32.dll")
	procAttachConsole  = modKernel32Console.NewProc("AttachConsole")
)

const attachParentProcess = ^uintptr(0) // (DWORD)-1

// systemDefaultCodepageSupportsJapaneseText reports whether this Windows install's system-wide default
// codepage (GetACP(), Control Panel > Region > Administrative > "Language for non-Unicode
// programs") can round-trip Japanese text through legacy console text I/O: either the classic
// Japanese codepage (932 / Shift_JIS), or 65001 (the "Beta: Use Unicode UTF-8 for worldwide
// language support" system-wide setting some Windows installs opt into).
//
// This matters because cmd.exe/PowerShell built-ins such as `echo`, when their output has been
// redirected to a pipe (as every command this app runs is, since RunCommandFilter captures
// stdout), encode text using this system-wide default rather than anything `chcp` sets for the
// (possibly hidden, CREATE_NO_WINDOW) console: `chcp` changes the console DEVICE's codepage,
// but pipe-redirected output from console built-ins is not going to a console device, so it
// falls back to GetACP() regardless of any chcp call. On a Windows install whose system default
// is neither of the above (e.g. the CP1252/CP437 default on an unmodified en-US install), such
// text is replaced with '?' before this app ever sees the bytes; no amount of chcp or encoding
// trickery on our side can recover characters that were already lost at that point. Empirically
// confirmed: a machine with the "Unicode UTF-8" system setting enabled reports GetACP()==65001,
// not 932, yet round-trips Japanese text through this exact path correctly. Some
// cli_filter_test.go cases require one of these two system defaults for this reason and use
// this check to skip cleanly on any other configuration (e.g. GitHub's Windows CI runners,
// which use the unmodified default) instead of failing on this pre-existing, OS-configuration-
// coupled limitation, unrelated to anything else in this codebase.
func systemDefaultCodepageSupportsJapaneseText() bool {
	acp := windows.GetACP()
	return acp == 932 || acp == 65001
}

func attachParentConsole() {
	// If output is already redirected/piped (e.g. | Out-String, | jq), preserve pipe handle!
	stat, err := os.Stdout.Stat()
	if err == nil && (stat.Mode()&os.ModeCharDevice) == 0 {
		return
	}

	// If executed from a console/terminal (CMD, PowerShell), attach to parent console
	r, _, _ := procAttachConsole.Call(attachParentProcess)
	if r != 0 {
		stdoutHandle, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
		if err == nil && stdoutHandle != 0 && stdoutHandle != windows.InvalidHandle {
			os.Stdout = os.NewFile(uintptr(stdoutHandle), "/dev/stdout")
		}
		stderrHandle, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
		if err == nil && stderrHandle != 0 && stderrHandle != windows.InvalidHandle {
			os.Stderr = os.NewFile(uintptr(stderrHandle), "/dev/stderr")
		}
	}
}
