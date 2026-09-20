package dropzone

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestScanForTunnelURLFindsMatch(t *testing.T) {
	input := "some noise\n" +
		"INF Requesting new quick tunnel...\n" +
		"INF +--------------------------------------------------------------------------------------+\n" +
		"INF |  https://fake-tunnel-abc123.trycloudflare.com                                        |\n" +
		"INF +--------------------------------------------------------------------------------------+\n"
	url, err := scanForTunnelURL(strings.NewReader(input), time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if url != "https://fake-tunnel-abc123.trycloudflare.com" {
		t.Errorf("got %q", url)
	}
}

func TestScanForTunnelURLIgnoresTheCloudflareAPIHost(t *testing.T) {
	// cloudflared names its own API endpoint in error output; that is not a tunnel.
	apiLine := `ERR Failed to request quick Tunnel error="Post \"https://api.trycloudflare.com/tunnel\": dial tcp: lookup api.trycloudflare.com: no such host"` + "\n"

	if _, err := scanForTunnelURL(strings.NewReader(apiLine), time.Second); err == nil {
		t.Fatal("the API URL alone must not be mistaken for a tunnel URL")
	}

	both := apiLine + "INF |  https://real-tunnel-xyz.trycloudflare.com  |\n"
	url, err := scanForTunnelURL(strings.NewReader(both), time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if url != "https://real-tunnel-xyz.trycloudflare.com" {
		t.Errorf("got %q, want the real tunnel URL", url)
	}
}

func TestScanForTunnelURLNoMatchEOF(t *testing.T) {
	input := "nothing interesting here\nnope\n"
	_, err := scanForTunnelURL(strings.NewReader(input), time.Second)
	if err == nil {
		t.Fatal("expected an error when the stream ends with no match")
	}
}

func TestScanForTunnelURLTimeout(t *testing.T) {
	pr, pw := io.Pipe()
	t.Cleanup(func() {
		_ = pr.Close()
		_ = pw.Close()
	})
	start := time.Now()
	_, err := scanForTunnelURL(pr, 30*time.Millisecond)
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("scanForTunnelURL took too long to time out: %v", elapsed)
	}
}

func TestCloudflaredInstallHintNonEmpty(t *testing.T) {
	if CloudflaredInstallHint() == "" {
		t.Error("CloudflaredInstallHint() should never be empty")
	}
	// HasCloudflared must never panic regardless of whether the real
	// binary happens to be installed in the environment running the test.
	_ = HasCloudflared()
}

// stubCloudflaredForTest replaces the package-level cloudflared lookup and
// command construction with test doubles, restoring the originals on
// cleanup.
func stubCloudflaredForTest(t *testing.T, found bool, cmdFactory func(localURL string) *exec.Cmd) {
	t.Helper()
	origLookup, origCommand := lookupCloudflared, cloudflaredCommand
	lookupCloudflared = func() error {
		if found {
			return nil
		}
		return errors.New("cloudflared: not found (stub)")
	}
	if cmdFactory != nil {
		cloudflaredCommand = cmdFactory
	}
	t.Cleanup(func() {
		lookupCloudflared, cloudflaredCommand = origLookup, origCommand
	})
}

// fakeCloudflared returns a cloudflaredCommand replacement that re-executes
// this test binary as a stand-in process (see TestHelperProcess), so the tests
// need no shell and behave the same on Windows, macOS and Linux.
func fakeCloudflared(mode string) func(localURL string) *exec.Cmd {
	return func(string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperProcess$", "--", mode)
		cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
		return cmd
	}
}

// TestHelperProcess is not a real test: it is the body of the fake cloudflared
// processes started by fakeCloudflared.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	mode := os.Args[len(os.Args)-1]
	switch mode {
	case "print-url": // like the real thing: prints the URL, then runs until killed
		fmt.Fprintln(os.Stderr, "INF |  https://fake-tunnel-123.trycloudflare.com  |")
		time.Sleep(time.Minute)
	case "silent": // never establishes a tunnel
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func startedServer(t *testing.T, mutate func(*Server)) *Server {
	t.Helper()
	stubNetworkForTest(t)
	s := New(func(Payload) {})
	s.IdleTimeout = time.Minute
	s.TunnelStartTimeout = 3 * time.Second
	s.TunnelTimeout = time.Minute
	if mutate != nil {
		mutate(s)
	}
	if _, err := s.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	t.Cleanup(s.Stop)
	return s
}

func TestStartTunnelBeforeServerStarted(t *testing.T) {
	s := New(func(Payload) {})
	if _, err := s.StartTunnel(); err == nil {
		t.Fatal("expected an error calling StartTunnel before Start()")
	}
}

func TestStartTunnelMissingBinaryCanBeRetried(t *testing.T) {
	stubCloudflaredForTest(t, false, nil)
	s := startedServer(t, nil)

	for attempt := 1; attempt <= 2; attempt++ {
		_, err := s.StartTunnel()
		if !errors.Is(err, ErrCloudflaredNotFound) {
			t.Fatalf("attempt %d: expected ErrCloudflaredNotFound, got %v", attempt, err)
		}
	}
}

func TestStartTunnelSwitchesTimeoutAndKillsOnExpiry(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("print-url"))

	timedOut := make(chan struct{}, 1)
	s := startedServer(t, func(s *Server) {
		s.OnTimeout = func() { close(timedOut) }
		s.IdleTimeout = time.Minute // must NOT be what actually fires
		s.TunnelTimeout = 300 * time.Millisecond
	})

	s.mu.Lock()
	token := s.token
	s.mu.Unlock()

	pairingURL, err := s.StartTunnel()
	if err != nil {
		t.Fatalf("StartTunnel() failed: %v", err)
	}
	want := "https://fake-tunnel-123.trycloudflare.com/?token=" + token
	if pairingURL != want {
		t.Errorf("pairingURL = %q, want %q", pairingURL, want)
	}

	s.mu.Lock()
	hasTunnelCmd := s.tunnelCmd != nil
	s.mu.Unlock()
	if !hasTunnelCmd {
		t.Fatal("expected s.tunnelCmd to be set after a successful StartTunnel")
	}

	select {
	case <-timedOut:
	case <-time.After(3 * time.Second):
		t.Fatal("OnTimeout was never called — TunnelTimeout did not take effect")
	}

	s.mu.Lock()
	stillHasTunnelCmd := s.tunnelCmd != nil
	s.mu.Unlock()
	if stillHasTunnelCmd {
		t.Error("expected s.tunnelCmd to be cleared once the tunnel timeout fired")
	}
}

func TestActivityRearmsTheTunnelTimeoutNotTheLANOne(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("print-url"))
	s := startedServer(t, func(s *Server) {
		s.IdleTimeout = time.Minute
		s.TunnelTimeout = 5 * time.Minute
	})

	currentTimeout := func() time.Duration {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.currentTimeout
	}
	if got := currentTimeout(); got != time.Minute {
		t.Fatalf("before the tunnel, activity re-arms IdleTimeout: got %v", got)
	}

	if _, err := s.StartTunnel(); err != nil {
		t.Fatalf("StartTunnel() failed: %v", err)
	}
	// resetIdleTimer (run on every authenticated request) re-arms currentTimeout.
	if got := currentTimeout(); got != 5*time.Minute {
		t.Fatalf("after the tunnel came up, activity must re-arm the tunnel timeout: got %v", got)
	}

	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	rec := httptest.NewRecorder()
	s.handleIndex(rec, httptest.NewRequest(http.MethodGet, "/?token="+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("index: expected 200, got %d", rec.Code)
	}
}

func TestStartTunnelTwiceRejected(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("print-url"))
	s := startedServer(t, nil)

	if _, err := s.StartTunnel(); err != nil {
		t.Fatalf("first StartTunnel() failed: %v", err)
	}
	if _, err := s.StartTunnel(); err == nil {
		t.Fatal("expected the second StartTunnel() call to be rejected")
	}
}

