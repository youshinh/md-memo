# Windows Build Script for MD-Memo
# Builds a clean, windowed GUI binary without opening a command prompt / console window.

Write-Host "Building md-memo.exe (GUI subsystem)..." -ForegroundColor Cyan

go build -ldflags="-H windowsgui -s -w" -trimpath -o md-memo.exe .

if ($LASTEXITCODE -eq 0) {
    Write-Host "Successfully built md-memo.exe without console window!" -ForegroundColor Green
} else {
    Write-Host "Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

# The console-subsystem twin for scripts, agents and CI: PowerShell waits for it and gets its real
# exit codes and output. The version is read from app.go (a plain `go build ./cmd/md-memo-cli` says "dev").
Write-Host "Building md-memo-cli.exe (console subsystem)..." -ForegroundColor Cyan
$version = (Select-String -Path app.go -Pattern 'AppVersion\s*=\s*"(\d+\.\d+\.\d+)"').Matches[0].Groups[1].Value
$ldflags = "-s -w -X main.version=$version"
go build "-ldflags=$ldflags" -trimpath -o md-memo-cli.exe ./cmd/md-memo-cli

if ($LASTEXITCODE -eq 0) {
    Write-Host "Successfully built md-memo-cli.exe!" -ForegroundColor Green
} else {
    Write-Host "Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
