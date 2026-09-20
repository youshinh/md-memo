package ipc

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/appdir"
)

// DefaultPort is the fallback TCP port for md-memo local IPC.
const DefaultPort = 49152

// Action values carried by Message.
const (
	// ActionPipe appends piped stdin to today's scrap and fronts the window.
	ActionPipe = "pipe"
	// ActionActivate just fronts the window of the running instance.
	ActionActivate = "activate"
	// ActionOpen asks the running instance to open Message.Path in a new tab and front the
	// window. It is what `md-memo notes.md` sends when an instance is already running, so a
	// second process is never started (and, on Windows, so the file is no longer silently
	// dropped by the single-instance mutex).
	ActionOpen = "open"
)

// Message represents a legacy IPC payload passed between CLI and running instance.
type Message struct {
	Action    string `json:"action"`         // "pipe", "activate" or "open"
	Content   string `json:"content"`        // Piped stdin text
	Command   string `json:"command"`        // Associated command (e.g. "git diff")
	Cwd       string `json:"cwd"`            // Current working directory from CLI
	Path      string `json:"path,omitempty"` // Absolute file path for the "open" action
	Timestamp string `json:"timestamp"`      // ISO 8601 timestamp
}

// RPCHandler is a function that processes an incoming RPCRequest and produces an RPCResponse.
type RPCHandler func(req *RPCRequest) *RPCResponse

// Server wraps the network listener and session management for md-memo IPC.
type Server struct {
	listener      net.Listener
	port          int
	session       *SessionInfo
	rpcHandler    RPCHandler
	legacyHandler func(msg *Message)
	closed        int32
	mu            sync.Mutex
}

// Port returns the actual listening port of the server.
func (s *Server) Port() int {
	return s.port
}

// Session returns the session metadata.
func (s *Server) Session() *SessionInfo {
	return s.session
}

// Close gracefully stops the listener and removes the session file.
func (s *Server) Close() error {
	if !atomic.CompareAndSwapInt32(&s.closed, 0, 1) {
		return nil
	}
	_ = RemoveSession()
	if s.listener != nil {
		return s.listener.Close()
	}
	return nil
}

// GetSessionFilePath returns the platform-specific path to ipc-session.json.
func GetSessionFilePath() string {
	configDir, err := appdir.ConfigDir()
	if err != nil {
		configDir = "."
	}
	return filepath.Join(configDir, "md-memo", "ipc-session.json")
}

// GenerateToken creates a cryptographically secure random 32-byte hex token.
func GenerateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// Fallback timestamp + pseudo-random
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// SaveSession writes session metadata to session.json with 0600 permissions.
func SaveSession(info *SessionInfo) error {
	path := GetSessionFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("failed to create session dir: %w", err)
	}

	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize session info: %w", err)
	}

	// Write atomically with 0600 permission
	tmpPath := fmt.Sprintf("%s.tmp.%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write temp session file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		// On Windows, rename might fail if destination exists; fall back to overwrite
		if err2 := os.WriteFile(path, data, 0600); err2 != nil {
			return fmt.Errorf("failed to replace session file: %w", err2)
		}
	}
	return nil
}

// LoadSession reads active session metadata from ipc-session.json.
// If the session file points to an unreachable or dead instance, it automatically purges the stale file.
func LoadSession() (*SessionInfo, error) {
	path := GetSessionFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var info SessionInfo
	if err := json.Unmarshal(data, &info); err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("corrupt session file: %w", err)
	}

	// Validate basic sanity
	if info.Port <= 0 || info.Port > 65535 {
		_ = os.Remove(path)
		return nil, errors.New("invalid session port")
	}

	// Cheap liveness check first: the session file records the writing process's PID, and
	// asking the OS whether that PID is still alive is essentially free. Dialing a port that
	// nobody is listening on can otherwise burn the full 200ms timeout (loopback does not
	// always refuse instantly, e.g. behind a filtering driver), and that dead time lands
	// directly on cold start whenever a stale session file is left behind by a crash.
	if info.PID > 0 && !processAlive(info.PID) {
		_ = os.Remove(path)
		return nil, fmt.Errorf("stale session file purged (pid %d is no longer running)", info.PID)
	}

	// Proactive liveness probe: test if the port is actively listening
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", info.Port), 200*time.Millisecond)
	if err != nil {
		// Target instance is dead or crashed; purge stale session file
		_ = os.Remove(path)
		return nil, fmt.Errorf("stale session file purged (port %d unreachable): %w", info.Port, err)
	}
	_ = conn.Close()

	return &info, nil
}

