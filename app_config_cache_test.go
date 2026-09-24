package main

import "testing"

// TestParseJevRelevantSettings verifies the pure extraction of the Jev-relevant subset of
// config.json (mirroring the fields InitJevEngine reads from the "action" block).
func TestParseJevRelevantSettings(t *testing.T) {
	t.Run("empty config yields defaults", func(t *testing.T) {
		got := parseJevRelevantSettings("")
		want := jevRelevantSettings{Enabled: true}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("extracts action block fields", func(t *testing.T) {
		json := `{"action":{"apiKey":"sk-123","model":"gpt-4","baseUrl":"https://api.example.com","enabled":false}}`
		got := parseJevRelevantSettings(json)
		want := jevRelevantSettings{APIKey: "sk-123", Model: "gpt-4", BaseURL: "https://api.example.com", Enabled: false}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("missing action block yields defaults", func(t *testing.T) {
		got := parseJevRelevantSettings(`{"unrelated": true}`)
		want := jevRelevantSettings{Enabled: true}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})
}

// TestDiffConfigSettings verifies the pure comparison logic SaveConfig uses to decide whether
// the git-sync engine, Jev client, Discord bridge poller, and/or inbox watcher actually need to
// be reinitialized, without touching any file on disk (parseScrapConfig / parseDiscordBridgeConfig
// / parseInboxConfig do not read App receiver state).
func TestDiffConfigSettings(t *testing.T) {
	a := &App{}

	cfgA := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}, "discordBridge": {"enabled": true, "botToken": "tok-a", "allowedUserId": "1"}, "inbox": {"enabled": true, "dir": "/tmp/inbox-a"}}`
	cfgB := `{"scrap_dir": "/tmp/scraps-b", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}, "discordBridge": {"enabled": true, "botToken": "tok-a", "allowedUserId": "1"}, "inbox": {"enabled": true, "dir": "/tmp/inbox-a"}}`
	cfgC := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-c", "model": "m1", "baseUrl": "http://a"}, "discordBridge": {"enabled": true, "botToken": "tok-a", "allowedUserId": "1"}, "inbox": {"enabled": true, "dir": "/tmp/inbox-a"}}`
	cfgD := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}, "discordBridge": {"enabled": true, "botToken": "tok-d", "allowedUserId": "1"}, "inbox": {"enabled": true, "dir": "/tmp/inbox-a"}}`
	cfgE := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}, "discordBridge": {"enabled": true, "botToken": "tok-a", "allowedUserId": "1"}, "inbox": {"enabled": true, "dir": "/tmp/inbox-e"}}`

	// 1. First call ever (nil caches): all four must be reported as changed so the engines get
	// initialized at least once.
	newScrap, scrapChanged, newJev, jevChanged, newDiscord, discordChanged, newInbox, inboxChanged := diffConfigSettings(a, nil, nil, nil, nil, cfgA)
	if !scrapChanged || !jevChanged || !discordChanged || !inboxChanged {
		t.Fatalf("expected all changed on first call, got scrapChanged=%v jevChanged=%v discordChanged=%v inboxChanged=%v", scrapChanged, jevChanged, discordChanged, inboxChanged)
	}

	// 2. Same config again: none should be reported as changed.
	_, scrapChanged2, _, jevChanged2, _, discordChanged2, _, inboxChanged2 := diffConfigSettings(a, &newScrap, &newJev, &newDiscord, &newInbox, cfgA)
	if scrapChanged2 || jevChanged2 || discordChanged2 || inboxChanged2 {
		t.Errorf("expected no change when configJSON is identical, got scrapChanged=%v jevChanged=%v discordChanged=%v inboxChanged=%v", scrapChanged2, jevChanged2, discordChanged2, inboxChanged2)
	}

	// 3. Only scrap_dir differs: scrapChanged must be true, the others must stay false.
	_, scrapChanged3, _, jevChanged3, _, discordChanged3, _, inboxChanged3 := diffConfigSettings(a, &newScrap, &newJev, &newDiscord, &newInbox, cfgB)
	if !scrapChanged3 {
		t.Errorf("expected scrapChanged=true when scrap_dir differs")
	}
	if jevChanged3 || discordChanged3 || inboxChanged3 {
		t.Errorf("expected jevChanged=false, discordChanged=false and inboxChanged=false when only scrap_dir differs")
	}

	// 4. Only action.apiKey differs: jevChanged must be true, the others must stay false.
	_, scrapChanged4, _, jevChanged4, _, discordChanged4, _, inboxChanged4 := diffConfigSettings(a, &newScrap, &newJev, &newDiscord, &newInbox, cfgC)
	if scrapChanged4 || discordChanged4 || inboxChanged4 {
		t.Errorf("expected scrapChanged=false, discordChanged=false and inboxChanged=false when only action.apiKey differs")
	}
	if !jevChanged4 {
		t.Errorf("expected jevChanged=true when action.apiKey differs")
	}

	// 5. Only discordBridge.botToken differs: discordChanged must be true, the others must stay false.
	_, scrapChanged5, _, jevChanged5, _, discordChanged5, _, inboxChanged5 := diffConfigSettings(a, &newScrap, &newJev, &newDiscord, &newInbox, cfgD)
	if scrapChanged5 || jevChanged5 || inboxChanged5 {
		t.Errorf("expected scrapChanged=false, jevChanged=false and inboxChanged=false when only discordBridge.botToken differs")
	}
	if !discordChanged5 {
		t.Errorf("expected discordChanged=true when discordBridge.botToken differs")
	}

	// 6. Only inbox.dir differs: inboxChanged must be true, the others must stay false.
	_, scrapChanged6, _, jevChanged6, _, discordChanged6, _, inboxChanged6 := diffConfigSettings(a, &newScrap, &newJev, &newDiscord, &newInbox, cfgE)
	if scrapChanged6 || jevChanged6 || discordChanged6 {
		t.Errorf("expected scrapChanged=false, jevChanged=false and discordChanged=false when only inbox.dir differs")
	}
	if !inboxChanged6 {
		t.Errorf("expected inboxChanged=true when inbox.dir differs")
	}
}
