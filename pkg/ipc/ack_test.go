package ipc

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"testing"
	"time"
)

// TestSend_AcknowledgedByRealServer is the happy path: a real md-memo server answers with the
// one-line ack, so Send reports success and main is entitled to exit.
func TestSend_AcknowledgedByRealServer(t *testing.T) {
	received := make(chan *Message, 1)
	srv, err := StartServer(0, nil, func(msg *Message) {
		received <- msg
	})
	if err != nil {
		t.Fatalf("StartServer failed: %v", err)
	}
	defer srv.Close()

	msg := &Message{Action: "pipe", Content: "hello", Command: "git diff"}
	if err := Send(srv.Port(), msg, 2*time.Second); err != nil {
		t.Fatalf("Send to a real server failed: %v", err)
	}

	select {
	case got := <-received:
		if got.Content != "hello" {
			t.Errorf("handler saw content %q, want %q", got.Content, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("legacy handler was never invoked")
	}
}

// TestSend_AckPrecedesSlowHandler pins the ordering decision: the ack must be written before
// the legacy handler runs, so a slow append cannot make a perfectly good handoff look like a
// dead peer and trigger a spurious cold start.
func TestSend_AckPrecedesSlowHandler(t *testing.T) {
	handlerEntered := make(chan struct{})
	release := make(chan struct{})

	srv, err := StartServer(0, nil, func(msg *Message) {
		close(handlerEntered)
		<-release
	})
	if err != nil {
		t.Fatalf("StartServer failed: %v", err)
	}
	defer srv.Close()
	defer close(release)

	done := make(chan error, 1)
	go func() {
		done <- Send(srv.Port(), &Message{Action: "activate"}, 2*time.Second)
	}()

	select {
	case <-handlerEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("handler was never entered")
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send failed while the handler was still running: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked on the handler instead of returning once acknowledged")
	}
}

// TestSend_PeerAcceptsButNeverAcks is the bug this ack exists for: some unrelated local
// service holds the port, accepts the connection and swallows the payload. Send must report
// an error so main falls through to a normal startup instead of exiting silently.
func TestSend_PeerAcceptsButNeverAcks(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				// Read (and discard) whatever arrives, but never reply.
				buf := make([]byte, 4096)
				for {
					if _, err := c.Read(buf); err != nil {
						_ = c.Close()
						return
					}
				}
			}(conn)
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	start := time.Now()
	err = Send(port, &Message{Action: "pipe", Content: "x"}, 300*time.Millisecond)
	if err == nil {
		t.Fatal("Send reported success against a peer that never acknowledged")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("Send took %v to give up; it must respect its timeout", elapsed)
	}
}

// TestSend_PeerRepliesWithGarbage covers a peer that does write something back, but is not
// md-memo.
func TestSend_PeerRepliesWithGarbage(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n')
		_, _ = conn.Write([]byte("HTTP/1.1 404 Not Found\r\n\r\n"))
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	if err := Send(port, &Message{Action: "activate"}, time.Second); err == nil {
		t.Fatal("Send accepted a non-md-memo reply as an acknowledgement")
	}
}

// TestLoadSession_DeadPIDSkipsNetworkProbe checks that a session file naming a PID that is not
// running is purged without any dialing at all. The port recorded here is one nothing is
// listening on, and the assertion is that we return quickly and delete the file.
func TestLoadSession_DeadPIDSkipsNetworkProbe(t *testing.T) {
	path := GetSessionFilePath()
	t.Cleanup(func() { _ = os.Remove(path) })

	// Spawn and reap a throwaway process so we have a PID that is definitely gone. Falling
	// back to a very high PID keeps the test meaningful if that is not possible.
	deadPID := findDeadPID(t)

	if err := SaveSession(&SessionInfo{PID: deadPID, Port: 49999, Token: "t", StartedAt: time.Now()}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	start := time.Now()
	info, err := LoadSession()
	elapsed := time.Since(start)

	if err == nil || info != nil {
		t.Fatalf("expected a stale session to be rejected, got info=%+v err=%v", info, err)
	}
	if elapsed > 150*time.Millisecond {
		t.Errorf("LoadSession took %v: the network probe was not skipped for a dead PID", elapsed)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("stale session file was not removed (stat err = %v)", statErr)
	}
}

// TestProcessAlive_SelfAndDead sanity-checks the per-OS liveness helper.
func TestProcessAlive_SelfAndDead(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("processAlive(self) = false")
	}
	if processAlive(0) {
		t.Error("processAlive(0) = true")
	}
	if processAlive(-1) {
		t.Error("processAlive(-1) = true")
	}
	if pid := findDeadPID(t); processAlive(pid) {
		t.Errorf("processAlive(%d) = true for a reaped process", pid)
	}
}

// findDeadPID returns a PID that is known not to be running.
func findDeadPID(t *testing.T) int {
	t.Helper()
	// A PID well above the default maximum on every supported platform, and above the
	// Windows 32-bit PID space in practice. Verified not alive before use.
	for _, candidate := range []int{0x7FFFFFF0, 0x7FFFFF00, 4194300} {
		if !processAlive(candidate) {
			return candidate
		}
	}
	t.Skip("could not find a PID that is reliably not running on this machine")
	return 0
}

// TestLegacyAckShape documents the wire format, so a future change to it is a deliberate one.
func TestLegacyAckShape(t *testing.T) {
	var buf writerFunc
	writeLegacyAck(&buf, true, "")
	var ack legacyAck
	if err := json.Unmarshal(buf.trimmed(), &ack); err != nil {
		t.Fatalf("ack is not valid JSON: %v (%q)", err, buf.data)
	}
	if !ack.OK || ack.App != legacyAckApp {
		t.Errorf("ack = %+v, want ok=true app=%q", ack, legacyAckApp)
	}
}

type writerFunc struct{ data []byte }

func (w *writerFunc) Write(p []byte) (int, error) {
	w.data = append(w.data, p...)
	return len(p), nil
}

func (w *writerFunc) trimmed() []byte {
	if n := len(w.data); n > 0 && w.data[n-1] == '\n' {
		return w.data[:n-1]
	}
	return w.data
}
