# crosscheck.ps1 - type-checks the platforms this repo targets but cannot build natively on
# this machine, without needing their toolchains (no Xcode, no cgo, no cross-compiler).
#
# It cannot catch everything: window_darwin.go / hotkey_darwin.go / openfile_darwin.go all use
# cgo and Objective-C, which only actually compile on the macOS CI runner. What this script does
# catch is a regression in the pure-Go parts of the darwin build (platform_darwin.go and every
# platform-agnostic file: app.go, app_*.go, ...) - a renamed symbol, a signature change, a typo -
# without waiting for that runner. See platform_darwin_nocgo.go for the stubs that stand in for
# the cgo-only functions during this check.
#
# Usage: powershell -File tools/crosscheck.ps1
# Exit code is nonzero if any target fails.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$results = @()

function Run-Target {
    param(
        [string]$Name,
        [string]$Goos,
        [string]$Goarch,
        [string[]]$Packages,
        [switch]$SkipTestCompile
    )

    Write-Host "=== $Name ($Goos/$Goarch, CGO_ENABLED=0) ===" -ForegroundColor Cyan

    $env:CGO_ENABLED = '0'
    $env:GOOS = $Goos
    $env:GOARCH = $Goarch

    $ok = $true

    & go vet @Packages
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: $Name go vet" -ForegroundColor Red
        $ok = $false
    }

    if (-not $SkipTestCompile) {
        $outDir = Join-Path $env:TEMP "md-memo-crosscheck-$Goos-$Goarch"
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        & go test -c -o "$outDir/" @Packages
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAIL: $Name go test -c" -ForegroundColor Red
            $ok = $false
        }
    }

    Remove-Item Env:\CGO_ENABLED, Env:\GOOS, Env:\GOARCH -ErrorAction SilentlyContinue

    if ($ok) {
        Write-Host "PASS: $Name" -ForegroundColor Green
    }
    $script:results += [pscustomobject]@{ Name = $Name; Ok = $ok }
}

Run-Target -Name 'darwin/arm64 (root + pkg/...)' -Goos 'darwin' -Goarch 'arm64' -Packages @('./...')
Run-Target -Name 'darwin/amd64 (root + pkg/...)' -Goos 'darwin' -Goarch 'amd64' -Packages @('./...')

# The root package does not build on linux at all yet (pkg/dialog/dialog_other.go has no
# OpenFolderDialog implementation for it) - that is a known, separate gap, not something this
# script is meant to catch. pkg/... has no such gap, so that is what gets checked here.
Run-Target -Name 'linux/amd64 (pkg/... only - root is known-broken on linux)' -Goos 'linux' -Goarch 'amd64' -Packages @('./pkg/...')

Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
$failed = $false
foreach ($r in $results) {
    if ($r.Ok) {
        Write-Host "PASS  $($r.Name)" -ForegroundColor Green
    } else {
        Write-Host "FAIL  $($r.Name)" -ForegroundColor Red
        $failed = $true
    }
}

if ($failed) {
    exit 1
}
exit 0
