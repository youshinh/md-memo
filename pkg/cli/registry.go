package cli

import "strings"

// The command registry is the ONE list of command words. main.go (which routes a command line),
// help.go (which recognises a help request) and both runners (which dispatch) all read it, so
// adding a command means adding a line here plus its runner and its usage text in help.go.
//
// A command is one of two kinds:
//   - standalone: it runs inside this process, with the GUI not involved. main hands the
//     arguments straight to HeadlessRunner.Run, so md-memo need not be running (jev, agent, ocr, info).
//   - app: it talks to the running app over JSON-RPC. main loads the session first and answers
//     "md-memo is not running" without one (buffer, tab, ui). A few of their options do local work
//     on top (buffer get --out writes the file in this process) but the note itself always comes
//     from the app.

type command struct {
	name       string
	standalone func(r *HeadlessRunner, args []string) (int, error)
	app        func(c *ClientRunner, args []string) (int, error)
	// noAction: the word after the command is not an action (ocr <imagePath>, info [--json]), so only leading
	// flags can ask for help (see HelpRequest).
	noAction bool
}

var commands = []command{
	{name: "buffer", app: (*ClientRunner).runBuffer},
	{name: "tab", app: (*ClientRunner).runTab},
	{name: "ui", app: (*ClientRunner).runUI},
	{name: "jev", standalone: (*HeadlessRunner).runJev},
	{name: "agent", standalone: (*HeadlessRunner).runAgent},
	{name: "ocr", standalone: (*HeadlessRunner).runOCR, noAction: true},
	{name: "info", standalone: (*HeadlessRunner).runInfo, noAction: true},
}

func findCommand(name string) *command {
	for i := range commands {
		if commands[i].name == name {
			return &commands[i]
		}
	}
	return nil
}

// IsSubcommand reports whether arg is a command word of the registry. main uses it to tell a
// command line from a file name or a title word.
func IsSubcommand(arg string) bool { return findCommand(arg) != nil }

// IsStandalone reports whether the command runs without the GUI: main must not look for the
// running app for it.
func IsStandalone(arg string) bool {
	c := findCommand(arg)
	return c != nil && c.standalone != nil
}

// hasNoAction reports whether name is a command without an action word (ocr, info).
func hasNoAction(name string) bool {
	c := findCommand(name)
	return c != nil && c.noAction
}

// CommandNames lists the command words in registry order. standalone selects the kind.
func CommandNames(standalone bool) []string {
	var names []string
	for _, c := range commands {
		if (c.standalone != nil) == standalone {
			names = append(names, c.name)
		}
	}
	return names
}

// NotRunningMessage is the text after "Error: " when a command that needs the app finds none.
// The words come from the registry, so a new command shows up in it by itself.
func NotRunningMessage() string {
	return "md-memo is not running. Start MD-Memo first: " + joinWords(CommandNames(false)) +
		" need the running app (" + joinWords(CommandNames(true)) + " do not)."
}

// joinWords writes "a", "a and b" or "a, b and c".
func joinWords(words []string) string {
	switch len(words) {
	case 0:
		return ""
	case 1:
		return words[0]
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}
