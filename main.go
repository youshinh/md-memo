package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"runtime/debug"
)

//go:embed frontend/*
var frontendFS embed.FS

func main() {
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

	// Custom file server handler: cache vendor libraries, but no-cache HTML/CSS/JS for instant updates
	fileServer := http.FileServer(http.FS(subFS))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		r.Header.Del("If-Modified-Since")
		r.Header.Del("If-None-Match")
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
