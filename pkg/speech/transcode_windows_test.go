//go:build windows

package speech

import (
	"strings"
	"testing"
)

func TestTranscodeScriptIsASCII(t *testing.T) {
	// powershell.exe reads a BOM-less script file as the ANSI code page
	for i := 0; i < len(transcodeScript); i++ {
		if transcodeScript[i] >= 0x80 {
			t.Fatalf("non-ASCII byte 0x%x at offset %d", transcodeScript[i], i)
		}
	}
	for _, want := range []string{"param([string]$InPath, [string]$OutPath)", "CreateWav", "CanTranscode", "exit 2"} {
		if !strings.Contains(transcodeScript, want) {
			t.Errorf("script lacks %q", want)
		}
	}
	if strings.Contains(transcodeScript, "SampleRate") {
		t.Error("asking the transcoder for 16 kHz mono makes CanTranscode false; resample in Go instead")
	}
}
