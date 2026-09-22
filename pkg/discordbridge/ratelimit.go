package discordbridge

import (
	"strconv"
	"time"
)

// RateLimitError is returned by FetchMessagesAfter when Discord answers 429. The poller treats
// it specially (wait exactly Wait(), not the usual poll interval) instead of logging it as a
// generic connection error.
type RateLimitError struct {
	RetryAfter string // Discord's Retry-After header value, seconds (may be fractional)
}

func (e *RateLimitError) Error() string { return "discord: rate limited" }

// Wait returns how long to back off before the next request. Falls back to 5s if the header was
// missing or unparsable, which never happens in practice but must never be zero (a zero wait
// would spin the poll loop against a server that is actively telling it to slow down).
func (e *RateLimitError) Wait() time.Duration {
	if e.RetryAfter != "" {
		if secs, err := strconv.ParseFloat(e.RetryAfter, 64); err == nil && secs > 0 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return 5 * time.Second
}
