package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOllamaSetupProgressJSON(t *testing.T) {
	prog := &OllamaSetupProgress{
		ReqID:   "req-123",
		Step:    2,
		Total:   5,
		Message: "Ollamaをインストール中...",
		IsDone:  false,
		Success: false,
		Error:   "",
	}

	data, err := json.Marshal(prog)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var decoded OllamaSetupProgress
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	if decoded.ReqID != prog.ReqID || decoded.Step != prog.Step || decoded.Message != prog.Message {
		t.Errorf("decoded struct does not match original: got %+v, want %+v", decoded, prog)
	}
}

func TestGetInstallOllamaCmdOS(t *testing.T) {
	cmd := getInstallOllamaCmdOS()
	if cmd == "" {
		t.Errorf("expected non-empty install command for platform")
	}
}

func TestCheckOllamaRunningWithMock(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"models":[]}`))
	}))
	defer mockServer.Close()

	// Direct check of App struct
	app := &App{}
	// When default 127.0.0.1:11434 is down (or up), method should return bool without panic
	_ = app.CheckOllamaRunning()

	// StopOllamaService should execute safely without crashing
	_ = app.StopOllamaService()
}
