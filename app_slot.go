package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"md-memo/pkg/scrap"
	"md-memo/pkg/slotagent"
)

// GetActiveSlotConfigJSON returns active resolved slot configuration as JSON string.
func (a *App) GetActiveSlotConfigJSON() string {
	cfg := a.resolveActiveSlotConfig("")
	if cfg.Snippets == nil {
		cfg.Snippets = []slotagent.SnippetDef{}
	}
	// agent_issues: what Settings (and a one-time status-bar message) tell the user about these agents.
	b, err := json.Marshal(struct {
		slotagent.SlotConfig
		AgentIssues []slotagent.AgentIssue `json:"agent_issues,omitempty"`
	}{cfg, a.agentIssues(cfg)})
	if err != nil {
		return "{}"
	}
	return string(b)
}

// SlotExecutionResult contains payload sent to frontend when agent run completes.
// StartOffset/EndOffset are UTF-16 code-unit indices into the text the frontend sent.
// In "below" OutputMode Go replaces nothing: NewContent equals OldContent and the frontend
// writes Output (raw, untrimmed stdout) under the task line itself.
type SlotExecutionResult struct {
	ReqID        string `json:"reqId"`
	Type         string `json:"type"` // "slot" or "recipe"
	Role         string `json:"role"`
	Instruction  string `json:"instruction"`
	StartOffset  int    `json:"startOffset"`
	EndOffset    int    `json:"endOffset"`
	OldContent   string `json:"oldContent"`
	NewContent   string `json:"newContent"`
	Output       string `json:"output"`
	OutputMode   string `json:"outputMode"` // slotagent.OutputModeReplace or OutputModeBelow
	IsInline     bool   `json:"isInline"`
	ErrorMsg     string `json:"errorMsg,omitempty"`
	ExitCode     int    `json:"exitCode"`
	Status       string `json:"status"` // "completed", "suspended", "failed"
	ApprovalGate string `json:"approvalGate,omitempty"`
}

// SlotParseMatch represents a parsed slot location for frontend inspection.
// StartOffset/EndOffset are UTF-16 code-unit indices, like a textarea's selectionStart.
type SlotParseMatch struct {
	Type          string `json:"type"`
	OpenDelimiter string `json:"openDelimiter"`
	CloseDelim    string `json:"closeDelim"`
	StartOffset   int    `json:"startOffset"`
	EndOffset     int    `json:"endOffset"`
	RawContent    string `json:"rawContent"`
	Role          string `json:"role"`
	SkillName     string `json:"skillName,omitempty"`
	AgentName     string `json:"agentName,omitempty"`
	OutputMode    string `json:"outputMode"`
	Instruction   string `json:"instruction"`
	IsInline      bool   `json:"isInline"`
	IsTarget      bool   `json:"isTarget"`
}

// slotExecute runs one agent process; tests replace it so no CLI is ever spawned.
var slotExecute = func(ctx context.Context, r *slotagent.Runner, reqID string, def slotagent.AgentDef, filePath, instruction, sysInstruction string) *slotagent.AgentExecutionResult {
	return r.Execute(ctx, reqID, def, filePath, instruction, sysInstruction)
}

func agentTakesInstruction(def slotagent.AgentDef) bool {
	for _, arg := range def.Args {
		if strings.Contains(arg, "{instruction}") {
			return true
		}
	}
	return false
}

func slotOutputMode(mode string) string {
	if mode == slotagent.OutputModeBelow {
		return mode
	}
	return slotagent.OutputModeReplace
}

