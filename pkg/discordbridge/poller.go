package discordbridge

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Config controls one running Poller.
type Config struct {
	BotToken        string
	AllowedUserID   string
	IntervalSeconds int
	// BaseURL overrides the Discord API base for the poller's internal Client; tests only.
	BaseURL string
	// OnMessage is called once per message from AllowedUserID, oldest first, on the poller's own
	// goroutine. It runs OCR/transcription inline, so it may block for a few seconds - the next
	// poll simply waits its turn.
	OnMessage func(Message)
	// OnStatus reports lifecycle/errors ("connecting", "connected", "error"), e.g. for a
	// settings-screen indicator. May be nil.
	OnStatus func(status, message string)
	// StatePath is where the last-processed message id is persisted, so a restart neither
	// replays the whole DM history nor loses messages sent while the app was closed.
	StatePath string
}

const maxBackoff = 5 * time.Minute

// minIntervalSeconds / maxIntervalSeconds bound the configurable poll interval. Plain vars
// (rather than const) so the test suite can lower the floor and keep polling tests fast instead
// of waiting out a real 15s tick.
var (
	minIntervalSeconds = 15
	maxIntervalSeconds = 600
)

func clampInterval(seconds int) time.Duration {
	if seconds < minIntervalSeconds {
		seconds = minIntervalSeconds
	}
	if seconds > maxIntervalSeconds {
		seconds = maxIntervalSeconds
	}
	return time.Duration(seconds) * time.Second
}

// Poller periodically fetches new DM messages from one allowed Discord user and hands each to
// Config.OnMessage. Build one with NewPoller and call Start; Stop is safe to call once, or never
// (e.g. Start was never called), and safe even if Start's connection attempt never succeeded.
type Poller struct {
	cfg    Config
	client *Client
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewPoller builds a Poller for cfg. It does not touch the network until Start is called.
func NewPoller(cfg Config) *Poller {
	client := &Client{Token: cfg.BotToken, HTTPClient: &http.Client{Timeout: 15 * time.Second}, BaseURL: cfg.BaseURL}
	return &Poller{cfg: cfg, client: client}
}

// Start returns immediately; it never blocks the caller on network I/O; SaveConfig calls this
// synchronously from the UI-bound config-save path and must not stall on a bad token or a slow
// Discord API.
func (p *Poller) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	p.cancel = cancel
	p.wg.Add(1)
	go p.run(ctx)
}

// run connects (retrying with backoff on a bad token, wrong user id, or network error - all
// reported through OnStatus rather than given up on, since the user may fix config.json's
// botToken/allowedUserId while the app keeps running) and then polls until ctx is cancelled.
func (p *Poller) run(ctx context.Context) {
	defer p.wg.Done()
	p.reportStatus("connecting", "")

	var channelID string
	backoff := 5 * time.Second
	for {
		checkCtx, checkCancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := p.client.VerifyToken(checkCtx)
		if err == nil {
			channelID, err = p.client.EnsureDMChannel(checkCtx, p.cfg.AllowedUserID)
		}
		checkCancel()
		if err == nil {
			break
		}
		p.reportStatus("error", err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	lastID := loadLastMessageID(p.cfg.StatePath)
	if lastID == "" {
		// First run ever: baseline to "now" so turning the bridge on does not dump the entire DM
		// history into today's scrap - only messages sent from this point on are captured.
		if recent, err := p.client.FetchMessagesAfter(ctx, channelID, "", 1); err == nil && len(recent) > 0 {
			lastID = recent[len(recent)-1].ID
			saveLastMessageID(p.cfg.StatePath, lastID)
		}
	}

	p.reportStatus("connected", "")
	p.loop(ctx, channelID, lastID)
}

func (p *Poller) loop(ctx context.Context, channelID, lastID string) {
	interval := clampInterval(p.cfg.IntervalSeconds)
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		msgs, err := p.client.FetchMessagesAfter(ctx, channelID, lastID, 50)
		if err != nil {
			if rl, ok := err.(*RateLimitError); ok {
				timer.Reset(rl.Wait())
				continue
			}
			p.reportStatus("error", err.Error())
			timer.Reset(interval)
			continue
		}

		for _, m := range msgs {
			lastID = m.ID
			if m.Author.ID != p.cfg.AllowedUserID {
				continue // defence in depth: only the paired account may write into the scrap
			}
			p.deliver(m)
		}
		if len(msgs) > 0 {
			saveLastMessageID(p.cfg.StatePath, lastID)
		}
		timer.Reset(interval)
	}
}

// deliver isolates a panicking OnMessage (e.g. a bug in OCR/transcription plumbing) from killing
// the poll loop - the same defence-in-depth already applied to the Jev/voice async goroutines.
func (p *Poller) deliver(m Message) {
	defer func() {
		if r := recover(); r != nil {
			p.reportStatus("error", fmt.Sprintf("panic: %v", r))
		}
	}()
	if p.cfg.OnMessage != nil {
		p.cfg.OnMessage(m)
	}
}

func (p *Poller) reportStatus(status, message string) {
	if p.cfg.OnStatus != nil {
		p.cfg.OnStatus(status, message)
	}
}

// Stop cancels the poll loop and waits for the in-flight cycle to finish. Safe to call even if
// Start was never called (cancel is nil then, so this is a no-op).
func (p *Poller) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
	p.wg.Wait()
}
