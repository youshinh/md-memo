//go:build windows

package speech

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"md-memo/pkg/procutil"
)

// transcodeScript decodes m4a/mp3/aac/wma/flac with the OS's own MediaTranscoder. It must run under
// classic powershell.exe (the WinRT projection is missing from pwsh) and asks for the default WAV
// profile only: requesting 16 kHz mono makes CanTranscode false, so Go does that conversion. Keep it
// ASCII: powershell.exe reads a BOM-less script as the ANSI code page.
const transcodeScript = `param([string]$InPath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $asOp = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' } | Select-Object -First 1
  $asAction = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -match '^IAsyncActionWithProgress.1$' } | Select-Object -First 1
  function Await($op, $type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  [void][Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
  [void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]

  $src = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InPath)) ([Windows.Storage.StorageFile])
  $dir = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync((Split-Path $OutPath))) ([Windows.Storage.StorageFolder])
  $dst = Await ($dir.CreateFileAsync((Split-Path $OutPath -Leaf), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateWav([Windows.Media.MediaProperties.AudioEncodingQuality]::Medium)
  $tc = New-Object Windows.Media.Transcoding.MediaTranscoder
  $prep = Await ($tc.PrepareFileTranscodeAsync($src, $dst, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
  if (-not $prep.CanTranscode) {
    [Console]::Error.WriteLine("cannot transcode: $($prep.FailureReason)")
    exit 2
  }
  $task = $asAction.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
  $task.Wait(-1) | Out-Null
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

var (
	transcodeScriptOnce sync.Once
	transcodeScriptPath string
	transcodeScriptErr  error
)

func ensureTranscodeScript() (string, error) {
	transcodeScriptOnce.Do(func() {
		dir := filepath.Join(os.TempDir(), "md-memo")
		if transcodeScriptErr = os.MkdirAll(dir, 0o755); transcodeScriptErr != nil {
			return
		}
		path := filepath.Join(dir, "media_transcode.ps1")
		if transcodeScriptErr = os.WriteFile(path, []byte(transcodeScript), 0o644); transcodeScriptErr == nil {
			transcodeScriptPath = path
		}
	})
	return transcodeScriptPath, transcodeScriptErr
}

func mediaTranscode(ctx context.Context, in, out string) error {
	script, err := ensureTranscodeScript()
	if err != nil {
		return err
	}
	// StorageFile.GetFileFromPathAsync only accepts backslash-separated paths.
	in, out = filepath.Clean(in), filepath.Clean(out)
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InPath", in, "-OutPath", out)
	procutil.HideWindow(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		msg := strings.TrimSpace(strings.ToValidUTF8(string(output), ""))
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return errors.New(strings.ToValidUTF8(msg, ""))
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		return errors.New("デコード結果のファイルが作られませんでした")
	}
	return nil
}
