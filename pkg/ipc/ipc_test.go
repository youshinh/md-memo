package ipc

import (
	"sync"
	"testing"
	"time"
)

func TestIPCSendAndReceive(t *testing.T) {
	port := 49155 // テスト用ポート

	var received *Message
	var wg sync.WaitGroup
	wg.Add(1)

	listener, err := StartListener(port, func(msg *Message) {
		received = msg
		wg.Done()
	})
	if err != nil {
		t.Fatalf("failed to start listener: %v", err)
	}
	defer listener.Close()

	sentMsg := &Message{
		Action:    "pipe",
		Content:   "error: line 42 crashed",
		Command:   "git diff",
		Cwd:       "C:\\Users\\test",
		Timestamp: time.Now().Format(time.RFC3339),
	}

	err = Send(port, sentMsg, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("failed to send IPC message: %v", err)
	}

	wg.Wait()

	if received == nil {
		t.Fatal("expected message to be received, got nil")
	}
	if received.Action != sentMsg.Action {
		t.Errorf("expected Action %q, got %q", sentMsg.Action, received.Action)
	}
	if received.Content != sentMsg.Content {
		t.Errorf("expected Content %q, got %q", sentMsg.Content, received.Content)
	}
	if received.Command != sentMsg.Command {
		t.Errorf("expected Command %q, got %q", sentMsg.Command, received.Command)
	}
	if received.Cwd != sentMsg.Cwd {
		t.Errorf("expected Cwd %q, got %q", sentMsg.Cwd, received.Cwd)
	}
}

func TestIPCSendTimeoutWhenNoListener(t *testing.T) {
	unusedPort := 49156
	msg := &Message{Action: "activate"}
	err := Send(unusedPort, msg, 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected error connecting to unused port, got nil")
	}
}

func TestIPCLargePayload(t *testing.T) {
	port := 49157

	var received *Message
	var wg sync.WaitGroup
	wg.Add(1)

	listener, err := StartListener(port, func(msg *Message) {
		received = msg
		wg.Done()
	})
	if err != nil {
		t.Fatalf("failed to start listener: %v", err)
	}
	defer listener.Close()

	// 2MBのログデータ
	largeText := make([]byte, 2*1024*1024)
	for i := range largeText {
		largeText[i] = 'a'
	}

	sentMsg := &Message{
		Action:  "pipe",
		Content: string(largeText),
		Command: "cat large.log",
	}

	err = Send(port, sentMsg, 2*time.Second)
	if err != nil {
		t.Fatalf("failed to send large IPC message: %v", err)
	}

	wg.Wait()

	if received == nil || len(received.Content) != len(sentMsg.Content) {
		t.Fatalf("expected large content to match length %d, got %v", len(sentMsg.Content), received)
	}
}
