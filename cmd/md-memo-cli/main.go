// Command md-memo-cli is the console-subsystem twin of md-memo.exe.
//
// The release build of md-memo.exe is a GUI-subsystem program (-H windowsgui, so that starting it
// from Explorer opens no console window). PowerShell does not wait for such a program, and its
// exit code and standard output are unreliable under PowerShell, cmd and CI. md-memo-cli.exe
// sits next to it in the Windows zip, runs every command line command through the same code
// (pkg/cli) and, being a console program, is waited for, returns the real exit code and hands its
// output to whatever captures it. It never starts the GUI.
//
// It imports only pkg/cli and pkg/ipc: no window, WebView or cgo code, so it also builds on macOS
// and Linux (CI compiles it everywhere).
package main

import (
	"os"
)

// version is the app version. The release build sets it with
//
//	go build -ldflags "-X main.version=1.8.1" ./cmd/md-memo-cli
//
// (AppVersion, the constant build_mac.sh reads, lives in the GUI's package main and cannot be
// imported). A build without the flag says "dev".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], version, systemEnv()))
}
