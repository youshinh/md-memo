package cli

import (
	"flag"
	"io"
	"strings"
)

// The older commands (buffer, tab, jev, agent, ocr) hand their arguments to flag.FlagSet.Parse,
// which stops at the FIRST positional argument: `ocr shot.png --json` treats --json as a file
// name, and `buffer append hi --tab 2` appends "hi --tab 2". That is documented ("flags come
// before the text") and is left exactly as it is: for buffer append the text may legitimately
// contain dashes.
//
// The newer commands (info, scrap, config, and buffer get --out) have no free text after their
// words, so they accept flags on either side of the positional arguments, which is what people
// and agents type ("scrap search foo --limit 5", "config get vision --json").

// newQuietFlagSet makes a flag set that prints nothing by itself: the caller returns the error
// and main prints it once as "Error: ...", instead of flag also dumping its own usage.
func newQuietFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	return fs
}

// parseInterspersed parses args with fs, allowing flags before, between and after the positional
// arguments, and returns the positional arguments in order. "--" ends the flags: everything after
// it is positional, so a search text such as "-x" is written "scrap search -- -x". A lone "-" is a
// positional argument. Errors are flag's own (unknown flag, missing value, bad number); an
// undefined -h / -help comes back as flag.ErrHelp.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var flagArgs, positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if len(a) < 2 || a[0] != '-' {
			positional = append(positional, a)
			continue
		}
		flagArgs = append(flagArgs, a)
		name := strings.TrimLeft(a, "-")
		if strings.Contains(name, "=") {
			continue // -flag=value carries its value
		}
		// A flag that is not boolean takes the next argument as its value, whatever that looks like.
		if f := fs.Lookup(name); f != nil && !isBoolFlag(f) && i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	if err := fs.Parse(flagArgs); err != nil {
		return nil, err
	}
	return positional, nil
}

func isBoolFlag(f *flag.Flag) bool {
	b, ok := f.Value.(interface{ IsBoolFlag() bool })
	return ok && b.IsBoolFlag()
}
