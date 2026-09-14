package main

import (
	"strings"
	"testing"
)

func TestCleanGeneratedCliCommand(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Pure command",
			input:    "ping 8.8.8.8",
			expected: "ping 8.8.8.8",
		},
		{
			name:     "Markdown code fence powershell",
			input:    "```powershell\nGet-Process | Select-Object -First 5\n```",
			expected: "Get-Process | Select-Object -First 5",
		},
		{
			name:     "Markdown code fence bash with leading dollar",
			input:    "```bash\n$ curl -s https://ipinfo.io/json\n```",
			expected: "curl -s https://ipinfo.io/json",
		},
		{
			name:     "Conversational intro and outro",
			input:    "Here is the command you requested:\n```sh\nnetstat -ano\n```\nEnjoy!",
			expected: "netstat -ano",
		},
		{
			name:     "Single backticks",
			input:    "`date /t`",
			expected: "date /t",
		},
		{
			name:     "Trailing newline and spaces",
			input:    "  \n\n powershell -Command \"Get-Date\" \n\n ",
			expected: "powershell -Command \"Get-Date\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanGeneratedCliCommand(tt.input)
			if got != tt.expected {
				t.Errorf("cleanGeneratedCliCommand(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestBuildCliGeneratorPrompt(t *testing.T) {
	osType := "Windows (PowerShell)"
	userReq := "Compress this note"
	meta := CliContextMeta{
		AppDir:   "C:\\Program Files\\MD-Memo",
		FilePath: "C:\\Users\\test\\Documents\\notes\\todo.md",
		FileDir:  "C:\\Users\\test\\Documents\\notes",
		FileName: "todo.md",
	}
	sysPrompt, userPrompt := buildCliGeneratorPrompt(osType, userReq, meta)

	if !strings.Contains(sysPrompt, "Windows (PowerShell)") {
		t.Errorf("expected OS type in system prompt, got %q", sysPrompt)
	}
	if !strings.Contains(userPrompt, userReq) {
		t.Errorf("expected user request in user prompt, got %q", userPrompt)
	}
	if !strings.Contains(userPrompt, "todo.md") || !strings.Contains(userPrompt, "C:\\Users\\test\\Documents\\notes") {
		t.Errorf("expected file path metadata in user prompt, got %q", userPrompt)
	}
}

func TestValidateCliCommand(t *testing.T) {
	tests := []struct {
		name        string
		cmd         string
		wantSafe    bool
		wantWarning bool
		wantBlocked bool
	}{
		{
			name:        "Benign ping",
			cmd:         "ping 127.0.0.1 -n 4",
			wantSafe:    true,
			wantWarning: false,
			wantBlocked: false,
		},
		{
			name:        "Benign sort pipeline",
			cmd:         "sort | uniq -c",
			wantSafe:    true,
			wantWarning: false,
			wantBlocked: false,
		},
		{
			name:        "Dangerous format C:",
			cmd:         "format C: /fs:NTFS /q",
			wantSafe:    false,
			wantWarning: false,
			wantBlocked: true,
		},
		{
			name:        "Dangerous rm -rf /",
			cmd:         "rm -rf / --no-preserve-root",
			wantSafe:    false,
			wantWarning: false,
			wantBlocked: true,
		},
		{
			name:        "Dangerous diskpart",
			cmd:         "diskpart /s clean.txt",
			wantSafe:    false,
			wantWarning: false,
			wantBlocked: true,
		},
		{
			name:        "Dangerous fork bomb",
			cmd:         ":(){ :|:& };:",
			wantSafe:    false,
			wantWarning: false,
			wantBlocked: true,
		},
		{
			name:        "Warning system shutdown",
			cmd:         "shutdown /s /t 0",
			wantSafe:    false,
			wantWarning: true,
			wantBlocked: false,
		},
		{
			name:        "Warning Remove-Item recursive",
			cmd:         "Remove-Item -Path ./tmp -Recurse -Force",
			wantSafe:    false,
			wantWarning: true,
			wantBlocked: false,
		},
		{
			name:        "Warning interactive git commit without message",
			cmd:         "git commit",
			wantSafe:    false,
			wantWarning: true,
			wantBlocked: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			val := validateCliCommand(tt.cmd)
			if tt.wantSafe && (!val.IsSafe || val.IsBlocked || val.IsWarning) {
				t.Errorf("expected command %q to be completely safe, got %+v", tt.cmd, val)
			}
			if tt.wantBlocked && !val.IsBlocked {
				t.Errorf("expected command %q to be blocked, got %+v", tt.cmd, val)
			}
			if tt.wantWarning && !val.IsWarning {
				t.Errorf("expected command %q to trigger warning, got %+v", tt.cmd, val)
			}
		})
	}
}
