package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/jev"
)

// HeadlessRunner handles execution of CLI subcommands without launching WebView/GUI.
type HeadlessRunner struct {
	verifier *jev.ASTCommandVerifier
	// client, selector and router are built on first use. `jev verify`, `agent prune` and the other
	// subcommands never talk to Jev, and building the client reads the environment and allocates an
	// HTTP client, which would otherwise be paid on every CLI call (agents make many).
	client   func() *jev.Client
	selector func() *jev.OrthogonalSelector
	router   func() *jev.AgentRouter
	stdout   io.Writer
	stderr   io.Writer
}

// NewHeadlessRunner initializes a new HeadlessRunner.
func NewHeadlessRunner(stdout, stderr io.Writer) *HeadlessRunner {
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	// AllowGenericEnvKeys is true only here: the headless CLI is an explicit, per-invocation
	// user action (and is what the E2E scripts drive), so honouring a generic OPENROUTER_API_KEY
	// from the environment preserves its documented behaviour. The GUI leaves it false so that
	// auto-firing Quick Actions never ship note content to a service the user did not configure
	// for MD-Memo itself.
	client := sync.OnceValue(func() *jev.Client {
		return jev.NewClient(jev.ClientConfig{
			Timeout:             5 * time.Second,
			AllowGenericEnvKeys: true,
		})
	})
	return &HeadlessRunner{
		verifier: jev.NewASTCommandVerifier(),
		client:   client,
		selector: sync.OnceValue(jev.NewOrthogonalSelector),
		router:   sync.OnceValue(func() *jev.AgentRouter { return jev.NewAgentRouter(client(), 0.85) }),
		stdout:   stdout,
		stderr:   stderr,
	}
}

// Run executes a headless command and returns the process exit code.
func (r *HeadlessRunner) Run(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("subcommand required: jev, agent, or help")
	}

	subcmd := args[0]
	subargs := args[1:]

	switch subcmd {
	case "jev":
		return r.runJev(subargs)
	case "agent":
		return r.runAgent(subargs)
	case "ocr":
		return r.runOCR(subargs)
	case "help", "--help", "-h":
		r.printHelp()
		return 0, nil
	default:
		return 1, fmt.Errorf("unknown headless subcommand: %s", subcmd)
	}
}

func (r *HeadlessRunner) runJev(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("jev subcommand required: verify, predict, or execute")
	}

	action := args[0]
	rest := args[1:]

	fs := flag.NewFlagSet("jev "+action, flag.ContinueOnError)
	fs.SetOutput(r.stderr)
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	quiet := fs.Bool("quiet", false, "Suppress non-error messages")

	switch action {
	case "verify":
		modeName := fs.String("mode", "strict", "Strictness: strict (one-click, nobody reviews), reviewed (a person confirms first) or unattended (hooks)")
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		mode, ok := jev.ParseMode(*modeName)
		if !ok {
			return 1, fmt.Errorf("unknown --mode %q (use strict, reviewed or unattended)", *modeName)
		}
		cmdToVerify := strings.Join(fs.Args(), " ")
		if cmdToVerify == "" {
			return 1, errors.New("command string required for jev verify")
		}

		// The same judgement the GUI run gate, the filter registry and the hook runner use.
		verdict := jev.VerifyCommand(cmdToVerify, mode, nil)
		res := verdict.ValidationResult(cmdToVerify)
		format := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout))

		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", res)
		} else if !*quiet {
			switch verdict.Level {
			case jev.LevelSafe:
				fmt.Fprintf(r.stdout, "[SAFE] Command passed AST validation: %s\n", cmdToVerify)
			case jev.LevelWarn:
				fmt.Fprintf(r.stderr, "[WARN] %s (Command: %s)\n", verdict.Reason, cmdToVerify)
			default:
				fmt.Fprintf(r.stderr, "[BLOCKED] %s (Command: %s)\n", verdict.Reason, cmdToVerify)
			}
		}

		switch verdict.Level {
		case jev.LevelBlock:
			return 1, nil // Exit code 1 for blocked commands
		case jev.LevelWarn:
			return 2, nil // Exit code 2: not known to be destructive, but the guard cannot vouch for it
		}
		return 0, nil

	case "predict":
		input := fs.String("input", "", "Task line input to predict (e.g. '- [ ] write tests')")
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}

		taskLine := *input
		if taskLine == "" && fs.NArg() > 0 {
			taskLine = strings.Join(fs.Args(), " ")
		}
		if taskLine == "" {
			return 1, errors.New("input task line required for jev predict")
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		req := jev.JevPredictRequest{
			BufferContext: taskLine,
			GrammarSchema: jev.TaskActionEBNF,
			MaxCandidates: 10,
		}

		rawResp, err := r.client().Predict(ctx, req)
		if err != nil {
			return 1, fmt.Errorf("prediction failed: %w", err)
		}

		triad := r.selector().SelectTriad(rawResp.Candidates)

		format := ResolveFormat(*forceJSON)
		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", triad)
		} else {
			fmt.Fprintf(r.stdout, "Input: %s\n", taskLine)
			for i, cand := range triad {
				fmt.Fprintf(r.stdout, "  [%d] (%s) %s\n", i+1, cand.ActionType, cand.Command)
			}
		}
		return 0, nil

	case "score":
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		cmdToScore := strings.Join(fs.Args(), " ")
		if cmdToScore == "" {
			return 1, errors.New("command string required for jev score")
		}

		scoreRes, err := r.verifier.ScoreCommand(cmdToScore)
		if err != nil {
			return 1, fmt.Errorf("scoring error: %w", err)
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout))
		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", scoreRes)
		} else {
			riskLabel := "SAFE"
			if scoreRes.Score >= 1.5 {
				riskLabel = "DESTRUCTIVE"
			} else if scoreRes.Score >= 0.5 {
				riskLabel = "MODIFYING"
			}
			fmt.Fprintf(r.stdout, "[%s] Expected Risk Score: %.4f (Probabilities: Safe=%.2f, Mod=%.2f, Dest=%.2f)\nCommand: %s\n",
				riskLabel, scoreRes.Score, scoreRes.Probabilities[0], scoreRes.Probabilities[1], scoreRes.Probabilities[2], cmdToScore)
		}
		return 0, nil

	case "dispatch":
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		taskInput := strings.Join(fs.Args(), " ")
		if taskInput == "" {
			return 1, errors.New("input string required for jev dispatch")
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		plan, err := r.router().DispatchSystemOne(ctx, taskInput)
		if err != nil {
			return 1, fmt.Errorf("dispatch error: %w", err)
		}

		format := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout))
		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", plan)
		} else {
			fmt.Fprintf(r.stdout, "Action: %s (Target: %s, Confidence: %.2f, Escalate: %t)\nCommand: %s\n",
				plan.ActionType, plan.TargetAgent, plan.Confidence, plan.ShouldEscalate, plan.SelectedCommand)
		}
		return 0, nil

	default:
		return 1, fmt.Errorf("unknown jev action: %s", action)
	}
}

