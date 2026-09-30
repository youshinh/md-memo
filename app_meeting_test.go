package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"md-memo/pkg/llm"
	"md-memo/pkg/sysaudio"
)

// No sound device is touched: the sources are fakes that push a constant, and transcription is stubbed.

type fakeMeetingSource struct {
	name   string
	expect bool
	level  int16
	fail   error
	mu     sync.Mutex
	push   func([]int16)
	stop   chan struct{}
}

func (f *fakeMeetingSource) Name() string      { return f.name }
func (f *fakeMeetingSource) ExpectAudio() bool { return f.expect }
func (f *fakeMeetingSource) Start(push func([]int16)) error {
	if f.fail != nil {
		return f.fail
	}
	f.stop = make(chan struct{})
	go func() {
		t := time.NewTicker(20 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-f.stop:
				return
			case <-t.C:
				b := make([]int16, sysaudio.SampleRate/50) // 20 ms
				for i := range b {
					b[i] = f.level
				}
				push(b)
			}
		}
	}()
	return nil
}
func (f *fakeMeetingSource) Stop() {
	if f.stop != nil {
		close(f.stop)
		f.stop = nil
	}
}

func withFakeMeeting(t *testing.T, mic, system *fakeMeetingSource) {
	t.Helper()
	origSrc, origSup := meetingNewSources, meetingSupported
	meetingSupported = func() bool { return true }
	meetingNewSources = func(includeMic bool) []sysaudio.Source {
		var out []sysaudio.Source
		if includeMic {
			out = append(out, mic)
		}
		return append(out, system)
	}
	t.Cleanup(func() {
		meetingNewSources, meetingSupported = origSrc, origSup
		meetingShutdown()
	})
}

func TestStartMeetingRecordingReportsWhichSourcesRun(t *testing.T) {
	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", expect: true, fail: errors.New("no microphone")}, &fakeMeetingSource{name: "PC audio", level: 500})
	app := &App{}
	res, err := app.StartMeetingRecording("voice_a1", true)
	if err != nil {
		t.Fatalf("one working source is enough: %v", err)
	}
	var got map[string]bool
	if err := json.Unmarshal([]byte(res), &got); err != nil {
		t.Fatal(err)
	}
	if got["microphone"] || !got["system"] {
		t.Fatalf("expected only the PC audio to be recording, got %v", got)
	}
	if _, err := app.StartMeetingRecording("voice_a2", true); err == nil {
		t.Fatal("a second recording at the same time must be refused")
	}
	app.AbortMeetingRecording("voice_a1")
	if _, err := app.StartMeetingRecording("voice_a3", false); err != nil {
		t.Fatalf("after an abort a new recording can start: %v", err)
	}
}

func TestStartMeetingRecordingUnsupportedAndNoSource(t *testing.T) {
	orig := meetingSupported
	meetingSupported = func() bool { return false }
	t.Cleanup(func() { meetingSupported = orig })
	if _, err := (&App{}).StartMeetingRecording("x", true); err == nil {
		t.Fatal("unsupported systems must say so")
	}
	if (&App{}).MeetingRecordingSupported() {
		t.Fatal("MeetingRecordingSupported must follow the platform")
	}

	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", fail: errors.New("x")}, &fakeMeetingSource{name: "PC audio", fail: errors.New("no output")})
	if _, err := (&App{}).StartMeetingRecording("y", true); err == nil {
		t.Fatal("with no source at all the recording must not start")
	}
}