// utf16Units is how many UTF-16 code units r takes; an invalid byte decodes to U+FFFD, one unit.
func utf16Units(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

// utf16ToByte maps a UTF-16 index (what a textarea/JS string reports) to the byte offset of the
// same position in s. Out-of-range values clamp to [0, len(s)]; an index inside a surrogate pair
// rounds down to the start of that character.
func utf16ToByte(s string, idx int) int {
	if idx <= 0 {
		return 0
	}
	u := 0
	for b := 0; b < len(s); {
		r, size := utf8.DecodeRuneInString(s[b:])
		n := utf16Units(r)
		if u+n > idx {
			return b
		}
		u += n
		b += size
	}
	return len(s)
}

// byteToUTF16 is the inverse of utf16ToByte; an offset inside a multi-byte character rounds down
// to the start of that character.
func byteToUTF16(s string, off int) int {
	return newUTF16Cursor(s).toUTF16(off)
}

// utf16Cursor converts many byte offsets of one string to UTF-16 indices. Queries in ascending
// order cost O(len(s)) in total, and ASCII-only text is the identity.
type utf16Cursor struct {
	s     string
	ascii bool
	b, u  int // last resolved position: byte offset b is UTF-16 index u
}

func newUTF16Cursor(s string) *utf16Cursor {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	return &utf16Cursor{s: s, ascii: ascii}
}

func (c *utf16Cursor) toUTF16(off int) int {
	if off <= 0 {
		return 0
	}
	if off > len(c.s) {
		off = len(c.s)
	}
	if c.ascii {
		return off
	}
	if off < c.b {
		c.b, c.u = 0, 0
	}
	for c.b < off {
		r, size := utf8.DecodeRuneInString(c.s[c.b:])
		if c.b+size > off {
			break
		}
		c.b += size
		c.u += utf16Units(r)
	}
	return c.u
}

// SlotParseResponse holds the outcome of parsing slots in active text.
type SlotParseResponse struct {
	TargetSlot         *SlotParseMatch  `json:"targetSlot,omitempty"`
	AllSlots           []SlotParseMatch `json:"allSlots"`
	HasWaitingApproval bool             `json:"hasWaitingApproval"`
	// The agent (key and definition) a run at this cursor would start, so the frontend can ask before a risky one
	// runs (slotagent.RunAgentFor). Absent when a run would start none.
	RunAgentKey string              `json:"runAgentKey,omitempty"`
	RunAgent    *slotagent.AgentDef `json:"runAgent,omitempty"`
	// The caret is inside an HTML comment: nothing is the target and no gate waits (see ParseSlotsRPC).
	CaretInComment bool `json:"caretInComment,omitempty"`
}

// slotEngine lazily initializes the slot execution runner and pipeline, and returns a
// consistent (runner, pipeline) snapshot under slotEngineMu. InitSlotEngine and every other
// reader (RunSlotAgentAsync, CancelSlotAgent, GetSlotHoverPeek, ...) go through this instead
// of touching a.slotRunner / a.pipelineEngine directly, so a first-time initialization racing
// with a concurrent reader can never hand back a runner without its matching pipeline, or a
// half-written pointer.
func (a *App) slotEngine() (*slotagent.Runner, *slotagent.PipelineEngine) {
	a.slotEngineMu.Lock()
	defer a.slotEngineMu.Unlock()
	if a.slotRunner == nil {
		a.slotRunner = slotagent.NewRunner()
		a.pipelineEngine = slotagent.NewPipelineEngine(a.slotRunner)
	}
	return a.slotRunner, a.pipelineEngine
}

// InitSlotEngine initializes the slot execution runner, pipeline, and file watcher.
func (a *App) InitSlotEngine() {
	a.slotEngine()

	a.watcherMu.Lock()
	defer a.watcherMu.Unlock()
	if a.fileWatcher == nil {
		fw, err := slotagent.NewFileWatcher(func(filePath string) {
			pathJSON, _ := json.Marshal(filePath)
			js := fmt.Sprintf("if (window.__onExternalFileChanged) { window.__onExternalFileChanged(%s); }", string(pathJSON))
			a.dispatchEval(js)
		}, 500*time.Millisecond)
		if err == nil {
			a.fileWatcher = fw
		}
	}
}

// slotConfigCacheKey captures every on-disk/input signal that resolveActiveSlotConfig's result
// depends on. Two calls with an equal key are guaranteed to resolve to the same SlotConfig, so
// the (comparatively expensive) file read + YAML/JSON parse + override-merge can be skipped.
type slotConfigCacheKey struct {
	overrideJSON  string
	cfgModTime    time.Time
	cfgSize       int64
	agentsPath    string // "" when no external agents file is present
	agentsModTime time.Time
	agentsSize    int64
}

type slotConfigCacheEntry struct {
	key      slotConfigCacheKey
	scrapDir string
	result   slotagent.SlotConfig
}

// invalidateSlotConfigCache drops the cached resolved slot configuration. Called whenever code
// elsewhere writes a new config.json or agents config file directly, so the very next
// resolveActiveSlotConfig call re-derives everything from scratch instead of relying on a stat
// comparison that a fast successive write could in principle race.
func (a *App) invalidateSlotConfigCache() {
	a.slotCfgMu.Lock()
	a.slotCfgCache = nil
	a.slotCfgMu.Unlock()
}

// cloneSlotConfig returns a deep-enough copy of cfg so that a caller mutating the returned
// value's maps/slices (Agents, SlotProfiles, Recipes, and their nested slices) cannot corrupt
// the cached copy held by resolveActiveSlotConfig.
func cloneSlotConfig(cfg slotagent.SlotConfig) slotagent.SlotConfig {
	clone := cfg
	if cfg.Agents != nil {
		clone.Agents = make(map[string]slotagent.AgentDef, len(cfg.Agents))
		for k, v := range cfg.Agents {
			vCopy := v
			if v.Args != nil {
				vCopy.Args = append([]string(nil), v.Args...)
			}
			if v.Aliases != nil {
				// non-nil-but-empty means "no aliases" (defaults are not filled in), so keep it non-nil
				vCopy.Aliases = append(make([]string, 0, len(v.Aliases)), v.Aliases...)
			}
			if v.AppendInstruction != nil {
				appendInstruction := *v.AppendInstruction
				vCopy.AppendInstruction = &appendInstruction
			}
			clone.Agents[k] = vCopy
		}
	}
	if cfg.Snippets != nil {
		clone.Snippets = append(make([]slotagent.SnippetDef, 0, len(cfg.Snippets)), cfg.Snippets...)
	}
	if cfg.SlotProfiles != nil {
		clone.SlotProfiles = append([]slotagent.SlotProfile(nil), cfg.SlotProfiles...)
	}
	if cfg.Recipes != nil {
		clone.Recipes = make([]slotagent.Recipe, len(cfg.Recipes))
		for i, r := range cfg.Recipes {
			rCopy := r
			if r.Steps != nil {
				rCopy.Steps = append([]string(nil), r.Steps...)
			}
			clone.Recipes[i] = rCopy
		}
	}
	return clone
}

// resolveActiveSlotConfig returns active slot configuration, checking for external files
// (agents.yaml) first. The result is cached and reused as long as neither config.json, the
// resolved external agents file, nor the override configJSON parameter has changed since the
// last call (see slotConfigCacheKey) - this is what makes repeated calls on every Ctrl+Enter
// cheap instead of re-reading and re-parsing both files (and re-running the merge logic) each
// time. Any actual change on disk (different mtime/size) or to configJSON is still picked up on
// the very next call, exactly as before caching was added.
func (a *App) resolveActiveSlotConfig(configJSON string) slotagent.SlotConfig {
	cfgPath := getConfigFilePath()
	var cfgModTime time.Time
	var cfgSize int64
	if fi, err := os.Stat(cfgPath); err == nil {
		cfgModTime = fi.ModTime()
		cfgSize = fi.Size()
	}

	a.slotCfgMu.Lock()
	cached := a.slotCfgCache
	a.slotCfgMu.Unlock()

	cfgUnchanged := cached != nil &&
		cached.key.overrideJSON == configJSON &&
		cached.key.cfgModTime.Equal(cfgModTime) &&
		cached.key.cfgSize == cfgSize

	var scrapDir string
	if cfgUnchanged {
		scrapDir = cached.scrapDir
	} else {
		cfgStr, _ := a.GetConfig()
		// Expand "~" the same way the scrap engine does. The configured value defaults to
		// the literal "~/Documents/md-memo/scraps", and FindAgentConfigFile only does
		// os.Stat probes - so without this every user on the default path silently never
		// had their <scraps>/.md-memo/agents.yaml found.
		scrapDir = scrap.ResolveScrapDir(a.parseScrapConfig(cfgStr).ScrapDir)
	}

	// FindAgentConfigFile only performs a handful of os.Stat probes (cheap, and required for
	// correctness: it is how an externally/manually dropped or removed agents.yaml gets
	// noticed), so it always runs. What the cache actually saves is the read + parse of that
	// file's contents and the override-merge logic below.
	extFile := slotagent.FindAgentConfigFile(scrapDir)
	var agentsModTime time.Time
	var agentsSize int64
	if extFile != "" {
		if fi, err := os.Stat(extFile); err == nil {
			agentsModTime = fi.ModTime()
			agentsSize = fi.Size()
		}
	}

	if cfgUnchanged &&
		cached.key.agentsPath == extFile &&
		cached.key.agentsModTime.Equal(agentsModTime) &&
		cached.key.agentsSize == agentsSize {
		return cloneSlotConfig(cached.result)
	}

	result := a.buildActiveSlotConfig(configJSON, extFile)

	newEntry := &slotConfigCacheEntry{
		key: slotConfigCacheKey{
			overrideJSON:  configJSON,
			cfgModTime:    cfgModTime,
			cfgSize:       cfgSize,
			agentsPath:    extFile,
			agentsModTime: agentsModTime,
			agentsSize:    agentsSize,
		},
		scrapDir: scrapDir,
		result:   cloneSlotConfig(result),
	}
	a.slotCfgMu.Lock()
	a.slotCfgCache = newEntry
	a.slotCfgMu.Unlock()

	return result
}

// buildActiveSlotConfig performs the actual (potentially expensive) resolution that
// resolveActiveSlotConfig caches: reading and parsing the external agents file if one was
// found, or falling back to MergeSlotConfig, then merging any override configJSON on top.
func (a *App) buildActiveSlotConfig(configJSON, extFile string) slotagent.SlotConfig {
	var baseCfg slotagent.SlotConfig
	hasExt := false

	if extFile != "" {
		if data, err := os.ReadFile(extFile); err == nil {
			ext := filepath.Ext(extFile)
			if parsed, err := slotagent.ParseAgentConfigFile(data, ext); err == nil {
				baseCfg = parsed
				hasExt = true
			}
		}
	}

	if !hasExt {
		return slotagent.MergeSlotConfig(configJSON)
	}

	// If explicit overrides were passed in configJSON, merge them onto external config without overriding external profiles
	if configJSON != "" {
		var override slotagent.SlotConfig
		if err := json.Unmarshal([]byte(configJSON), &override); err == nil {
			if baseCfg.DefaultAgent == "" && override.DefaultAgent != "" {
				baseCfg.DefaultAgent = override.DefaultAgent
			}
			for k, v := range override.Agents {
				if baseCfg.Agents == nil {
					baseCfg.Agents = make(map[string]slotagent.AgentDef)
				}
				// Always register injected agent definitions
				if _, exists := baseCfg.Agents[k]; !exists {
					baseCfg.Agents[k] = v
				}
			}
			if len(override.SlotProfiles) > 0 {
				for _, op := range override.SlotProfiles {
					// Check if this override profile uses a newly injected agent (e.g. mock in tests)
					isCustomInjectedAgent := false
					if _, existsInOverride := override.Agents[op.Agent]; existsInOverride {
						// If op.Agent was not part of original agents in baseCfg before merge, treat as custom injected
						if op.Agent == "mock" || (baseCfg.DefaultAgent != op.Agent && op.Agent != "claude-code" && op.Agent != "hermes" && op.Agent != "codex" && op.Agent != "agy") {
							isCustomInjectedAgent = true
						}
					}

					if isCustomInjectedAgent {
						replaced := false
						for i, bp := range baseCfg.SlotProfiles {
							if bp.TriggerOpen == op.TriggerOpen {
								baseCfg.SlotProfiles[i] = op
								replaced = true
								break
							}
						}
						if !replaced {
							baseCfg.SlotProfiles = append([]slotagent.SlotProfile{op}, baseCfg.SlotProfiles...)
						}
					} else {
						// External agents.yaml takes strict precedence: only append if trigger does not exist
						exists := false
						for _, bp := range baseCfg.SlotProfiles {
							if bp.TriggerOpen == op.TriggerOpen {
								exists = true
								break
							}
						}
						if !exists {
							baseCfg.SlotProfiles = append(baseCfg.SlotProfiles, op)
						}
					}
				}
			}
		}
	}

	return baseCfg
}

// ParseSlotsRPC parses the full text and identifies the active target slot based on the cursor.
// cursorUTF16 is a UTF-16 index (textarea selectionStart) and every offset in the response is
// UTF-16 too; the parser itself works on byte offsets.
func (a *App) ParseSlotsRPC(fullText string, cursorUTF16 int, configJSON string) (*SlotParseResponse, error) {
	cfg := a.resolveActiveSlotConfig(configJSON)
	slots := slotagent.ParseSlots(fullText, cfg)
	gates := slotagent.FindApprovalGates(fullText)
	cursorOffset := utf16ToByte(fullText, cursorUTF16)
	conv := newUTF16Cursor(fullText)
	// A caret inside an HTML comment names nothing to run: no target (not even a slot that holds the comment), no
	// gate to resume, and never the fallback below. The frontend refuses before it asks; this keeps a disagreement
	// between the two from running some other slot.
	caretInComment := slotagent.InsideHTMLComment(fullText, cursorOffset)

	hasWaiting := false
	for _, g := range gates {
		if !g.IsApproved && !caretInComment {
			hasWaiting = true
			break
		}
	}

	resp := &SlotParseResponse{
		AllSlots:           make([]SlotParseMatch, 0, len(slots)),
		HasWaitingApproval: hasWaiting,
		CaretInComment:     caretInComment,
	}

	var targetIdx = -1
	for i, s := range slots {
		// If cursor is strictly inside this slot
		if !caretInComment && cursorOffset >= s.StartOffset && cursorOffset <= s.EndOffset {
			targetIdx = i
			break
		}
	}

	// Fallback: nearest slot after cursor, or first slot
	if targetIdx == -1 && len(slots) > 0 && !caretInComment {
		for i, s := range slots {
			if s.StartOffset >= cursorOffset {
				targetIdx = i
				break
			}
		}
		if targetIdx == -1 {
			targetIdx = 0
		}
	}

	for i, s := range slots {
		isT := (i == targetIdx)
		m := SlotParseMatch{
			Type:          s.Type,
			OpenDelimiter: s.OpenDelimiter,
			CloseDelim:    s.CloseDelim,
			StartOffset:   conv.toUTF16(s.StartOffset),
			EndOffset:     conv.toUTF16(s.EndOffset),
			RawContent:    s.RawContent,
			Role:          s.Role,
			SkillName:     s.SkillName,
			AgentName:     s.AgentName,
			OutputMode:    slotOutputMode(s.OutputMode),
			Instruction:   s.Instruction,
			IsInline:      s.IsInline,
			IsTarget:      isT,
		}
		resp.AllSlots = append(resp.AllSlots, m)
		if isT {
			targetCopy := m
			resp.TargetSlot = &targetCopy
		}
	}

	// What RunSlotAgentAsync would start: the target slot's agent, or a recipe resumed from an approved gate.
	if targetIdx >= 0 {
		resp.RunAgentKey, resp.RunAgent = runAgentInfo(cfg, &slots[targetIdx])
	} else if hasApprovedGate(gates) {
		resp.RunAgentKey, resp.RunAgent = runAgentInfo(cfg, nil)
	}

	return resp, nil
}

// RunSlotAgentAsync executes the designated slot or pipeline recipe asynchronously in background.
// cursorUTF16 is a UTF-16 index (textarea selectionStart); the offsets in the dispatched
// results are UTF-16 too, while parsing and slicing here stay byte based.
func (a *App) RunSlotAgentAsync(reqID, filePath, fullText string, cursorUTF16 int, configJSON string) {
	a.InitSlotEngine()
	slotRunner, pipelineEngine := a.slotEngine()

	go func() {
		cfg := a.resolveActiveSlotConfig(configJSON)
		slots := slotagent.ParseSlots(fullText, cfg)
		gates := slotagent.FindApprovalGates(fullText)
		cursorOffset := utf16ToByte(fullText, cursorUTF16)
		conv := newUTF16Cursor(fullText)

		if slotagent.InsideHTMLComment(fullText, cursorOffset) {
			// A caret inside an HTML comment runs nothing: no slot, no gate, no fallback (see ParseSlotsRPC).
			a.dispatchSlotResult(reqID, &SlotExecutionResult{ReqID: reqID, OutputMode: slotagent.OutputModeReplace, Status: "completed"})
			return
		}

		var targetSlot *slotagent.SlotMatch
		// 1. Locate slot under or near cursor
		for i := range slots {
			s := &slots[i]
			if cursorOffset >= s.StartOffset && cursorOffset <= s.EndOffset {
				targetSlot = s
				break
			}
		}
		if targetSlot == nil && len(slots) > 0 {
			for i := range slots {
				s := &slots[i]
				if s.StartOffset >= cursorOffset {
					targetSlot = s
					break
				}
			}
			if targetSlot == nil {
				targetSlot = &slots[0]
			}
		}

		if targetSlot == nil && len(gates) == 0 {
			// No actionable slot or gate found
			res := SlotExecutionResult{
				ReqID:      reqID,
				OutputMode: slotagent.OutputModeReplace,
				Status:     "completed",
				ExitCode:   0,
			}
			a.dispatchSlotResult(reqID, &res)
			return
		}

		// Ensure target file path exists for agent and has latest content
		actualFilePath := filePath
		var cleanupTemp func()
		if actualFilePath == "" {
			tmpPath, cleanup, err := slotagent.CreateTempNoteFile(fullText)
			if err == nil {
				actualFilePath = tmpPath
				cleanupTemp = cleanup
			}
		} else {
			// Write current in-memory fullText to actualFilePath so agent sees the latest edits
			_ = os.WriteFile(actualFilePath, []byte(fullText), 0644)
		}
		if cleanupTemp != nil {
			defer cleanupTemp()
		}

		// Check for approved gates to resume
		var approvedGate *slotagent.ApprovalGate
		for _, g := range gates {
			if g.IsApproved {
				approvedGate = &g
				break
			}
		}

		// Handle Recipe execution
		if (targetSlot != nil && targetSlot.Type == "recipe") || (targetSlot == nil && approvedGate != nil) {
			var rec slotagent.Recipe
			if targetSlot != nil && targetSlot.Recipe != nil {
				rec = *targetSlot.Recipe
			} else if len(cfg.Recipes) > 0 {
				rec = cfg.Recipes[0]
			}

			// Determine agent for recipe
			agentDef := cfg.Agents[cfg.DefaultAgent]
			if agentDef.Command == "" {
				agentDef = slotagent.DefaultSlotConfig().Agents["claude-code"]
			}

			startStep := 0
			isApproved := false
			if approvedGate != nil {
				startStep = rec.RequiresApprovalStep
				isApproved = true
			}

			pipeCtx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSeconds)*time.Second)
			slotRunner.Cancel(reqID) // ensure clean state (must run before Register, or we'd cancel ourselves)
			// Publish our cancel func so CancelSlotAgent(reqID) can actually stop the run.
			// ExecuteRecipe threads pipeCtx into every step, so cancelling also prevents any
			// later step from starting.
			slotRunner.Register(reqID, cancel)
			defer func() {
				slotRunner.Unregister(reqID)
				cancel()
			}()

			pipeRes := pipelineEngine.ExecuteRecipe(pipeCtx, reqID, rec, agentDef, actualFilePath, fullText, startStep, isApproved)

			startOff := 0
			endOff := 0
			oldContent := ""
			isInline := false
			if targetSlot != nil {
				startOff = targetSlot.StartOffset
				endOff = targetSlot.EndOffset
				oldContent = fullText[startOff:endOff]
				isInline = targetSlot.IsInline
			} else if approvedGate != nil {
				startOff = approvedGate.StartOffset
				endOff = approvedGate.EndOffset
				oldContent = fullText[startOff:endOff]
			}

			newContent := pipeRes.Output
			if isInline {
				newContent = strings.ReplaceAll(newContent, "\r\n", " ")
				newContent = strings.ReplaceAll(newContent, "\n", " ")
			}

			finalStatus := "completed"
			if pipeRes.Status == slotagent.PipelineStatusWaitingApproval {
				finalStatus = "suspended"
			} else if pipeRes.Status == slotagent.PipelineStatusFailed {
				finalStatus = "failed"
				if pipeRes.ErrorMsg != "" {
					openDelim := rec.TriggerOpen
					closeDelim := rec.TriggerClose
					if openDelim == "" {
						openDelim = "{{"
					}
					if closeDelim == "" {
						closeDelim = "}}"
					}
					newContent = fmt.Sprintf("%s %s %s", openDelim, pipeRes.ErrorMsg, closeDelim)
				}
			}

			// Cancelled by the user via CancelSlotAgent: the frontend has already restored
			// the original slot text and marked the task 'canceled'. Report status
			// "canceled" and echo the original content back, so this single final callback
			// merges as a no-op instead of stamping an error over what the user got back.
			if pipeCtx.Err() == context.Canceled {
				finalStatus = "canceled"
				newContent = oldContent
			}

			result := SlotExecutionResult{
				ReqID:        reqID,
				Type:         "recipe",
				Role:         rec.Name,
				Instruction:  pipeRes.StepPrompt,
				StartOffset:  conv.toUTF16(startOff),
				EndOffset:    conv.toUTF16(endOff),
				OldContent:   oldContent,
				NewContent:   newContent,
				Output:       pipeRes.Output,
				OutputMode:   slotagent.OutputModeReplace,
				IsInline:     isInline,
				ErrorMsg:     pipeRes.ErrorMsg,
				Status:       finalStatus,
				ApprovalGate: pipeRes.SuspendGate,
			}
			a.dispatchSlotResult(reqID, &result)
			return
		}

		// Handle Single Slot execution
		if targetSlot != nil {
			startU16 := conv.toUTF16(targetSlot.StartOffset)
			endU16 := conv.toUTF16(targetSlot.EndOffset)
			mode := slotOutputMode(targetSlot.OutputMode)

			agentName := cfg.DefaultAgent
			sysInstruction := ""
			// "@agent" names the agent outright, and its instruction goes through as written:
			// the {{ }} profile's system instruction (code blocks only) would corrupt e.g. a
			// research task, so it is not applied.
			if targetSlot.AgentName != "" {
				agentName = targetSlot.AgentName
			} else if targetSlot.Profile != nil {
				if targetSlot.Profile.Agent != "" {
					agentName = targetSlot.Profile.Agent
				}
				sysInstruction = targetSlot.Profile.SystemInstruction
			}

			// If slot explicitly specifies a skill (@skill-name), load skill instruction
			slotInstruction := targetSlot.Instruction
			if targetSlot.SkillName != "" {
				rootDir := slotagent.FindProjectRoot(actualFilePath)
				skillInfo, err := slotagent.FindSkillInstruction(rootDir, targetSlot.SkillName)
				if err != nil {
					// Skill not found: format error for slot
					oldContent := fullText[targetSlot.StartOffset:targetSlot.EndOffset]
					errText := fmt.Sprintf("⚠ スキル '%s' が見つかりません (skills/%s/SKILL.md)", targetSlot.SkillName, targetSlot.SkillName)
					openDelim := targetSlot.OpenDelimiter
					closeDelim := targetSlot.CloseDelim
					if openDelim == "" {
						openDelim = "{{"
					}
					if closeDelim == "" {
						closeDelim = "}}"
					}
					newContent := fmt.Sprintf("%s %s %s", openDelim, errText, closeDelim)
					result := SlotExecutionResult{
						ReqID:       reqID,
						Type:        "slot",
						Role:        targetSlot.Role,
						Instruction: targetSlot.Instruction,
						StartOffset: startU16,
						EndOffset:   endU16,
						OldContent:  oldContent,
						NewContent:  newContent,
						OutputMode:  mode,
						IsInline:    targetSlot.IsInline,
						ErrorMsg:    errText,
						ExitCode:    1,
						Status:      "failed",
					}
					a.dispatchSlotResult(reqID, &result)
					return
				}

				if sysInstruction != "" {
					sysInstruction = sysInstruction + "\n\n" + skillInfo.Instruction
				} else {
					sysInstruction = skillInfo.Instruction
				}

				if slotInstruction == "" {
					slotInstruction = skillInfo.Instruction
				}
			}

			agentDef, exists := cfg.Agents[agentName]
			if targetSlot.AgentName == "" {
				// A named agent is never swapped for another one: if it is broken the run reports it.
				if !exists || agentDef.Command == "" {
					agentDef = cfg.Agents[cfg.DefaultAgent]
				}
				if agentDef.Command == "" {
					agentDef = slotagent.DefaultSlotConfig().Agents["claude-code"]
				}
			}

			if targetSlot.AgentName != "" && strings.TrimSpace(slotInstruction) == "" && agentTakesInstruction(agentDef) {
				// An empty {instruction} would start the agent CLI with an empty prompt.
				taskLine := fullText[targetSlot.StartOffset:targetSlot.EndOffset]
				errText := fmt.Sprintf("指示が空です。{{ @%s 指示 }} の形で書いてください", targetSlot.AgentName)
				result := SlotExecutionResult{
					ReqID:       reqID,
					Type:        "slot",
					Role:        targetSlot.Role,
					Instruction: targetSlot.Instruction,
					StartOffset: startU16,
					EndOffset:   endU16,
					OldContent:  taskLine,
					NewContent:  taskLine,
					OutputMode:  mode,
					IsInline:    targetSlot.IsInline,
					ErrorMsg:    errText,
					ExitCode:    1,
					Status:      "failed",
				}
				a.dispatchSlotResult(reqID, &result)
				return
			}

			runCtx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSeconds)*time.Second)
			// Publish our cancel func so CancelSlotAgent(reqID) can actually stop the agent
			// process instead of letting it run to the timeout.
			slotRunner.Register(reqID, cancel)
			defer func() {
				slotRunner.Unregister(reqID)
				cancel()
			}()

			execRes := slotExecute(runCtx, slotRunner, reqID, agentDef, actualFilePath, slotInstruction, sysInstruction)

			oldContent := fullText[targetSlot.StartOffset:targetSlot.EndOffset]
			newContent := execRes.Output

			// Cancelled by the user via CancelSlotAgent: the frontend has already restored
			// the original slot text and marked the task 'canceled'. Deliver exactly one
			// final callback whose merge is a no-op (newContent == oldContent) instead of
			// writing an error marker over the text the user just got back.
			if runCtx.Err() == context.Canceled {
				result := SlotExecutionResult{
					ReqID:       reqID,
					Type:        "slot",
					Role:        targetSlot.Role,
					Instruction: targetSlot.Instruction,
					StartOffset: startU16,
					EndOffset:   endU16,
					OldContent:  oldContent,
					NewContent:  oldContent,
					Output:      execRes.RawOutput,
					OutputMode:  mode,
					IsInline:    targetSlot.IsInline,
					ErrorMsg:    execRes.ErrorMsg,
					ExitCode:    execRes.ExitCode,
					Status:      "canceled",
				}
				a.dispatchSlotResult(reqID, &result)
				return
			}

			errMsg := execRes.ErrorMsg
			if mode == slotagent.OutputModeBelow {
				// BELOW mode: the task line stays as it is and the frontend writes the result (or
				// the error) under it, so Go replaces nothing.
				newContent = oldContent
				if errMsg == "" && execRes.ExitCode != 0 {
					errMsg = fmt.Sprintf("Exit Code %d", execRes.ExitCode)
				}
			} else if execRes.ExitCode != 0 || execRes.ErrorMsg != "" {
				// Format error using target slot's own delimiters
				errText := execRes.ErrorMsg
				if errText == "" {
					errText = fmt.Sprintf("Exit Code %d", execRes.ExitCode)
				}
				if !strings.HasPrefix(errText, "⚠") {
					errText = "⚠ エラー: " + errText
				}
				openDelim := targetSlot.OpenDelimiter
				closeDelim := targetSlot.CloseDelim
				if openDelim == "" {
					openDelim = "{{"
				}
				if closeDelim == "" {
					closeDelim = "}}"
				}
				newContent = fmt.Sprintf("%s %s (再試行: Ctrl+Enter) %s", openDelim, errText, closeDelim)
			} else {
				if targetSlot.IsInline {
					// Inline expansion: strip extra newlines to keep on one line
					newContent = strings.ReplaceAll(newContent, "\r\n", " ")
					newContent = strings.ReplaceAll(newContent, "\n", " ")
					newContent = strings.TrimSpace(newContent)
				}
			}

			status := "completed"
			if execRes.ExitCode != 0 || execRes.ErrorMsg != "" {
				status = "failed"
			}

			result := SlotExecutionResult{
				ReqID:       reqID,
				Type:        "slot",
				Role:        targetSlot.Role,
				Instruction: targetSlot.Instruction,
				StartOffset: startU16,
				EndOffset:   endU16,
				OldContent:  oldContent,
				NewContent:  newContent,
				Output:      execRes.RawOutput,
				OutputMode:  mode,
				IsInline:    targetSlot.IsInline,
				ErrorMsg:    errMsg,
				ExitCode:    execRes.ExitCode,
				Status:      status,
			}
			a.dispatchSlotResult(reqID, &result)
		}
	}()
}