// RemoveSession deletes the session.json file.
func RemoveSession() error {
	path := GetSessionFilePath()
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// StartServer starts an IPC listener on 127.0.0.1:port (use 0 for random free port).
// It writes a new session.json and handles both JSON-RPC 2.0 requests and legacy pipe messages.
func StartServer(preferredPort int, rpcHandler RPCHandler, legacyHandler func(*Message)) (*Server, error) {
	var listener net.Listener
	var err error

	// 1. Try preferred port first (if > 0)
	if preferredPort > 0 {
		addr := fmt.Sprintf("127.0.0.1:%d", preferredPort)
		listener, err = net.Listen("tcp", addr)
	}

	// 2. If failed or preferredPort == 0, bind to dynamic free port (127.0.0.1:0)
	if listener == nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, fmt.Errorf("failed to bind IPC listener: %w", err)
		}
	}

	actualPort := listener.Addr().(*net.TCPAddr).Port
	session := &SessionInfo{
		PID:       os.Getpid(),
		Port:      actualPort,
		Token:     GenerateToken(),
		StartedAt: time.Now(),
	}

	if err := SaveSession(session); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("failed to save session: %w", err)
	}

	srv := &Server{
		listener:      listener,
		port:          actualPort,
		session:       session,
		rpcHandler:    rpcHandler,
		legacyHandler: legacyHandler,
	}

	go srv.acceptLoop()

	return srv, nil
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return // listener closed
		}
		go s.handleConnection(conn)
	}
}

func (s *Server) handleConnection(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 11*1024*1024) // up to 11MB for large paste/scraps

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// First, try to inspect if it's a JSON-RPC request or legacy Message
		var probe struct {
			JSONRPC string `json:"jsonrpc"`
			Action  string `json:"action"`
			Method  string `json:"method"`
		}
		if err := json.Unmarshal(line, &probe); err != nil {
			// Malformed JSON
			resp := &RPCResponse{
				JSONRPC: "2.0",
				Error: &RPCError{
					Code:    ErrCodeParseError,
					Message: "Parse error: invalid JSON",
				},
			}
			writeResponse(conn, resp)
			return
		}

		// Handle legacy message notification
		if probe.Action != "" && probe.Method == "" {
			var legacyMsg Message
			if err := json.Unmarshal(line, &legacyMsg); err != nil {
				writeLegacyAck(conn, false, "invalid legacy message")
				return
			}
			// Acknowledge *before* running the handler. The ack exists so the CLI can tell
			// "md-memo received this" from "something accepted a TCP connection on that
			// port"; the handler itself (appending a scrap, activating the window) can
			// easily outlive the client's short timeout, and making the client wait for it
			// would turn a slow append into a spurious cold start.
			writeLegacyAck(conn, true, "")
			if s.legacyHandler != nil {
				s.legacyHandler(&legacyMsg)
			}
			return
		}

		// Handle JSON-RPC request
		var req RPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			resp := &RPCResponse{
				JSONRPC: "2.0",
				Error: &RPCError{
					Code:    ErrCodeInvalidRequest,
					Message: "Invalid Request",
				},
			}
			writeResponse(conn, resp)
			return
		}

		// Optional Auth Token check: if auth is provided or required
		if s.session != nil && s.session.Token != "" && req.Auth != "" && req.Auth != s.session.Token {
			resp := &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: &RPCError{
					Code:    ErrCodeUnauthorized,
					Message: "Unauthorized: invalid session token",
				},
			}
			writeResponse(conn, resp)
			return
		}

		if s.rpcHandler != nil {
			resp := s.rpcHandler(&req)
			if resp != nil && req.ID != nil {
				// Only respond if request had an ID (not a notification)
				writeResponse(conn, resp)
			}
		} else {
			resp := &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: &RPCError{
					Code:    ErrCodeMethodNotFound,
					Message: "RPC handler not configured",
				},
			}
			writeResponse(conn, resp)
		}
	}
}

