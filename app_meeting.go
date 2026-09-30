package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/sysaudio"
)

// Meeting recording: the microphone and the sound this PC is playing (Zoom's other participants, a video) mixed into one
// recording, then transcribed. Windows only (pkg/sysaudio). The mix is written to disk in segments of a few minutes, so an
// hour-long meeting never has to sit in memory and each piece is small enough to send whole.

// meetingSegmentSeconds: four minutes of 16 kHz mono 16-bit audio are about 7.7 MB (10 MB as base64), well inside what the
// transcription services take in one request.
const meetingSegmentSeconds = 240

// meetingSubdir is under the voice cache folder.
const meetingSubdir = "meeting"

type meetingSession struct {
	rec     *sysaudio.Recorder
	reqID   string
	dir     string
	started time.Time
}

var meeting struct {
	mu sync.Mutex
	s  *meetingSession
}

// Seams for tests.
var (
	meetingNewSources = func(includeMic bool) []sysaudio.Source {
		var src []sysaudio.Source
		if includeMic {
			src = append(src, sysaudio.NewMicrophone())
		}
		return append(src, sysaudio.NewSystemAudio())
	}
	meetingSupported = sysaudio.Supported
)

// MeetingRecordingSupported tells the UI whether it can offer "also record the PC's sound".
func (a *App) MeetingRecordingSupported() bool { return meetingSupported() }

// CheckMeetingAudioAsync runs checkMeetingAudio in the background and answers through window.__onMeetingAudioCheck(reqID, json);
// a bound call that waited half a second would hold the window still.
func (a *App) CheckMeetingAudioAsync(reqID string) {
	go func() {
		defer func() { _ = recover() }()
		reqJSON, _ := json.Marshal(reqID)
		resJSON, _ := json.Marshal(checkMeetingAudio())
		a.dispatchEval(fmt.Sprintf("if (window.__onMeetingAudioCheck) { window.__onMeetingAudioCheck(%s, %s); }", reqJSON, resJSON))
	}()
}

// checkMeetingAudio opens the microphone and the PC-audio capture for half a second each (at the same time) and reports what
// happened, so a person can see in Settings that both work (and that the Zoom output they expect is the one being listened to).
// Returns JSON: {"supported":bool,"microphone":{"ok":bool,"error":"","level":0.01},"system":{...}}.
func checkMeetingAudio() string {
	type probe struct {
		OK    bool    `json:"ok"`
		Error string  `json:"error,omitempty"`
		Level float64 `json:"level"`
	}
	out := struct {
		Supported  bool  `json:"supported"`
		Microphone probe `json:"microphone"`
		System     probe `json:"system"`
	}{Supported: meetingSupported()}
	if out.Supported {
		run := func(src sysaudio.Source) probe {
			var mu sync.Mutex
			var samples []int16
			if err := src.Start(func(s []int16) {
				mu.Lock()
				if len(samples) < sysaudio.SampleRate*2 {
					samples = append(samples, s...)
				}
				mu.Unlock()
			}); err != nil {
				return probe{Error: err.Error()}
			}
			time.Sleep(500 * time.Millisecond)
			src.Stop()
			mu.Lock()
			defer mu.Unlock()
			return probe{OK: true, Level: sysaudio.Level(samples)}
		}
		srcs := meetingNewSources(true)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); out.Microphone = run(srcs[0]) }()
		go func() { defer wg.Done(); out.System = run(srcs[len(srcs)-1]) }()
		wg.Wait()
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// StartMeetingRecording starts mixing the PC's sound (and the microphone when includeMic) into a recording for reqID.
// Returns JSON {"microphone":bool,"system":bool}: which sources are really recording. A missing microphone does not stop the
// recording (the PC's sound is still worth having) but the caller tells the person; with no source at all it is an error.
func (a *App) StartMeetingRecording(reqID string, includeMic bool) (string, error) {
	if !meetingSupported() {
		return "", errors.New("PCの音の録音はWindowsでのみ使えます")
	}
	meeting.mu.Lock()
	defer meeting.mu.Unlock()
	if meeting.s != nil {
		return "", errors.New("すでに会議録音中です")
	}
	root, err := voiceCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, meetingSubdir)
	prefix := inputsNow().Format("2006-01-02-150405") + "_" + voiceCacheIDFromReqID(reqID)
	rec, err := sysaudio.NewRecorder(sysaudio.Options{Dir: dir, Prefix: prefix, SegmentSeconds: meetingSegmentSeconds}, meetingNewSources(includeMic))
	if err != nil {
		return "", err
	}
	if err := rec.Start(); err != nil {
		return "", fmt.Errorf("録音を始められませんでした: %w", err)
	}
	meeting.s = &meetingSession{rec: rec, reqID: reqID, dir: dir, started: time.Now()}
	live := map[string]bool{}
	for _, n := range rec.Started() {
		live[n] = true
	}
	b, _ := json.Marshal(map[string]bool{"microphone": live["microphone"], "system": live["PC audio"]})
	return string(b), nil
}

