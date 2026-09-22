package discordbridge

import (
	"encoding/json"
	"os"
)

// state is the tiny cursor persisted across restarts: without it, either every app start would
// replay the whole DM history into the scrap file, or a message sent while the app was closed
// would be skipped once the next poll only asks for messages after whatever id happened to be in
// memory. It intentionally lives outside config.json, which the frontend rewrites wholesale on
// every settings save and knows nothing about this cursor.
type state struct {
	LastMessageID string `json:"lastMessageId"`
}

// loadLastMessageID returns the persisted cursor, or "" if none exists yet (first run, or the
// state file could not be read/parsed - treated the same as "unknown", never as an error).
func loadLastMessageID(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var s state
	if json.Unmarshal(data, &s) != nil {
		return ""
	}
	return s.LastMessageID
}

// saveLastMessageID persists id as the new cursor. Best-effort: a failed write only means the
// next restart re-baselines to "now" instead of resuming exactly, which is a minor inconvenience,
// not a correctness problem worth surfacing as an error to the poll loop.
func saveLastMessageID(path, id string) {
	if path == "" || id == "" {
		return
	}
	data, err := json.Marshal(state{LastMessageID: id})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0600)
}
