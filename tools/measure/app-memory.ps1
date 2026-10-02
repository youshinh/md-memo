# Memory (MB) of one running app and of every process below it (its WebView2 browser, renderer, GPU and utility processes).
# Read-only: it only reads the process list. Use it to put a number on "how much more does this feature cost while it is open":
#   powershell -NoProfile -File tools/measure/app-memory.ps1 -Name md-memo-e2e*      (the isolated test build)
# Never kill msedgewebview2.exe by name to "clean up": other apps use WebView2 too; look at the tree of YOUR app instead.
param([string]$Name = 'md-memo*')
$app = Get-Process $Name -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $app) { "no app named $Name"; return }
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$tree = @($app.Id); $queue = @($app.Id)
while ($queue.Count) { $cur = $queue[0]; $queue = $queue[1..($queue.Count)]; foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) { $tree += $c.ProcessId; $queue += $c.ProcessId } }
$ws = 0; $pv = 0; $n = 0
foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $ws += $p.WorkingSet64; $pv += $p.PrivateMemorySize64; $n++ } }
"processes=$n  WorkingSet={0:N0} MB  Private={1:N0} MB" -f ($ws / 1MB), ($pv / 1MB)
