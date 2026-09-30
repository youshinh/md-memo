//go:build windows && sysaudio_device

package sysaudio

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A check against the real sound devices of the machine, left out of the normal run (it needs an output device, plays a short
// system sound, and opens the microphone):
//
//	go test -tags sysaudio_device -run TestDevice -v ./pkg/sysaudio
func readSamples(t *testing.T, path string) []int16 {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]int16, (len(b)-44)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[44+i*2:]))
	}
	return out
}

func TestDeviceLoopbackHearsASystemSound(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRecorder(Options{Dir: dir, Prefix: "loop"}, []Source{NewSystemAudio()})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	time.Sleep(700 * time.Millisecond)
	play := exec.Command("powershell", "-NoProfile", "-Command", `(New-Object Media.SoundPlayer "$env:WINDIR\Media\Windows Notify System Generic.wav").PlaySync()`)
	if err := play.Run(); err != nil {
		t.Skipf("could not play a sound: %v", err)
	}
	time.Sleep(700 * time.Millisecond)
	res, err := r.Stop()
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) == 0 {
		t.Fatal("no file")
	}
	samples := readSamples(t, res.Files[0])
	t.Logf("recorded %.2f s, %d samples, warnings %v", res.Seconds, len(samples), res.Warnings)
	// level per half second
	win := SampleRate / 2
	loud := 0
	for i := 0; i+win <= len(samples); i += win {
		lv := Level(samples[i : i+win])
		t.Logf("  %.1f s: level %.4f", float64(i)/SampleRate, lv)
		if lv > 0.002 {
			loud++
		}
	}
	if loud == 0 {
		t.Fatalf("the loopback heard nothing while a system sound played (speakers muted or no output device?)")
	}
	_ = filepath.Base
}

func TestDeviceMicrophoneDelivers(t *testing.T) {
	r, err := NewRecorder(Options{Dir: t.TempDir(), Prefix: "mic"}, []Source{NewMicrophone()})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(); err != nil {
		t.Skipf("no usable microphone here: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	res, err := r.Stop()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("recorded %.2f s, warnings %v", res.Seconds, res.Warnings)
	if len(res.Warnings) != 0 {
		t.Fatalf("the microphone delivered nothing: %v", res.Warnings)
	}
	s := readSamples(t, res.Files[0])
	t.Logf("mic level %.5f over %d samples", Level(s), len(s))
}

func TestDeviceBothAtOnce(t *testing.T) {
	r, err := NewRecorder(Options{Dir: t.TempDir(), Prefix: "both"}, []Source{NewMicrophone(), NewSystemAudio()})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(); err != nil {
		t.Skipf("could not start both: %v", err)
	}
	time.Sleep(2 * time.Second)
	res, err := r.Stop()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("recorded %.2f s in %d file(s), warnings %v", res.Seconds, len(res.Files), res.Warnings)
	if res.Seconds < 1.5 || res.Seconds > 2.6 {
		t.Fatalf("the recording is %.2f s long for a 2 s wait", res.Seconds)
	}
}
