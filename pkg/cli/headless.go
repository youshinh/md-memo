package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"md-memo/pkg/jev"
)

// HeadlessRunner handles execution of CLI subcommands without launching WebView/GUI.
type HeadlessRunner struct {
	verifier *jev.ASTCommandVerifier
	client   *jev.Client
	selector *jev.OrthogonalSelector
	router   *jev.AgentRouter
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

	client := jev.NewClient(jev.ClientConfig{
		Timeout: 5 * time.Second,
	})
	return &HeadlessRunner{
		verifier: jev.NewASTCommandVerifier(),
		client:   client,
		selector: jev.NewOrthogonalSelector(),
		router:   jev.NewAgentRouter(client, 0.85),
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
		if err := fs.Parse(rest); err != nil {
			return 1, err
		}
		cmdToVerify := strings.Join(fs.Args(), " ")
		if cmdToVerify == "" {
			return 1, errors.New("command string required for jev verify")
		}

		res, err := r.verifier.Verify(cmdToVerify)
		if err != nil {
			res.IsSafe = false
			res.Reason = fmt.Sprintf("Syntax error: %v", err)
		}
		format := ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout))

		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", res)
		} else if !*quiet {
			if res.IsSafe {
				fmt.Fprintf(r.stdout, "[SAFE] Command passed AST validation: %s\n", cmdToVerify)
			} else {
				fmt.Fprintf(r.stderr, "[BLOCKED] %s (Command: %s)\n", res.Reason, cmdToVerify)
			}
		}

		if !res.IsSafe {
			return 1, nil // Exit code 1 for blocked commands
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

		rawResp, err := r.client.Predict(ctx, req)
		if err != nil {
			return 1, fmt.Errorf("prediction failed: %w", err)
		}

		triad := r.selector.SelectTriad(rawResp.Candidates)

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

		plan, err := r.router.DispatchSystemOne(ctx, taskInput)
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

		pruned := r.router.PruneContext(content, *query)
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
	fmt.Fprintln(r.stdout, "Commands:")
	fmt.Fprintln(r.stdout, "  jev verify <cmd>             Validate bash/powershell command safety with Pure Go AST")
	fmt.Fprintln(r.stdout, "  jev predict --input <task>   Predict orthogonal action beams for task line")
	fmt.Fprintln(r.stdout, "  agent prune --query <q>      Prune markdown context by semantic relevance")
	fmt.Fprintln(r.stdout, "")
	fmt.Fprintln(r.stdout, "Global Flags:")
	fmt.Fprintln(r.stdout, "  --json                       Output structured JSON")
	fmt.Fprintln(r.stdout, "  --quiet                      Suppress non-error messages")
}
