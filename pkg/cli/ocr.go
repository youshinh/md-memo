package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"md-memo/pkg/llm"
	"md-memo/pkg/ocr"
	"md-memo/pkg/scrap"
)

// ocrTimeout covers both engines: the cloud attempt (capped at 30 s inside ocr.Recognize) and,
// if it fails, the on-device fallback that follows.
const ocrTimeout = 60 * time.Second

// ocrRecognize and scrapAppendRaw are indirected so tests can drive runOCR end-to-end without
// invoking a real OCR engine/cloud call or writing into a real scraps directory.
var (
	ocrRecognize   = ocr.Recognize
	scrapAppendRaw = scrap.AppendRaw
)

// ocrFileConfig is the slice of config.json this command needs: where to file the resulting
// note, and how to reach a cloud vision model when the on-device OCR engine is unavailable.
// Vision mirrors llm.VisionConfig exactly, since it is read from the same config.json a running
// md-memo instance also reads.
//
// The file is read through the shared, read-only Config (config.go), so the scrap folder is looked
// up the way the app does it (the legacy top-level "scrap_dir", overridden by "scraps.scrapDir" -
// the key the Settings screen actually writes). Reading only the legacy key filed every image
// into the default folder, wherever the user's notes really were.
type ocrFileConfig struct {
	ScrapDir string
	Vision   llm.VisionConfig
}

func loadOCRFileConfig() ocrFileConfig {
	return ocrConfigFrom(LoadConfig())
}

// parseOCRFileConfig has no I/O so it is directly unit-testable: loadOCRFileConfig's job is
// only to find and read config.json, this is all the actual parsing logic.
func parseOCRFileConfig(data []byte) ocrFileConfig {
	return ocrConfigFrom(ParseConfig(data))
}

func ocrConfigFrom(c *Config) ocrFileConfig {
	cfg := ocrFileConfig{ScrapDir: c.ScrapDir()}
	c.Section("vision", &cfg.Vision)
	return cfg
}

func (r *HeadlessRunner) runOCR(args []string) (int, error) {
	fs := flag.NewFlagSet("ocr", flag.ContinueOnError)
	fs.SetOutput(r.stderr)
	forceJSON := fs.Bool("json", false, "Force JSON output")
	if err := fs.Parse(args); err != nil {
		return 1, err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		return 1, errors.New("usage: md-memo ocr <imagePath>")
	}
	imagePath := rest[0]

	if _, err := os.Stat(imagePath); err != nil {
		return 1, fmt.Errorf("cannot read %s: %w", imagePath, err)
	}

	cfg := loadOCRFileConfig()
	ctx, cancel := context.WithTimeout(context.Background(), ocrTimeout)
	defer cancel()

	text, err := ocrRecognize(ctx, imagePath, cfg.Vision)
	if err != nil {
		return 1, fmt.Errorf("OCR failed: %w", err)
	}

	entry := ocr.FormatEntry(text)
	format := ResolveFormat(*forceJSON)

	if entry == "" {
		if format == FormatJSON {
			PrintFormatted(r.stdout, FormatJSON, "", map[string]interface{}{"text": "", "appended": false})
		} else {
			fmt.Fprintln(r.stdout, "(no text recognized)")
		}
		return 0, nil
	}

	notePath, err := scrapAppendRaw(cfg.ScrapDir, entry, time.Now())
	if err != nil {
		return 1, fmt.Errorf("failed to append to scrap: %w", err)
	}

	if format == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", map[string]interface{}{"text": text, "appended": true, "path": notePath})
	} else {
		fmt.Fprintf(r.stdout, "OCR text appended to %s\n", notePath)
	}
	return 0, nil
}
