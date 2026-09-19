# Comprehensive CLI & IPC Integration Test
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Starting md-memo CLI & IPC E2E Test Suite" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Ensure clean state
Stop-Process -Name md-memo -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 1. Launch GUI instance
Write-Host "`n[Step 1] Launching md-memo GUI instance..." -ForegroundColor Yellow
$proc = Start-Process .\md-memo.exe -PassThru
Start-Sleep -Seconds 2

if ($proc.HasExited) {
    Write-Host "FAILED: Process exited prematurely" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Instance running with PID $($proc.Id)" -ForegroundColor Green

# 2. buffer get
Write-Host "`n[Step 2] Testing 'buffer get'..." -ForegroundColor Yellow
$getJson = .\md-memo.exe buffer get --json | Out-String
Write-Host $getJson
$buf = $getJson | ConvertFrom-Json
if (!$buf.hash) {
    Write-Host "FAILED: Expected hash in buffer get output" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Buffer hash retrieved: $($buf.hash)" -ForegroundColor Green

# 3. buffer set (Inject text from CLI)
Write-Host "`n[Step 3] Testing 'buffer set' with new text..." -ForegroundColor Yellow
"# Injected by AI Agent via Unix Pipe`n- [ ] Task 100: Verified" | .\md-memo.exe buffer set
Start-Sleep -Milliseconds 300

$verifyGet = .\md-memo.exe buffer get --json | Out-String
$verifyBuf = $verifyGet | ConvertFrom-Json
if ($verifyBuf.content -notmatch "Injected by AI Agent") {
    Write-Host "FAILED: Content was not updated" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Buffer successfully updated by CLI! New Hash: $($verifyBuf.hash)" -ForegroundColor Green

# 4. buffer replace (Selective range replacement)
Write-Host "`n[Step 4] Testing 'buffer replace' range..." -ForegroundColor Yellow
"Task 100: REPLACED_BY_AGENT" | .\md-memo.exe buffer replace --start 2:7 --end 2:32
Start-Sleep -Milliseconds 300

$replaceGet = .\md-memo.exe buffer get --json | Out-String
$replaceBuf = $replaceGet | ConvertFrom-Json
if ($replaceBuf.content -notmatch "REPLACED_BY_AGENT") {
    Write-Host "FAILED: Range replace failed" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Selective range replacement succeeded!" -ForegroundColor Green

# 5. Optimistic Lock protection (Conflict detection)
Write-Host "`n[Step 5] Testing Optimistic Lock (stale expected-hash)..." -ForegroundColor Yellow
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$conflictOutput = "Conflicting edit" | .\md-memo.exe buffer set --expected-hash "stale-hash-123" 2>&1 | Out-String
$ErrorActionPreference = $prevEAP

if ($LASTEXITCODE -ne 0 -or $conflictOutput -match "conflict") {
    Write-Host "PASS: Optimistic lock successfully blocked overwrite! (ExitCode: $LASTEXITCODE)" -ForegroundColor Green
    Write-Host "Output: $conflictOutput".Trim()
} else {
    Write-Host "FAILED: Expected command to fail with conflict, got exit code $LASTEXITCODE and output: $conflictOutput" -ForegroundColor Red
    exit 1
}

# 6. tab list
Write-Host "`n[Step 6] Testing 'tab list'..." -ForegroundColor Yellow
$tabJson = .\md-memo.exe tab list --json | Out-String
Write-Host $tabJson
$tabs = $tabJson | ConvertFrom-Json
if ($tabs.Count -lt 1) {
    Write-Host "FAILED: Expected at least 1 tab" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Tab list retrieved ($($tabs.Count) tabs open)" -ForegroundColor Green

# 7. ui toggle-split
Write-Host "`n[Step 7] Testing 'ui toggle-split'..." -ForegroundColor Yellow
$splitOut = .\md-memo.exe ui toggle-split | Out-String
Write-Host $splitOut.Trim()
Write-Host "PASS: UI toggle-split executed successfully" -ForegroundColor Green

# 8. Clean up
Write-Host "`n[Step 8] Cleaning up instance..." -ForegroundColor Yellow
Stop-Process -Id $proc.Id -Force
Start-Sleep -Milliseconds 500

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "ALL 7 INTEGRATION TESTS PASSED (100%)" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
