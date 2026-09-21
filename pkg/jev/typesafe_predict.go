package jev

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Quick Actions on Jev's System One API.
//
// System One answers typed questions about a state and does not generate text (docs.typesafe.ai,
// "System One"), so Jev is not asked to write candidates. The built-in rules supply a fixed pool of
// ready-made actions and one Choice question asks which of them fits the note best; the
// probabilities in the answer order the pool. What the panel offers, and what runs, is therefore
// always one of the app's own candidates (a shell command still goes through the command guard),
// never text that came back from the network.
//
// Two hosts take the same request and return the same answers: TypeSafe's own API
// (https://api.typesafe.ai/v1/systemone) and OpenRouter's System One API
// (openrouter.ai/docs/guides/community/typesafe-sdk). Only the address and the key differ.
// OpenRouter's chat-completions route (predictOpenRouter, for ordinary chat models) and a custom
// /predict server keep their own paths in Predict.

const (
	// openRouterSystemOneURL is fixed, like the chat-completions URL, so an OpenRouter key never
	// goes anywhere but openrouter.ai. OpenRouter maps the bare model id "jev-latest" onto its own
	// "~typesafe/jev-latest" alias.
	openRouterSystemOneURL = "https://openrouter.ai/api/v1/systemone"

	// systemOneRankKey is the id of the Choice question; its answer comes back under the same id.
	systemOneRankKey = "next_action"

	// systemOneMinConfidence: below this Choice confidence the ranking is ignored and the built-in
	// rules' own picks stand. The API derives Choice confidence from the distribution (roughly
	// (N*peak-1)/(N-1), docs.typesafe.ai/confidence): with the 11 options offered here, 0.15 means
	// the top option holds about 0.23 of the probability where an even split would give 0.09.
	systemOneMinConfidence = 0.15

	systemOneRankInstructions = "`note_excerpt` is the text around the caret in a note the user is writing (any language). " +
		"Which of these actions would help the user most right now? " +
		"Decide from what the note is about and what it asks for or leaves unfinished. " +
		"Every option is a ready-made action of the note-taking app; the text after the dash is the exact instruction or command it would run."
)

// isSystemOneModel reports whether model names a Jev (System One) model: "jev-latest", "jev-1.13",
// "typesafe/jev-1.13" or "~typesafe/jev-latest". Anything else is an ordinary chat model.
func isSystemOneModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	m = strings.TrimPrefix(m, "~")
	m = strings.TrimPrefix(m, "typesafe/")
	return strings.HasPrefix(m, "jev")
}

// looksLikeOpenRouterKey reports whether key has OpenRouter's "sk-or-v1-..." shape. The settings
// screen has one key field and the GUI copies it into every key slot of the client, so the shape,
// together with the endpoint, decides which service a key is meant for.
func looksLikeOpenRouterKey(key string) bool {
	return strings.HasPrefix(strings.TrimSpace(key), "sk-or-")
}

func isOpenRouterEndpoint(endpoint string) bool {
	return strings.Contains(strings.ToLower(endpoint), "openrouter.ai")
}

// isTypeSafeEndpoint reports whether endpoint points at TypeSafe's System One API: a typesafe.ai
// host (api.typesafe.ai) or an address that already ends in /v1/systemone (a proxy, a test server).
func isTypeSafeEndpoint(endpoint string) bool {
	e := strings.TrimSpace(endpoint)
	if e == "" {
		return false
	}
	if !strings.Contains(e, "://") {
		e = "https://" + e
	}
	u, err := url.Parse(e)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "typesafe.ai" || strings.HasSuffix(host, ".typesafe.ai") {
		return true
	}
	return strings.HasSuffix(strings.ToLower(strings.TrimRight(u.Path, "/")), "/v1/systemone")
}

// systemOneURL builds the evaluation address from a configured endpoint: "https://api.typesafe.ai",
// "https://api.typesafe.ai/v1" and the full ".../v1/systemone" all give the same one.
func systemOneURL(endpoint string) string {
	e := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if !strings.Contains(e, "://") {
		e = "https://" + e
	}
	for _, suffix := range []string{"/v1/systemone", "/v1"} {
		if strings.HasSuffix(strings.ToLower(e), suffix) {
			e = e[:len(e)-len(suffix)]
			break
		}
	}
	return e + "/v1/systemone"
}

