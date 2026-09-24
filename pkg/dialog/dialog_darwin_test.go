//go:build darwin

package dialog

import (
	"bytes"
	"os/exec"
	"testing"
)

// TestOsascriptRoundTripsArgv is the one part of the injection-safety story that
// osascript_test.go cannot cover on its own: it proves that osascript really does hand argv
// elements back to the script unmodified (as "item N of argv"), for the same kind of nasty
// strings osascriptArgs is tested against in osascript_test.go. It opens no dialog - "on run
// argv" / "return item 1 of argv" only echoes back what it was given - so it is safe to run
// unattended on the CI macOS runner. It never runs on the Windows development machine because
// of the darwin build tag, and it skips itself if osascript is not on PATH.
func TestOsascriptRoundTripsArgv(t *testing.T) {
	if _, err := exec.LookPath("osascript"); err != nil {
		t.Skip("osascript not on PATH")
	}

	for _, nasty := range nastyInputs {
		t.Run(nasty, func(t *testing.T) {
			cmd := exec.Command("osascript",
				"-e", "on run argv",
				"-e", "return item 1 of argv",
				"-e", "end run",
				"--", nasty,
			)
			var out, stderr bytes.Buffer
			cmd.Stdout = &out
			cmd.Stderr = &stderr
			if err := cmd.Run(); err != nil {
				t.Fatalf("osascript round-trip failed: %v, stderr=%s", err, stderr.String())
			}
			got := parseChooseResult(out.String(), false)
			if got != nasty {
				t.Fatalf("osascript round-trip = %q, want %q (stderr=%s)", got, nasty, stderr.String())
			}
		})
	}
}