func (r *HeadlessRunner) runAgent(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("agent subcommand required: prune")
	}

	action := args[0]
	rest := args[1:]

	fs := flag.NewFlagSet("agent "+action, flag.ContinueOnError)
	fs.SetOutput(r.stderr)
	forceJSON := fs.Bool("json", false, "Force JSON output")
	query := fs.String("query", "", "Target task / query for pruning")
	filePath := fs.String("file", "", "Target markdown file path")

	if err := fs.Parse(rest); err != nil {
		return 1, err
	}

	switch action {
	case "prune":
		var content string
		if *filePath != "" {
			data, err := os.ReadFile(*filePath)
			if err != nil {
				return 1, fmt.Errorf("failed to read file %s: %w", *filePath, err)
			}
			content = string(data)
		} else {
			// Read from stdin if piped
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return 1, fmt.Errorf("failed to read stdin: %w", err)
			}
			content = string(data)
		}

		// PruneContext is pure text processing; it needs no Jev client, so none is built for it.
		pruned := (&jev.AgentRouter{}).PruneContext(content, *query)
		format := ResolveFormat(*forceJSON)

		if format == FormatJSON {
			origLen := len(content)
			prunedLen := len(pruned)
			ratio := 0.0
			if origLen > 0 {
				ratio = float64(prunedLen) / float64(origLen)
			}
			out := map[string]interface{}{
				"original_length": origLen,
				"pruned_length":   prunedLen,
				"ratio":           ratio,
				"content":         pruned,
			}
			PrintFormatted(r.stdout, FormatJSON, "", out)
		} else {
			fmt.Fprint(r.stdout, pruned)
		}
		return 0, nil

	default:
		return 1, fmt.Errorf("unknown agent action: %s", action)
	}
}

func (r *HeadlessRunner) printHelp() {
	fmt.Fprintln(r.stdout, "md-memo --headless <command> [options]")
	fmt.Fprintln(r.stdout, "")
	fmt.Fprintln(r.stdout, "Commands (they run on their own; MD-Memo need not be running):")
	fmt.Fprintln(r.stdout, "  jev verify [--mode m] <cmd>  Validate command safety with Pure Go AST (m: strict|reviewed|unattended)")
	fmt.Fprintln(r.stdout, "                               exit code: 0 safe, 1 blocked, 2 warning")
	fmt.Fprintln(r.stdout, "  jev score <cmd>              Expected destructive impact of a command")
	fmt.Fprintln(r.stdout, "  jev predict --input <task>   Predict orthogonal action beams for task line")
	fmt.Fprintln(r.stdout, "  jev dispatch <input>         Decide whether to handle the input directly or escalate")
	fmt.Fprintln(r.stdout, "  agent prune --query <q>      Prune markdown context by semantic relevance")
	fmt.Fprintln(r.stdout, "  ocr <imagePath>              Extract text from an image and append it to today's scrap")
	fmt.Fprintln(r.stdout, "")
	fmt.Fprintln(r.stdout, "Global Flags:")
	fmt.Fprintln(r.stdout, "  --json                       Output structured JSON")
	fmt.Fprintln(r.stdout, "  --text                       Output plain text (jev, agent)")
	fmt.Fprintln(r.stdout, "  --quiet                      Suppress non-error messages (jev)")
	fmt.Fprintln(r.stdout, "")
	fmt.Fprintln(r.stdout, "The buffer, tab and ui commands need the running app and are not part of --headless.")
	fmt.Fprintln(r.stdout, "All commands: md-memo --help    One command: md-memo help <command>")
}