func (a *App) dispatchSlotResult(reqID string, res *SlotExecutionResult) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	resJSON, _ := json.Marshal(res)

	js := fmt.Sprintf("if (window.__onSlotAgentResult) { window.__onSlotAgentResult(%s); }", string(resJSON))
	a.dispatchEval(js)
}

// CancelSlotAgent cancels an ongoing slot or pipeline agent execution.
func (a *App) CancelSlotAgent(reqID string) {
	slotRunner, _ := a.slotEngine()
	slotRunner.Cancel(reqID)
}

// GetSlotHoverPeek returns the most recent stdout/stderr output line from an active agent process.
func (a *App) GetSlotHoverPeek(reqID string) string {
	slotRunner, _ := a.slotEngine()
	return slotRunner.GetHoverPeek(reqID)
}

// AgentAvailability reports whether an agent's CLI is actually installed on this machine.
type AgentAvailability struct {
	Available bool   `json:"available"`
	Command   string `json:"command"`
}

const lookPathCacheTTL = 30 * time.Second

type lookPathCacheEntry struct {
	found      bool
	resolvedAt time.Time
}

var (
	lookPathCacheMu sync.Mutex
	lookPathCache   = map[string]lookPathCacheEntry{}
)

// lookPathCached answers "is this command on PATH?" with a short-lived cache. The settings
// screen asks about every configured agent whenever it renders, and exec.LookPath walks the
// whole PATH (times PATHEXT on Windows) on every call, so the raw lookup is far from free.
// The 30s TTL keeps it responsive to the user installing an agent in another window.
func lookPathCached(command string) bool {
	if strings.TrimSpace(command) == "" {
		return false
	}

	now := time.Now()
	lookPathCacheMu.Lock()
	if e, ok := lookPathCache[command]; ok && now.Sub(e.resolvedAt) < lookPathCacheTTL {
		lookPathCacheMu.Unlock()
		return e.found
	}
	lookPathCacheMu.Unlock()

	_, err := exec.LookPath(command)
	found := err == nil

	lookPathCacheMu.Lock()
	lookPathCache[command] = lookPathCacheEntry{found: found, resolvedAt: now}
	lookPathCacheMu.Unlock()

	return found
}

