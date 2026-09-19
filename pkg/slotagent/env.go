package slotagent

import (
	"bufio"
	"os"
	"strings"
)

// LoadEnvFile reads a key-value .env file and returns a map of environment variables.
// It ignores comment lines (starting with #), empty lines, and supports basic quotes (" or ').
func LoadEnvFile(envPath string) (map[string]string, error) {
	file, err := os.Open(envPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	envMap := make(map[string]string)
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Strip 'export ' prefix if present
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		eqIdx := strings.Index(line, "=")
		if eqIdx == -1 {
			continue
		}

		key := strings.TrimSpace(line[:eqIdx])
		if key == "" {
			continue
		}

		val := strings.TrimSpace(line[eqIdx+1:])

		// Handle quoted values
		if (strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"") && len(val) >= 2) ||
			(strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'") && len(val) >= 2) {
			val = val[1 : len(val)-1]
		} else {
			// Strip inline comments if unquoted: KEY=val # comment
			if commentIdx := strings.Index(val, " #"); commentIdx != -1 {
				val = strings.TrimSpace(val[:commentIdx])
			}
		}

		envMap[key] = val
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return envMap, nil
}

// MergeProcessEnv merges variables from envMap into baseEnv (e.g. os.Environ()).
// Values in envMap take precedence over existing keys in baseEnv.
func MergeProcessEnv(baseEnv []string, envMap map[string]string) []string {
	if len(envMap) == 0 {
		return baseEnv
	}

	resMap := make(map[string]string, len(baseEnv)+len(envMap))

	for _, item := range baseEnv {
		eqIdx := strings.Index(item, "=")
		if eqIdx != -1 {
			k := item[:eqIdx]
			v := item[eqIdx+1:]
			resMap[k] = v
		}
	}

	for k, v := range envMap {
		resMap[k] = v
	}

	result := make([]string, 0, len(resMap))
	for k, v := range resMap {
		result = append(result, k+"="+v)
	}

	return result
}
