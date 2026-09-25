package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
	"md-memo/pkg/shellenv"
)

//go:embed frontend/*
var frontendFS embed.FS

const maxPipeBytes = 10 * 1024 * 1024 // 10MB safety limit

// uiReadyFallback bounds how long a cold-boot piped scrap waits for the WebView to signal
// that its document has loaded. It only matters when the page never signals at all (an old
// cached bundle, a navigation failure): the content is appended anyway rather than lost.
const uiReadyFallback = 3 * time.Second

var (
	uiReadyOnce sync.Once
	uiReadyCh   = make(chan struct{})
)

// MarkUIReady is bound as backend_uiReady and called by the injected shim on
// DOMContentLoaded/load. It is idempotent, so the shim may safely signal more than once.
func (a *App) MarkUIReady() {
	uiReadyOnce.Do(func() { close(uiReadyCh) })
}

// waitUIReady blocks until the WebView has signalled readiness, or timeout elapses.
func waitUIReady(timeout time.Duration) {
	select {
	case <-uiReadyCh:
	case <-time.After(timeout):
	}
}

func inferCommandName() string {
	if len(os.Args) > 1 {
		return strings.Join(os.Args[1:], " ")
	}
	return "CLI Pipe"
}

func main() {
	attachParentConsole()

	args := os.Args[1:]

	// 0. --help / -h / help [command] / --version: print and exit before anything can start or
	// raise the GUI (an agent probing the CLI must not open the user's window).
	if text, ok := cli.HelpRequest(args, AppVersion); ok {
		fmt.Fprint(os.Stdout, text)
		os.Exit(0)
	}

	// 1. Handle --headless mode
	if len(args) > 0 && args[0] == "--headless" {
		runner := cli.NewHeadlessRunner(os.Stdout, os.Stderr).WithVersion(AppVersion)
		code, err := runner.Run(args[1:])
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
		os.Exit(code)
	}

	// 2. Handle subcommands. The list of command words, and which of them run without the GUI,
	// is the registry in pkg/cli/registry.go.
	if len(args) > 0 && cli.IsSubcommand(args[0]) {
		subcmd := args[0]

		// The standalone commands (jev, agent, ocr, info) are headless-capable
		// computations (instant execution, no running instance required) - ocr in particular must
		// work with md-memo not running at all, since it's what the Explorer "送る" (Send To) menu
		// entry invokes.
		if cli.IsStandalone(subcmd) {
			runner := cli.NewHeadlessRunner(os.Stdout, os.Stderr).WithVersion(AppVersion)
			code, err := runner.Run(args)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			}
			os.Exit(code)
		}

		session, err := ipc.LoadSession()
		if err != nil || session == nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", cli.NotRunningMessage())
			os.Exit(1)
		}

		client := cli.NewClientRunner(session, os.Stdout, os.Stderr)
		code, err := client.Run(args)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
		os.Exit(code)
	}

	// 3. Check for piped stdin
	stat, err := os.Stdin.Stat()
	isPipe := err == nil && (stat.Mode()&os.ModeCharDevice) == 0

	var pipeData []byte
	var cmdName string
	var cwd string

	if isPipe {
		reader := io.LimitReader(os.Stdin, maxPipeBytes+1)
		data, err := io.ReadAll(reader)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: failed to read standard input: %v\n", err)
			os.Exit(1)
		}
		if len(data) > maxPipeBytes {
			fmt.Fprintln(os.Stderr, "Error: standard input exceeds maximum allowed size (10MB)")
			os.Exit(1)
		}
		pipeData = data
		cmdName = inferCommandName()
		cwd, _ = os.Getwd()
	}

	// 4. Try to connect to existing instance via session or legacy port
	session, _ := ipc.LoadSession()
	var ipcMsg *ipc.Message
	if isPipe && len(pipeData) > 0 {
		ipcMsg = &ipc.Message{
			Action:    ipc.ActionPipe,
			Content:   string(pipeData),
			Command:   cmdName,
			Cwd:       cwd,
			Timestamp: time.Now().Format(time.RFC3339),
		}
	} else if !isPipe && len(args) == 0 {
		ipcMsg = &ipc.Message{
			Action:    ipc.ActionActivate,
			Timestamp: time.Now().Format(time.RFC3339),
		}
	} else if !isPipe {
		// `md-memo notes.md` while an instance is already running. Until now no IPC message
		// was built for this case at all, so on Windows the single-instance mutex stopped the
		// second process and the file was silently dropped, and on macOS (no single-instance
		// check at that point) a whole second instance started and took over the session file.
		if startupPath := resolveStartupFileArg(args); startupPath != "" {
			ipcMsg = &ipc.Message{
				Action:    ipc.ActionOpen,
				Path:      startupPath,
				Timestamp: time.Now().Format(time.RFC3339),
			}
		}
	}

	if ipcMsg != nil {
		targetPort := ipc.DefaultPort
		if session != nil && session.Port > 0 {
			targetPort = session.Port
		}
		if err := ipc.Send(targetPort, ipcMsg, 300*time.Millisecond); err == nil {
			// Successfully delivered to running instance! Exit CLI immediately (0ms feel)
			return
		}
	}

	// 5. First instance: verify platform single instance lock
	if !checkSingleInstance() {
		return
	}

	// Tighten Go heap growth threshold to keep idle runtime memory around ~2-3MB
	debug.SetGCPercent(50)

	installCrashLog()

	app := &App{}
	app.InitScrapEngine()
	app.InitSlotEngine()
	app.InitJevEngine()
	app.InitDiscordBridge()
	app.InitInboxWatcher()

	// A macOS .app launched from Finder, the Dock or Spotlight inherits launchd's PATH
	// ("/usr/bin:/bin:/usr/sbin:/sbin"), not the user's, so Homebrew, pipx and version-manager
	// shims are invisible to exec.LookPath and every external tool looks uninstalled. Repair
	// it from the login shell - off the startup path, because probing an interactive shell
	// can take a moment and must never delay the first frame. The LookPath cache is cleared
	// afterwards so nothing keeps serving a "not found" computed against the old PATH.
	if runtime.GOOS == "darwin" {
		go func() {
			defer func() { _ = recover() }()
			shellenv.Apply()
			invalidateLookPathCache()
		}()
	}

	// 6. Start local IPC server (JSON-RPC 2.0 + session.json + legacy notification support)
	ipcServer, err := ipc.StartServer(ipc.DefaultPort, app.DispatchRPCOperation, func(msg *ipc.Message) {
		if msg == nil {
			return
		}
		switch msg.Action {
		case ipc.ActionPipe:
			_, _ = app.AppendDailyScrap(msg.Content, msg.Command, msg.Cwd)
			activatePlatformWindow()
		case ipc.ActionActivate:
			activatePlatformWindow()
		case ipc.ActionOpen:
			// The path is already absolute (resolveStartupFileArg made it so in the sending
			// process, whose working directory this one does not share).
			_ = app.OpenPathInNewTab(msg.Path)
			activatePlatformWindow()
		}
	})
	if err == nil && ipcServer != nil {
		defer ipcServer.Close()
	}

	// Extract sub filesystem from embedded frontend
	subFS, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatalf("failed to load embedded frontend: %v", err)
	}

	// Start local lightweight HTTP server
	listener, err := net.Listen("tcp", "127.0.0.1:41739")
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatalf("failed to start local server: %v", err)
		}
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	serverURL := fmt.Sprintf("http://127.0.0.1:%d/", port)

	// Custom file server handler
	fileServer := http.FileServer(http.FS(subFS))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/image") {
			serveLocalImage(w, r, port)
			return
		}

		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		fileServer.ServeHTTP(w, r)
	})

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      60 * time.Second, // generous: large images are served over this endpoint
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("server error: %v", err)
		}
	}()

	// If launched with piped data on cold boot, append once the WebView reports it is ready.
	if isPipe && len(pipeData) > 0 {
		// Convert once and drop the byte slice: keeping pipeData alive in the closure below
		// pinned up to 10MB for the lifetime of the goroutine *and* string(pipeData) inside
		// the closure made a second copy of all of it.
		pipeContent := string(pipeData)
		pipeData = nil

		go func() {
			// Previously a flat 500ms guess. Waiting for the real signal means the scrap
			// lands as soon as the page can render it on a fast machine and does not race
			// the WebView on a slow one; the fallback guarantees the content is never lost
			// if the page never signals at all. Exactly one append happens either way.
			waitUIReady(uiReadyFallback)
			_, _ = app.AppendDailyScrap(pipeContent, cmdName, cwd)
		}()
	}

	// Launch platform native window
	runPlatformWindow(app, serverURL)
}