func TestStopMeetingRecordingTranscribesSegmentsInOrderAndDeletesTheFiles(t *testing.T) {
	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", expect: true, level: 300}, &fakeMeetingSource{name: "PC audio", level: 200})
	var mu sync.Mutex
	var sent []int
	var mimes []string
	withStubbedQueryAudio(t, func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error) {
		raw, err := base64.StdEncoding.DecodeString(audioBase64)
		if err != nil {
			return "", err
		}
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, len(raw))
		mimes = append(mimes, mimeType)
		if string(raw[:4]) != "RIFF" {
			t.Errorf("a WAV file must be sent, got %q", raw[:4])
		}
		return "piece " + string(rune('0'+len(sent))), nil
	})
	mock := &voiceMockWebView{}
	app := &App{w: mock}
	if _, err := app.StartMeetingRecording("voice_b1", true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1600 * time.Millisecond) // a recording of about 1.2 s once the hold-back is out
	app.StopMeetingRecordingAsync("voice_b1", `{"prompt":"go"}`)
	eval := mock.waitFor(t, "__onVoiceResult", 10*time.Second)
	if !strings.Contains(eval, "voice_b1") || !strings.Contains(eval, "piece 1") {
		t.Fatalf("unexpected result: %s", eval)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 || mimes[0] != "audio/wav" {
		t.Fatalf("sent %v with mime %v", sent, mimes)
	}
	root, _ := voiceCacheDir()
	if entries, err := os.ReadDir(root + string(os.PathSeparator) + meetingSubdir); err == nil && len(entries) != 0 {
		t.Fatalf("the recording must be deleted after a successful transcription, left: %v", entries)
	}
	// nothing is running any more
	if _, err := app.StartMeetingRecording("voice_b2", false); err != nil {
		t.Fatalf("a new recording can start after a stop: %v", err)
	}
	app.AbortMeetingRecording("")
}

func TestStopMeetingRecordingKeepsTheFilesWhenTranscriptionFails(t *testing.T) {
	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", expect: true, level: 300}, &fakeMeetingSource{name: "PC audio", level: 200})
	withStubbedQueryAudio(t, func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error) {
		return "", errors.New("quota exceeded")
	})
	mock := &voiceMockWebView{}
	app := &App{w: mock}
	if _, err := app.StartMeetingRecording("voice_c1", true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1600 * time.Millisecond)
	app.StopMeetingRecordingAsync("voice_c1", "{}")
	eval := mock.waitFor(t, "__onVoiceResult", 10*time.Second)
	if !strings.Contains(eval, "quota exceeded") || !strings.Contains(eval, "残っています") {
		t.Fatalf("the error must say why and where the recording is: %s", eval)
	}
	root, _ := voiceCacheDir()
	entries, err := os.ReadDir(root + string(os.PathSeparator) + meetingSubdir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("the recording must be kept on a failure: %v %v", entries, err)
	}
	for _, e := range entries {
		os.Remove(root + string(os.PathSeparator) + meetingSubdir + string(os.PathSeparator) + e.Name())
	}
}

func TestStopMeetingRecordingWithoutARecordingAnswersWithAnError(t *testing.T) {
	mock := &voiceMockWebView{}
	app := &App{w: mock}
	app.StopMeetingRecordingAsync("voice_none", "{}")
	eval := mock.waitFor(t, "__onVoiceResult", 5*time.Second)
	if !strings.Contains(eval, "動いていません") {
		t.Fatalf("unexpected: %s", eval)
	}
}

func TestCheckMeetingAudioReportsBothSources(t *testing.T) {
	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", expect: true, level: 1000}, &fakeMeetingSource{name: "PC audio", fail: errors.New("no output device")})
	var got struct {
		Supported  bool
		Microphone struct {
			OK    bool
			Error string
			Level float64
		}
		System struct {
			OK    bool
			Error string
		}
	}
	if err := json.Unmarshal([]byte(checkMeetingAudio()), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Supported || !got.Microphone.OK || got.Microphone.Level <= 0 {
		t.Fatalf("the microphone should report ok with a level: %+v", got)
	}
	if got.System.OK || !strings.Contains(got.System.Error, "no output device") {
		t.Fatalf("the PC audio failure should be reported: %+v", got.System)
	}
}

func TestCheckMeetingAudioAsyncAnswersThePage(t *testing.T) {
	withFakeMeeting(t, &fakeMeetingSource{name: "microphone", expect: true, level: 1000}, &fakeMeetingSource{name: "PC audio", level: 1})
	mock := &voiceMockWebView{}
	(&App{w: mock}).CheckMeetingAudioAsync("chk_1")
	eval := mock.waitFor(t, "__onMeetingAudioCheck", 5*time.Second)
	if !strings.Contains(eval, "chk_1") || !strings.Contains(eval, "microphone") {
		t.Fatalf("unexpected: %s", eval)
	}
}
