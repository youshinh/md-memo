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
	userReq := "Ping 192.168.1.1 to 10"
	sysPrompt, userPrompt := buildCliGeneratorPrompt(osType, userReq)

	if !strings.Contains(sysPrompt, "Windows (PowerShell)") {
		t.Errorf("expected OS type in system prompt, got %q", sysPrompt)
	}
	if !strings.Contains(userPrompt, userReq) {
		t.Errorf("expected user request in user prompt, got %q", userPrompt)
	}
}
