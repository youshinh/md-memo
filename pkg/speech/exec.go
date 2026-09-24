package speech

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"md-memo/pkg/boundedbuf"
	"md-memo/pkg/procutil"
)

type whisperJob struct {
	model, wav, lang, outPrefix, prompt string
	threads                             int
}

func (j whisperJob) args() []string {
	a := []string{"-m", j.model, "-f", j.wav, "-l", j.lang, "-t", strconv.Itoa(j.threads), "-otxt", "-of", j.outPrefix, "-np"}
	if j.prompt != "" {
		a = append(a, "--prompt", j.prompt)
	}
	return a
}

// No -hide_banner: builds from before 2015 (one turns up on PATH via Python packages) reject it.
func ffmpegArgs(in, out string) []string {
	return []string{"-loglevel", "error", "-y", "-i", in, "-vn", "-ar", strconv.Itoa(targetRate), "-ac", "1", "-c:a", "pcm_s16le", out}
}

// execWhisper runs whisper-cli in its own directory (its DLLs sit next to it) and returns once it
// has exited; a cancelled ctx kills it.
var execWhisper = func(ctx context.Context, exe string, args []string) error {
	return runProcess(ctx, exe, filepath.Dir(exe), args, "whisper-cli")
}

func runFFmpeg(ctx context.Context, exe, in, out string) error {
	return runProcess(ctx, exe, "", ffmpegArgs(in, out), "ffmpeg")
}

func runProcess(ctx context.Context, exe, dir string, args []string, name string) error {
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = dir
	procutil.HideWindow(cmd)
	cmd.WaitDelay = 3 * time.Second
	stderr := boundedbuf.New(2048)
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s が失敗しました: %v: %s", name, err, msg)
		}
		return fmt.Errorf("%s が失敗しました: %v", name, err)
	}
	return nil
}
