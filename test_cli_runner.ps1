# Test CLI operations
param([string]$Action)

switch ($Action) {
    "buffer-get" {
        .\md-memo.exe buffer get --json | Out-String
    }
    "buffer-set" {
        "# Injected by Agent CLI" | .\md-memo.exe buffer set | Out-String
    }
    "buffer-conflict" {
        "# Malicious Overwrite" | .\md-memo.exe buffer set --expected-hash "mismatched-hash-9999" 2>&1 | Out-String
    }
    "tab-list" {
        .\md-memo.exe tab list --json | Out-String
    }
    "ui-toggle-split" {
        .\md-memo.exe ui toggle-split | Out-String
    }
}
