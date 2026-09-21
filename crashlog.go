package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"
)

// crashLogMaxBytes keeps crash.log from growing for ever: past it the file starts over.
const crashLogMaxBytes = 256 * 1024

// installCrashLog makes a fatal Go error (an unrecovered panic, "concurrent map writes", a stack overflow) leave its
// trace in <app data dir>/crash.log. The GUI build has no console, so without this the trace is thrown away and the app
// just disappears. A line per start goes in as well, so a trace can be placed within a run.
func installCrashLog() {
	dir, err := inputsAppDir()
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}
	path := filepath.Join(dir, "crash.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(path); err == nil && st.Size() > crashLogMaxBytes {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "--- start %s pid %d ---\n", time.Now().Format(time.RFC3339), os.Getpid())
	_ = debug.SetCrashOutput(f, debug.CrashOptions{})
	// SetCrashOutput duplicates the handle, so this one is no longer needed.
	_ = f.Close()
}