// legacyAck is the one-line reply the server sends for a legacy activate/pipe message. It is
// deliberately not a JSON-RPC response: legacy messages carry no id, and older CLI builds
// simply never read it (they write and close), so adding it breaks nothing.
type legacyAck struct {
	OK     bool   `json:"ok"`
	App    string `json:"app"`
	Reason string `json:"reason,omitempty"`
}

// legacyAckApp identifies the responder so a CLI cannot mistake an unrelated local service's
// chatter for a successful handoff.
const legacyAckApp = "md-memo"

func writeLegacyAck(w io.Writer, ok bool, reason string) {
	data, err := json.Marshal(legacyAck{OK: ok, App: legacyAckApp, Reason: reason})
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = w.Write(data)
}

func writeResponse(w io.Writer, resp *RPCResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = w.Write(data)
}

// CallRPC invokes a remote procedure on the running md-memo instance using session info.
func CallRPC(session *SessionInfo, method string, params interface{}, result interface{}, timeout time.Duration) error {
	if session == nil {
		return errors.New("no active session provided")
	}

	addr := fmt.Sprintf("127.0.0.1:%d", session.Port)
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return fmt.Errorf("failed to connect to running instance at %s: %w", addr, err)
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(timeout))

	var rawParams json.RawMessage
	if params != nil {
		pData, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("failed to encode params: %w", err)
		}
		rawParams = pData
	}

	reqID := time.Now().UnixNano()
	req := &RPCRequest{
		JSONRPC: "2.0",
		ID:      reqID,
		Method:  method,
		Params:  rawParams,
		Auth:    session.Token,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to encode RPC request: %w", err)
	}
	data = append(data, '\n')

	if _, err := conn.Write(data); err != nil {
		return fmt.Errorf("failed to send RPC request: %w", err)
	}

	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 11*1024*1024)

	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("error reading RPC response: %w", err)
		}
		return io.ErrUnexpectedEOF
	}

	var resp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return fmt.Errorf("failed to decode RPC response: %w", err)
	}

	if resp.Error != nil {
		return resp.Error
	}

	if result != nil && resp.Result != nil {
		resData, err := json.Marshal(resp.Result)
		if err != nil {
			return fmt.Errorf("failed to re-encode result: %w", err)
		}
		if err := json.Unmarshal(resData, result); err != nil {
			return fmt.Errorf("failed to parse result into target: %w", err)
		}
	}

	return nil
}

// Send attempts to connect to a running md-memo instance and send a legacy message, and
// waits (within timeout) for that instance's acknowledgement.
//
// The ack matters because the caller treats success as "the running instance has it, this
// process can exit". "Connected and wrote some bytes" is not enough evidence for that: the
// port recorded in the session file (or the fixed DefaultPort) may since have been taken by
// an unrelated local service, which would happily accept the connection and discard the
// payload - and MD-Memo would then silently never start. Returning an error here makes main
// fall through to checkSingleInstance() and a normal startup.
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

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	if !scanner.Scan() {
		if scanErr := scanner.Err(); scanErr != nil {
			return fmt.Errorf("no acknowledgement from peer on port %d: %w", port, scanErr)
		}
		return fmt.Errorf("peer on port %d closed without acknowledging the message", port)
	}

	var ack legacyAck
	if err := json.Unmarshal(scanner.Bytes(), &ack); err != nil || ack.App != legacyAckApp || !ack.OK {
		return fmt.Errorf("peer on port %d did not acknowledge as %s", port, legacyAckApp)
	}

	return nil
}

// StartListener provides backwards compatibility with the original StartListener.
func StartListener(port int, handler func(msg *Message)) (net.Listener, error) {
	srv, err := StartServer(port, nil, handler)
	if err != nil {
		return nil, err
	}
	return srv.listener, nil
}
