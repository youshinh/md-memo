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
// the git-sync engine and/or Jev client actually need to be reinitialized, without touching any
// file on disk (parseScrapConfig does not read App receiver state).
func TestDiffConfigSettings(t *testing.T) {
	a := &App{}

	cfgA := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}}`
	cfgB := `{"scrap_dir": "/tmp/scraps-b", "action": {"apiKey": "key-a", "model": "m1", "baseUrl": "http://a"}}`
	cfgC := `{"scrap_dir": "/tmp/scraps-a", "action": {"apiKey": "key-c", "model": "m1", "baseUrl": "http://a"}}`

	// 1. First call ever (nil caches): both must be reported as changed so the engines get
	// initialized at least once.
	newScrap, scrapChanged, newJev, jevChanged := diffConfigSettings(a, nil, nil, cfgA)
	if !scrapChanged || !jevChanged {
		t.Fatalf("expected both changed on first call, got scrapChanged=%v jevChanged=%v", scrapChanged, jevChanged)
	}

	// 2. Same config again: neither should be reported as changed.
	_, scrapChanged2, _, jevChanged2 := diffConfigSettings(a, &newScrap, &newJev, cfgA)
	if scrapChanged2 || jevChanged2 {
		t.Errorf("expected no change when configJSON is identical, got scrapChanged=%v jevChanged=%v", scrapChanged2, jevChanged2)
	}

	// 3. Only scrap_dir differs: scrapChanged must be true, jevChanged must stay false.
	_, scrapChanged3, _, jevChanged3 := diffConfigSettings(a, &newScrap, &newJev, cfgB)
	if !scrapChanged3 {
		t.Errorf("expected scrapChanged=true when scrap_dir differs")
	}
	if jevChanged3 {
		t.Errorf("expected jevChanged=false when only scrap_dir differs")
	}

	// 4. Only action.apiKey differs: jevChanged must be true, scrapChanged must stay false.
	_, scrapChanged4, _, jevChanged4 := diffConfigSettings(a, &newScrap, &newJev, cfgC)
	if scrapChanged4 {
		t.Errorf("expected scrapChanged=false when only action.apiKey differs")
	}
	if !jevChanged4 {
		t.Errorf("expected jevChanged=true when action.apiKey differs")
	}
}
