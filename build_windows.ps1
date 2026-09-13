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