// invalidateLookPathCache drops every memoised exec.LookPath answer.
//
// It exists for one specific race: on macOS a GUI-launched app starts with launchd's tiny
// PATH, and pkg/shellenv repairs that asynchronously a moment later. Anything the settings
// screen or a slot agent looked up in between cached a "not found" that would otherwise
// stand for the full 30s TTL even though the tool is now perfectly reachable.
func invalidateLookPathCache() {
	lookPathCacheMu.Lock()
	lookPathCache = map[string]lookPathCacheEntry{}
	lookPathCacheMu.Unlock()
}

// CheckAgentAvailability resolves agentName (an agents key or one of its aliases) against the
// active slot configuration and reports whether its command can be found on PATH. An unknown
// agent (or one with no command configured) yields {available:false, command:""}.
func (a *App) CheckAgentAvailability(agentName string) AgentAvailability {
	if strings.TrimSpace(agentName) == "" {
		return AgentAvailability{}
	}
	cfg := a.resolveActiveSlotConfig("")
	key, ok := slotagent.ResolveAgentName(cfg, agentName)
	if !ok {
		return AgentAvailability{}
	}
	def := cfg.Agents[key]
	if strings.TrimSpace(def.Command) == "" {
		return AgentAvailability{}
	}
	return AgentAvailability{Available: lookPathCached(def.Command), Command: def.Command}
}

// WatchActiveFile registers the currently active file with fsnotify file watcher.
func (a *App) WatchActiveFile(filePath string) error {
	a.InitSlotEngine()
	a.watcherMu.Lock()
	defer a.watcherMu.Unlock()
	if a.fileWatcher != nil {
		return a.fileWatcher.Watch(filePath)
	}
	return nil
}

// UnwatchActiveFile unregisters any actively monitored file.
func (a *App) UnwatchActiveFile() {
	a.watcherMu.Lock()
	defer a.watcherMu.Unlock()
	if a.fileWatcher != nil {
		a.fileWatcher.Unwatch()
	}
}
