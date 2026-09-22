// Package discordbridge lets one paired Discord account append to today's scrap file from
// anywhere, even while md-memo was closed, by polling the bot's own DM channel over plain
// HTTPS. There is no inbound port, no relay server, and no hosted infrastructure to run: the
// only new account involved is the free Discord bot the user creates for themselves, and its
// token lives in config.json next to the app's other API keys.
package discordbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// apiBase is Discord's stable REST API version.
const apiBase = "https://discord.com/api/v10"

// Client is a minimal Discord REST client scoped to exactly what the bridge needs: verifying a
// bot token, opening/reusing its DM channel with one user, and polling that channel for new
// messages. It never opens a Gateway (WebSocket) connection - polling plain HTTPS on an interval
// is enough for "catch up while the app is running" and avoids an always-open socket.
type Client struct {
	Token      string
	HTTPClient *http.Client
	// BaseURL overrides apiBase; empty means the real Discord API. Tests point this at an
	// httptest.Server so the suite never reaches the network.
	BaseURL string
}

// New builds a Client with a sane request timeout.
func New(token string) *Client {
	return &Client{Token: token, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) base() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return apiBase
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bot "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "md-memo-discord-bridge (https://github.com/youshinh/md-memo, 1.0)")
	return c.HTTPClient.Do(req)
}

// Self is the subset of GET /users/@me this package needs.
type Self struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

// VerifyToken confirms the token is valid and returns the bot's own identity. Used both by the
// poller before it starts and by the settings screen's "接続テスト" button, so a bad token
// surfaces immediately instead of only after the first silent poll failure.
func (c *Client) VerifyToken(ctx context.Context) (*Self, error) {
	resp, err := c.do(ctx, http.MethodGet, "/users/@me", nil)
	if err != nil {
		return nil, fmt.Errorf("Discordに接続できません: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("Botトークンが無効です")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Discord APIエラー (status %d)", resp.StatusCode)
	}
	var self Self
	if err := json.NewDecoder(resp.Body).Decode(&self); err != nil {
		return nil, err
	}
	return &self, nil
}

// isSnowflake reports whether id looks like a Discord snowflake (digits only, in the length
// range real snowflakes fall in) rather than, say, a username. Typing the visible username
// instead of the numeric "Copy User ID" value is the most common setup mistake here, and
// Discord's own API answers it with an unhelpful generic 400 - checking first turns that into an
// actionable message.
func isSnowflake(id string) bool {
	if len(id) < 15 || len(id) > 25 {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// EnsureDMChannel returns the id of the bot's DM channel with userID, creating it on first
// contact. Discord returns the same channel id on every call, so this is safe to run on every
// poller start.
func (c *Client) EnsureDMChannel(ctx context.Context, userID string) (string, error) {
	if !isSnowflake(userID) {
		return "", fmt.Errorf("DiscordのユーザーIDが正しくありません: %q はユーザー名のようです。数字だけのIDが必要です (Discord → ユーザー設定 → 詳細設定 → デベロッパーモードを有効化 → 自分の名前を右クリック → 「ユーザーIDをコピー」)", userID)
	}
	body, _ := json.Marshal(map[string]string{"recipient_id": userID})
	resp, err := c.do(ctx, http.MethodPost, "/users/@me/channels", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("Discordに接続できません: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("DMチャンネルを開けません (status %d)。allowedUserIdを確認してください", resp.StatusCode)
	}
	var ch struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ch); err != nil {
		return "", err
	}
	return ch.ID, nil
}

// Attachment is one file attached to a Discord message.
type Attachment struct {
	URL         string `json:"url"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// Message is the subset of Discord's message object the bridge reads.
type Message struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Author  struct {
		ID string `json:"id"`
	} `json:"author"`
	Attachments []Attachment `json:"attachments"`
}

// FetchMessagesAfter returns messages posted after afterID (exclusive), oldest first, capped at
// limit (Discord's own hard cap is 100; a non-positive or too-large limit falls back to 50).
// afterID == "" fetches the most recent `limit` messages, which the poller uses exactly once, to
// baseline a first-ever run without replaying the whole DM history.
func (c *Client) FetchMessagesAfter(ctx context.Context, channelID, afterID string, limit int) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	path := fmt.Sprintf("/channels/%s/messages?limit=%d", channelID, limit)
	if afterID != "" {
		path += "&after=" + afterID
	}
	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, fmt.Errorf("Discordに接続できません: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &RateLimitError{RetryAfter: resp.Header.Get("Retry-After")}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Discord APIエラー (status %d)", resp.StatusCode)
	}
	var msgs []Message
	if err := json.NewDecoder(resp.Body).Decode(&msgs); err != nil {
		return nil, err
	}
	// Discord returns newest-first; the bridge processes and appends in chronological order.
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// DefaultMaxAttachmentBytes caps a single downloaded attachment - the same 20MB Mobile Drop
// already applies to one uploaded photo, so a Discord-sourced image/voice note is held to an
// equivalent limit.
const DefaultMaxAttachmentBytes int64 = 20 << 20

// DownloadAttachment fetches one attachment's bytes, capped at maxBytes. Discord's CDN
// attachment URLs are pre-signed and world-readable for a limited time; no bot Authorization
// header is sent (or needed) for this host.
func DownloadAttachment(ctx context.Context, url string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("添付ファイルを取得できません: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("添付ファイルの取得に失敗しました (status %d)", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("添付ファイルが大きすぎます (上限 %dMB)", maxBytes/(1<<20))
	}
	return data, nil
}
