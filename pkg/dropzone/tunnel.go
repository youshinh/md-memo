package dropzone

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"md-memo/pkg/procutil"
)

// DefaultTunnelTimeout is how long an externally-exposed (Cloudflare Quick
// Tunnel) Mobile Drop session stays open before it is force-closed,
// counted from the moment the tunnel URL becomes available — separate
// from (and normally longer than) the plain-LAN IdleTimeout.
const DefaultTunnelTimeout = 90 * time.Second

// DefaultTunnelStartTimeout is how long StartTunnel waits for cloudflared
// to print a trycloudflare.com URL before giving up.
const DefaultTunnelStartTimeout = 15 * time.Second

// ErrCloudflaredNotFound is returned by StartTunnel when the cloudflared
// executable cannot be found on PATH.
var ErrCloudflaredNotFound = errors.New("dropzone: cloudflared executable not found")

// Compiled on first use, not at start-up.
var trycloudflareURLRegex = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)
})

// cloudflareAPIURL is where cloudflared asks for a quick tunnel. It shows up
// in its error output (e.g. when the request fails) and is not a tunnel URL.
const cloudflareAPIURL = "https://api.trycloudflare.com"

// cloudflaredCommand and lookupCloudflared are package-level indirections,
// overridden in tests, so tunnel lifecycle/parsing logic can be exercised
// with a fake process instead of depending on the real cloudflared binary
// being installed.
var (
	cloudflaredCommand = func(path, localURL string) *exec.Cmd {
		cmd := exec.Command(path, "tunnel", "--url", localURL)
		procutil.HideWindow(cmd) // a GUI app must not flash a console window
		return cmd
	}
	lookupCloudflared        = findCloudflared
	cloudflaredFallbackPaths = defaultCloudflaredFallbackPaths
)

// findCloudflared locates the cloudflared executable: on PATH first, then in
// the places its installers put it. A running app keeps the PATH it was
// started with, so a cloudflared installed while md-memo is open would
// otherwise stay invisible until the next launch.
func findCloudflared() (string, error) {
	if path, err := exec.LookPath("cloudflared"); err == nil {
		return path, nil
	}
	for _, path := range cloudflaredFallbackPaths() {
		if usableExecutable(path) {
			return path, nil
		}
	}
	return "", exec.ErrNotFound
}

// defaultCloudflaredFallbackPaths are the standard install locations: the
// MSI/winget locations on Windows, Homebrew on macOS.
func defaultCloudflaredFallbackPaths() []string {
	switch runtime.GOOS {
	case "windows":
		var paths []string
		for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles"} {
			if dir := os.Getenv(env); dir != "" {
				paths = append(paths, filepath.Join(dir, "cloudflared", "cloudflared.exe"))
			}
		}
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			paths = append(paths, filepath.Join(dir, "Microsoft", "WinGet", "Links", "cloudflared.exe"))
		}
		return paths
	case "darwin":
		return []string{"/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"}
	}
	return nil
}

func usableExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode()&0o111 != 0
}

// HasCloudflared reports whether the cloudflared executable can be found,
// without spawning anything. Useful for a UI to decide whether to offer the
// "switch to external network" option at all.
func HasCloudflared() bool {
	_, err := lookupCloudflared()
	return err == nil
}

// CloudflaredInstallHint returns a short, OS-appropriate suggestion for
// installing cloudflared, for display when StartTunnel fails because the
// binary is missing.
func CloudflaredInstallHint() string {
	switch runtime.GOOS {
	case "darwin":
		return "brew install cloudflared"
	case "windows":
		return "winget install --id Cloudflare.cloudflared -e"
	default:
		return "https://developers.cloudflare.com/cloudflared/downloads/"
	}
}

