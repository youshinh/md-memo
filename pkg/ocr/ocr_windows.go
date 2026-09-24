package ocr

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"md-memo/pkg/procutil"
)

// ocrScript loads Windows.Media.Ocr through the .NET WinRT projection, exactly the technique
// verified interactively against this OS: it must run under classic Windows PowerShell
// (powershell.exe), not PowerShell 7 (pwsh.exe), which does not support this projection.
// GetFileFromPathAsync additionally requires a backslash-separated path, which os/exec on
// Windows already produces via the caller's imagePath.
const ocrScript = `param([string]$ImagePath)

$ImagePath = (Resolve-Path -LiteralPath $ImagePath).ProviderPath

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output "ERROR:no engine"; exit 1 }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# One entry per recognized line (OcrResult.Text runs them together on Japanese text), returned as
# Base64 of UTF-8 so the console's code page (CP932 on a Japanese Windows) cannot garble it.
$text = (@($result.Lines | ForEach-Object { $_.Text })) -join "` + "`" + `n"
Write-Output ("B64:" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)))
`

var (
	ocrScriptOnce sync.Once
	ocrScriptPath string
	ocrScriptErr  error
)

func ensureOCRScript() (string, error) {
	ocrScriptOnce.Do(func() {
		dir := filepath.Join(os.TempDir(), "md-memo")
		if err := os.MkdirAll(dir, 0755); err != nil {
			ocrScriptErr = err
			return
		}
		path := filepath.Join(dir, "winrt_ocr.ps1")
		if err := os.WriteFile(path, []byte(ocrScript), 0644); err != nil {
			ocrScriptErr = err
			return
		}
		ocrScriptPath = path
	})
	return ocrScriptPath, ocrScriptErr
}

// recognizeOnDeviceOS runs the on-device Windows.Media.Ocr engine against imagePath via a
// single powershell.exe invocation -- no resident OCR process, nothing left running once this
// returns.
func recognizeOnDeviceOS(ctx context.Context, imagePath string) (string, error) {
	scriptPath, err := ensureOCRScript()
	if err != nil {
		return "", err
	}

	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", imagePath)
	procutil.HideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if encoded, ok := strings.CutPrefix(line, "B64:"); ok {
			raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
			if err != nil {
				return "", errOnDeviceUnavailable
			}
			text := tidyOnDeviceText(string(raw))
			if text == "" {
				return "", errOnDeviceUnavailable
			}
			return text, nil
		}
	}
	return "", errOnDeviceUnavailable
}