// resolveStartupFileArg picks the first command-line argument that names an existing file and
// returns its absolute path, or "" when there is none.
//
// It deliberately mirrors GetStartupFile's argument scanning (skip flags, strip surrounding
// quotes, stat the result) so a file opened through an already-running instance and a file
// opened on a cold start are selected by exactly the same rule. The path is made absolute
// here, in the process that still has the user's working directory: the running instance's
// cwd is wherever it happened to be launched from.
func resolveStartupFileArg(args []string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		cleanPath := strings.Trim(arg, "\"")
		cleanPath = strings.Trim(cleanPath, "'")
		if cleanPath == "" {
			continue
		}
		info, err := os.Stat(cleanPath)
		if err != nil || info.IsDir() {
			continue
		}
		absPath, err := filepath.Abs(cleanPath)
		if err != nil {
			return cleanPath
		}
		return absPath
	}
	return ""
}

// allowedImageExtensions lists the file extensions /api/image will ever serve. This covers both
// images MD-Memo itself writes to disk (GenerateImageAsync saves .png/.jpg/.webp) and common
// pre-existing image formats a user may reference from their own notes (screenshots, diagrams,
// icons, animations) via a local path or relative "assets/..." link.
var allowedImageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".bmp": true, ".ico": true, ".svg": true, ".avif": true, ".tif": true, ".tiff": true,
}

