package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"runtime"
	"runtime/debug"
	"sync/atomic"
	"time"
)

//go:embed frontend/*
var frontendFS embed.FS

func main() {
	// 1. Optimize Go runtime memory footprint
	debug.SetGCPercent(20)

	app := &App{}

	// Extract sub filesystem from embedded frontend
	subFS, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatalf("failed to load embedded frontend: %v", err)
	}

	// Start local lightweight HTTP server on random free port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("failed to start local server: %v", err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	serverURL := fmt.Sprintf("http://127.0.0.1:%d/index.html", port)

	// Custom cached file server handler for instant asset delivery
	fileServer := http.FileServer(http.FS(subFS))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
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

	// Periodic idle memory release to keep working set at minimum
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if atomic.LoadInt32(&app.isDestroyed) != 0 {
				return
			}
			runtime.GC()
			debug.FreeOSMemory()
		}
	}()

	// Launch platform native window
	runPlatformWindow(app, serverURL)
}