// systemOneTarget resolves where a System One request for model goes and with which key, or
// ("", "") when the configuration does not point at a System One host (or has no key for it).
//
//   - TypeSafe direct: a typesafe.ai endpoint with a key that is not an OpenRouter key.
//   - OpenRouter: an OpenRouter key and a Jev model, with the endpoint left at OpenRouter's (the
//     default), empty, or - for a key typed next to a blank Base URL, which the client then defaults
//     to TypeSafe - TypeSafe's. An OpenRouter key with any other model is a chat-completions call
//     and stays with predictOpenRouter.
func (c *Client) systemOneTarget(model string) (endpoint, key string) {
	ep := strings.TrimSpace(c.cfg.Endpoint)

	if isTypeSafeEndpoint(ep) {
		if k := c.getTypeSafeKey(); k != "" && !looksLikeOpenRouterKey(k) {
			return systemOneURL(ep), k
		}
	}

	if k := c.getOpenRouterKey(); looksLikeOpenRouterKey(k) && isSystemOneModel(model) &&
		(ep == "" || isOpenRouterEndpoint(ep) || isTypeSafeEndpoint(ep)) {
		return openRouterSystemOneURL, k
	}
	return "", ""
}

// predictSystemOne ranks the built-in candidate pool with one System One request. It sends
// req.BufferContext (a ~2,000-character excerpt of the note) to endpoint, so callers reach it only
// when systemOneTarget found a key. Any answer that cannot be used is an error, and Predict then
// falls back to the built-in rules.
func (c *Client) predictSystemOne(ctx context.Context, endpoint, apiKey string, req JevPredictRequest) (*JevPredictResponse, error) {
	if strings.TrimSpace(req.BufferContext) == "" {
		return nil, errors.New("jev: empty note excerpt, nothing to rank")
	}

	pool := c.localCandidatePool(req)
	options := make([]string, len(pool))
	criteria := make(map[string]string, len(pool))
	for i, cand := range pool {
		options[i] = systemOneOptionKey(i, cand)
		criteria[options[i]] = cand.Description + " - " + cand.Command
	}

	resp, err := c.callTypeSafeAPI(ctx, endpoint, apiKey, SystemOneRequest{
		State: map[string]string{"note_excerpt": req.BufferContext},
		Model: c.cfg.Model,
		Questions: map[string]SystemOneQuestion{
			systemOneRankKey: {
				Type:         QuestionChoice,
				Instructions: systemOneRankInstructions,
				Criteria:     criteria,
			},
		},
	})
	if err != nil {
		return nil, err
	}

	ans, ok := resp.Answers[systemOneRankKey]
	if !ok || ans.Type != QuestionChoice || len(ans.Probabilities) == 0 {
		return nil, errors.New("jev: no usable choice answer")
	}
	if ans.Confidence < systemOneMinConfidence {
		return nil, errors.New("jev: answer too uncertain to reorder the built-in candidates")
	}

	ranked := make([]Candidate, len(pool))
	for i, cand := range pool {
		cand.Confidence = ans.Probabilities[options[i]]
		ranked[i] = cand
	}
	// Stable: options Jev cannot tell apart keep the order the built-in rules gave them.
	sort.SliceStable(ranked, func(a, b int) bool { return ranked[a].Confidence > ranked[b].Confidence })

	return &JevPredictResponse{Candidates: ranked, RawGrammar: req.GrammarSchema}, nil
}

// systemOneOptionKey names one option of the ranking question: what kind of action it is plus its
// place in the pool, e.g. "command_2". The kind is a hint for the model; the meaning is in the
// criteria text.
func systemOneOptionKey(i int, c Candidate) string {
	kind := "agent_task"
	switch {
	case c.ActionType == "sh":
		kind = "command"
	case strings.HasPrefix(c.Command, "[?"):
		kind = "research"
	}
	return kind + "_" + strconv.Itoa(i+1)
}
