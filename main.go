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
	"runtime/debug"
	"strings"
	"time"

	"md-memo/pkg/ipc"
)

//go:embed frontend/*
var frontendFS embed.FS

const maxPipeBytes = 10 * 1024 * 1024 // 10MB safety limit

func inferCommandName() string {
	if len(os.Args) > 1 {
		return strings.Join(os.Args[1:], " ")
	}
	return "CLI Pipe"
}

func main() {
	// 1. Check for piped stdin
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

	// 2. Try to connect to existing instance via Local IPC (127.0.0.1:49152)
	var ipcMsg *ipc.Message
	if isPipe && len(pipeData) > 0 {
		ipcMsg = &ipc.Message{
			Action:    "pipe",
			Content:   string(pipeData),
			Command:   cmdName,
			Cwd:       cwd,
			Timestamp: time.Now().Format(time.RFC3339),
		}
	} else if !isPipe {
		ipcMsg = &ipc.Message{
			Action:    "activate",
			Timestamp: time.Now().Format(time.RFC3339),
		}
	}

	if ipcMsg != nil {
		if err := ipc.Send(ipc.DefaultPort, ipcMsg, 300*time.Millisecond); err == nil {
			// Successfully delivered to running instance! Exit CLI immediately (0ms feel)
			return
		}
	}

	// 3. First instance: verify platform single instance lock
	if !checkSingleInstance() {
		return
	}

	// Tighten Go heap growth threshold to keep idle runtime memory around ~2-3MB
	debug.SetGCPercent(50)

	app := &App{}
	app.InitScrapEngine()
	app.InitSlotEngine()
	app.InitJevEngine()

	// 4. Start local IPC listener for subsequent CLI invocations
	ipcListener, err := ipc.StartListener(ipc.DefaultPort, func(msg *ipc.Message) {
		if msg == nil {
			return
		}
		switch msg.Action {
		case "pipe":
			_, _ = app.AppendDailyScrap(msg.Content, msg.Command, msg.Cwd)
			activatePlatformWindow()
		case "activate":
			activatePlatformWindow()
		}
	})
	if err == nil && ipcListener != nil {
		defer ipcListener.Close()
	}

	// Extract sub filesystem from embedded frontend
	subFS, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatalf("failed to load embedded frontend: %v", err)
	}

	// Start local lightweight HTTP server. Try preferred fixed port 41739 first for consistent origin / storage, fallback to random free port.
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

	// Custom file server handler: enable aggressive caching for static assets
	fileServer := http.FileServer(http.FS(subFS))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/image") {
			filePath := r.URL.Query().Get("path")
			if filePath != "" {
				cleanPath := filepath.Clean(filePath)
				if info, err := os.Stat(cleanPath); err == nil && !info.IsDir() {
					http.ServeFile(w, r, cleanPath)
					return
				}
			}
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		fileServer.ServeHTTP(w, r)
	})

	server := &http.Server{
		Handler: handler,
	}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("server error: %v", err)
		}
	}()

	// If launched with piped data on cold boot, append after GUI loop launches
	if isPipe && len(pipeData) > 0 {
		go func() {
			time.Sleep(500 * time.Millisecond) // Wait briefly for WebView initialization
			_, _ = app.AppendDailyScrap(string(pipeData), cmdName, cwd)
		}()
	}

	// Launch platform native window
	runPlatformWindow(app, serverURL)
}