func TestStartTunnelTimesOutWhenNoURLPrintedAndCanBeRetried(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("silent"))
	s := startedServer(t, func(s *Server) { s.TunnelStartTimeout = 150 * time.Millisecond })

	for attempt := 1; attempt <= 2; attempt++ {
		_, err := s.StartTunnel()
		if err == nil {
			t.Fatalf("attempt %d: expected StartTunnel() to time out when cloudflared prints no URL", attempt)
		}
		if strings.Contains(err.Error(), "already requested") {
			t.Fatalf("attempt %d: a failed attempt must not block the retry: %v", attempt, err)
		}

		s.mu.Lock()
		hasTunnelCmd := s.tunnelCmd != nil
		s.mu.Unlock()
		if hasTunnelCmd {
			t.Errorf("attempt %d: expected s.tunnelCmd to be cleared after a failed StartTunnel", attempt)
		}
	}
}

func TestStopWhileTheTunnelIsStartingAbortsIt(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("silent"))
	s := startedServer(t, func(s *Server) { s.TunnelStartTimeout = 30 * time.Second })

	errCh := make(chan error, 1)
	go func() {
		_, err := s.StartTunnel()
		errCh <- err
	}()

	// Wait until the process is registered, then cancel like closing the modal does.
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		registered := s.tunnelCmd != nil
		s.mu.Unlock()
		if registered {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cloudflared stand-in was never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.Stop()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("StartTunnel() should fail once the server is stopped")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("StartTunnel() kept waiting after Stop() (the process was not killed)")
	}
}

func TestStartTunnelAfterStopIsRejected(t *testing.T) {
	stubCloudflaredForTest(t, true, fakeCloudflared("print-url"))
	var started int32
	orig := cloudflaredCommand
	cloudflaredCommand = func(u string) *exec.Cmd {
		atomic.AddInt32(&started, 1)
		return orig(u)
	}
	s := startedServer(t, nil)
	s.Stop()

	if _, err := s.StartTunnel(); err == nil {
		t.Fatal("expected StartTunnel() on a stopped server to fail")
	}
	if atomic.LoadInt32(&started) != 0 {
		t.Error("no cloudflared process may be started for a stopped server")
	}
}