// StartTunnel launches a Cloudflare Quick Tunnel (`cloudflared tunnel --url
// http://127.0.0.1:<port>`) exposing this already-running local server to
// the public internet, and switches the idle timeout from IdleTimeout to
// TunnelTimeout/DefaultTunnelTimeout, counted from the moment the tunnel
// becomes ready. The same token-gated HTTP handlers keep serving both LAN
// and tunnel traffic — cloudflared is purely a reverse proxy in front of
// the already-listening port, so no separate auth/size-limit logic is
// needed for the tunnel path.
//
// StartTunnel blocks until the tunnel URL is available, cloudflared fails
// to start, or TunnelStartTimeout elapses, so callers should run it from a
// goroutine — exactly like every other network round trip in this app's
// *Async backend methods. A failed attempt leaves the server as it was and
// may be retried; a successful one may not be repeated.
func (s *Server) StartTunnel() (string, error) {
	s.mu.Lock()
	switch {
	case s.stopped:
		s.mu.Unlock()
		return "", errors.New("dropzone: server already stopped")
	case s.token == "":
		s.mu.Unlock()
		return "", errors.New("dropzone: server has not been started")
	case s.completed:
		s.mu.Unlock()
		return "", errors.New("dropzone: a submission was already accepted")
	case s.tunnelRequested:
		s.mu.Unlock()
		return "", errors.New("dropzone: tunnel already requested")
	}
	s.tunnelRequested = true
	port := s.port
	token := s.token
	s.mu.Unlock()

	tunnelURL, err := s.launchTunnel(port)
	if err != nil {
		s.mu.Lock()
		s.tunnelRequested = false // nothing is running: the user may try again
		s.mu.Unlock()
		return "", err
	}

	timeout := s.TunnelTimeout
	if timeout <= 0 {
		timeout = DefaultTunnelTimeout
	}

	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return "", errors.New("dropzone: server stopped while starting the tunnel")
	}
	s.currentTimeout = timeout
	if s.timer != nil && !s.completed {
		s.timer.Reset(timeout)
	}
	s.mu.Unlock()

	return fmt.Sprintf("%s/?token=%s", tunnelURL, token), nil
}

// launchTunnel starts cloudflared and waits for the public URL it prints. On
// any failure no cloudflared process is left running.
func (s *Server) launchTunnel(port int) (string, error) {
	path, err := lookupCloudflared()
	if err != nil {
		return "", ErrCloudflaredNotFound
	}

	cmd := cloudflaredCommand(path, fmt.Sprintf("http://127.0.0.1:%d", port))
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", fmt.Errorf("dropzone: creating cloudflared stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", ErrCloudflaredNotFound
		}
		return "", fmt.Errorf("dropzone: starting cloudflared: %w", err)
	}

	s.mu.Lock()
	if s.stopped {
		// Stop() ran between the request and the process start: nobody would
		// ever kill this one.
		s.mu.Unlock()
		_ = cmd.Process.Kill()
		go cmd.Wait()
		return "", errors.New("dropzone: server stopped while starting the tunnel")
	}
	s.tunnelCmd = cmd
	s.mu.Unlock()

	startTimeout := s.TunnelStartTimeout
	if startTimeout <= 0 {
		startTimeout = DefaultTunnelStartTimeout
	}

	tunnelURL, err := scanForTunnelURL(stderr, startTimeout)
	if err != nil {
		s.killTunnel()
		return "", err
	}

	// We stop actively scanning once a URL is found, but cloudflared keeps
	// writing to stderr for as long as it runs; keep draining it so it
	// never blocks on a full pipe.
	go io.Copy(io.Discard, stderr)
	return tunnelURL, nil
}

// killTunnel force-kills the cloudflared process, if any, and clears the
// stored handle. Safe to call multiple times, and when no tunnel was ever
// started. It does not block waiting for the process to fully exit —
// Process.Kill() plus reaping in the background is enough to guarantee no
// zombie is left behind without holding up the caller (typically the
// server's own shutdown path).
func (s *Server) killTunnel() {
	s.mu.Lock()
	cmd := s.tunnelCmd
	s.tunnelCmd = nil
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		go cmd.Wait()
	}
}

// scanForTunnelURL reads lines from r (cloudflared's stderr) until it
// finds a trycloudflare.com tunnel URL or timeout elapses.
func scanForTunnelURL(r io.Reader, timeout time.Duration) (string, error) {
	type scanResult struct {
		url string
		err error
	}
	resultCh := make(chan scanResult, 1)

	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 4096), 64*1024)
		for scanner.Scan() {
			for _, match := range trycloudflareURLRegex().FindAllString(scanner.Text(), -1) {
				if match == cloudflareAPIURL {
					continue
				}
				resultCh <- scanResult{url: match}
				return
			}
		}
		resultCh <- scanResult{err: errors.New("dropzone: cloudflared exited before printing a tunnel URL")}
	}()

	select {
	case res := <-resultCh:
		return res.url, res.err
	case <-time.After(timeout):
		return "", errors.New("dropzone: timed out waiting for cloudflared to establish a tunnel")
	}
}
