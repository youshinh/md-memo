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
