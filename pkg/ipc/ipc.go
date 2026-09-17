package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// DefaultPort is the default TCP port for md-memo local IPC.
const DefaultPort = 49152

// Message represents an IPC payload passed between CLI and running instance.
type Message struct {
	Action    string `json:"action"`    // "pipe" or "activate"
	Content   string `json:"content"`   // Piped stdin text
	Command   string `json:"command"`   // Associated command (e.g. "git diff")
	Cwd       string `json:"cwd"`       // Current working directory from CLI
	Timestamp string `json:"timestamp"` // ISO 8601 timestamp
}

// Send attempts to connect to a running md-memo instance on the given port and send a message.
func Send(port int, msg *Message, timeout time.Duration) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to encode IPC message: %w", err)
	}

	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("failed to write IPC message: %w", err)
	}

	return nil
}

// StartListener starts a TCP listener on 127.0.0.1:port to handle incoming IPC messages.
func StartListener(port int, handler func(msg *Message)) (net.Listener, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return // listener closed
			}
			go handleConnection(conn, handler)
		}
	}()

	return listener, nil
}

func handleConnection(conn net.Conn, handler func(msg *Message)) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	scanner := bufio.NewScanner(conn)
	// Allow scanning lines up to 10MB + buffer
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 11*1024*1024)

	if scanner.Scan() {
		line := scanner.Bytes()
		var msg Message
		if err := json.Unmarshal(line, &msg); err == nil {
			if handler != nil {
				handler(&msg)
			}
		}
	}
}
