package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

//go:embed frontend/*
var frontendFS embed.FS

func main() {
	if !checkSingleInstance() {
		return
	}

	// Tighten Go heap growth threshold to keep idle runtime memory around ~2-3MB
	debug.SetGCPercent(50)

	app := &App{}

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

	// Custom file server handler: enable aggressive caching for static assets (enabling V8 Code Cache & sub-100ms warm boots)
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

		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			// Ensure HTML is revalidated while allowing instant 304s
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			// Static assets (JS, CSS, fonts, images) cached to activate Chromium V8 bytecode cache & instant load
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
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

	// Launch platform native window
	runPlatformWindow(app, serverURL)
}