// isAllowedImageHost reports whether the Host header of an /api/image request matches this
// server's own loopback listener exactly. This blocks DNS-rebinding: a remote page cannot make
// a browser resolve an attacker-controlled hostname to 127.0.0.1 and reuse that origin's
// same-origin fetches to read arbitrary local files, because the Host header it sends will not
// match "127.0.0.1:<port>" / "localhost:<port>".
func isAllowedImageHost(hostHeader string, port int) bool {
	if hostHeader == "" {
		return false
	}
	return hostHeader == fmt.Sprintf("127.0.0.1:%d", port) || hostHeader == fmt.Sprintf("localhost:%d", port)
}

// resolveImageFileRequest validates a requested local file path for the /api/image endpoint and
// returns the cleaned path to serve. It rejects anything that isn't a regular file with a known
// image extension, and additionally sniffs the first 512 bytes of non-SVG files to confirm they
// actually are image content (an "image/*" MIME type), so a text file merely renamed with an
// image extension is not served as if it were trusted binary content.
func resolveImageFileRequest(rawPath string) (string, bool) {
	if rawPath == "" {
		return "", false
	}

	ext := strings.ToLower(filepath.Ext(rawPath))
	if !allowedImageExtensions[ext] {
		return "", false
	}

	cleanPath := filepath.Clean(rawPath)
	info, err := os.Stat(cleanPath)
	if err != nil || info.IsDir() {
		return "", false
	}

	// SVG is XML text, not raster content: http.DetectContentType cannot meaningfully sniff it,
	// so the extension + regular-file checks above are its only gate.
	if ext == ".svg" {
		return cleanPath, true
	}

	f, err := os.Open(cleanPath)
	if err != nil {
		return "", false
	}
	defer f.Close()

	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	if !strings.HasPrefix(http.DetectContentType(buf[:n]), "image/") {
		return "", false
	}

	return cleanPath, true
}

// serveLocalImage implements the /api/image endpoint: it lets the frontend preview local images
// referenced from a note (see resolveLocalPreviewImages in frontend/js/app.js) while guarding
// against arbitrary local file disclosure (only GET/HEAD, only same-origin loopback requests,
// only files that are genuinely images).
func serveLocalImage(w http.ResponseWriter, r *http.Request, port int) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	if !isAllowedImageHost(r.Host, port) {
		http.NotFound(w, r)
		return
	}

	resolvedPath, ok := resolveImageFileRequest(r.URL.Query().Get("path"))
	if !ok {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, resolvedPath)
}