// takeMeeting removes and returns the running session (nil when none).
func takeMeeting(reqID string) *meetingSession {
	meeting.mu.Lock()
	defer meeting.mu.Unlock()
	s := meeting.s
	if s == nil || (reqID != "" && s.reqID != reqID) {
		return nil
	}
	meeting.s = nil
	return s
}

// AbortMeetingRecording throws the recording away (Esc, or closing while recording).
func (a *App) AbortMeetingRecording(reqID string) {
	if s := takeMeeting(reqID); s != nil {
		res, _ := s.rec.Stop()
		removeMeetingFiles(res.Files)
	}
}

// meetingShutdown stops a running recording when the app closes, so no sound device stays held.
func meetingShutdown() {
	if s := takeMeeting(""); s != nil {
		s.rec.Stop()
	}
}

func removeMeetingFiles(files []string) {
	for _, f := range files {
		os.Remove(f)
	}
	if len(files) > 0 {
		os.Remove(filepath.Dir(files[0])) // only succeeds when empty
	}
}

// StopMeetingRecordingAsync ends the recording and transcribes it piece by piece in the background; the text arrives through
// the same __onVoiceResult callback as a dictation (reqID). Nothing is refined: a meeting is not a line to be fitted.
// On success the recording is deleted; on a failure it is kept and the message says where.
func (a *App) StopMeetingRecordingAsync(reqID, voiceConfigJSON string) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				a.dispatchVoiceResult(reqID, "", fmt.Sprintf("文字起こし中に内部エラーが起きました: %v", r), "")
			}
		}()
		s := takeMeeting(reqID)
		if s == nil {
			a.dispatchVoiceResult(reqID, "", "会議録音は動いていません", "")
			return
		}
		res, err := s.rec.Stop()
		if err != nil {
			a.dispatchVoiceResult(reqID, "", fmt.Sprintf("録音の保存に失敗しました: %v", err), "")
			return
		}
		if res.Seconds < 1 || len(res.Files) == 0 {
			removeMeetingFiles(res.Files)
			a.dispatchVoiceResult(reqID, "", "", "") // too short: the UI says no speech was heard
			return
		}
		cfg := parseVoiceRequestConfig(voiceConfigJSON)
		text, err := transcribeMeetingFiles(res.Files, cfg)
		if atomic.LoadInt32(&a.isDestroyed) != 0 {
			return
		}
		if err != nil {
			a.dispatchVoiceResult(reqID, "", fmt.Sprintf("%v（録音は %s に残っています）", err, s.dir), "")
			return
		}
		removeMeetingFiles(res.Files)
		a.dispatchVoiceResultRefined(reqID, text, "", "", "")
	}()
}

// transcribeMeetingFiles sends the segments one after another and joins the text. A failing segment stops the run, so the
// person does not get a transcript with a hole in it that looks complete.
func transcribeMeetingFiles(files []string, cfg voiceRequestConfig) (string, error) {
	var parts []string
	for i, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			return "", fmt.Errorf("録音の読み込みに失敗しました: %w", err)
		}
		text, err := inputsQueryAudio(cfg.Prompt, base64.StdEncoding.EncodeToString(data), "audio/wav", cfg.VoiceConfig)
		if err != nil {
			return "", fmt.Errorf("文字起こしに失敗しました（%d/%d つ目の区間）: %w", i+1, len(files), err)
		}
		if t := strings.TrimSpace(text); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "\n\n"), nil
}
