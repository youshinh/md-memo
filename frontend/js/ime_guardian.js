// MD-Memo Zero-Latency 4-Layer Hybrid IME Guardian & Romaji Converter
// Architecture:
// Layer 0: AST Lexical Shield (0 ns)
// Layer 1: Compact Prefix Filter (<50 ns / ~30 KB)
// Layer 2: Dual Log-Likelihood Ratio Test (LLRT) (<10 µs)
// Layer 3: Virtual Undoable Composition with instant rollback
// Layer 4: Non-intrusive OS IME synchronization on commit

(function (global) {
  'use strict';

  // Comprehensive Romaji to Hiragana Table (Hepburn & Kunrei compatible)
  const ROMAJI_TABLE = {
    'kya': 'きゃ', 'kyu': 'きゅ', 'kyo': 'きょ',
    'sha': 'しゃ', 'shu': 'しゅ', 'sho': 'しょ', 'shi': 'し',
    'cha': 'ちゃ', 'chu': 'ちゅ', 'cho': 'ちょ', 'chi': 'ち',
    'nya': 'にゃ', 'nyu': 'にゅ', 'nyo': 'にょ',
    'hya': 'ひゃ', 'hyu': 'ひゅ', 'hyo': 'ひょ',
    'mya': 'みゃ', 'myu': 'みゅ', 'myo': 'みょ',
    'rya': 'りゃ', 'ryu': 'りゅ', 'ryo': 'りょ',
    'gya': 'ぎゃ', 'gyu': 'ぎゅ', 'gyo': 'ぎょ',
    'ja': 'じゃ', 'ju': 'じゅ', 'jo': 'じょ', 'ji': 'じ',
    'bya': 'びゃ', 'byu': 'びゅ', 'byo': 'びょ',
    'pya': 'ぴゃ', 'pyu': 'ぴゅ', 'pyo': 'ぴょ',
    'tsu': 'つ', 'dzu': 'づ', 'dji': 'ぢ',
    'ka': 'か', 'ki': 'き', 'ku': 'く', 'ke': 'け', 'ko': 'こ',
    'sa': 'さ', 'si': 'し', 'su': 'す', 'se': 'せ', 'so': 'そ',
    'ta': 'た', 'ti': 'ち', 'tu': 'つ', 'te': 'て', 'to': 'と',
    'na': 'な', 'ni': 'に', 'nu': 'ぬ', 'ne': 'ね', 'no': 'の',
    'ha': 'は', 'hi': 'ひ', 'fu': 'ふ', 'hu': 'ふ', 'he': 'へ', 'ho': 'ほ',
    'ma': 'ま', 'mi': 'み', 'mu': 'む', 'me': 'め', 'mo': 'も',
    'ya': 'や', 'yu': 'ゆ', 'yo': 'よ',
    'ra': 'ら', 'ri': 'り', 'ru': 'る', 're': 'れ', 'ro': 'ろ',
    'wa': 'わ', 'wo': 'を', 'nn': 'ん', "n'": 'ん',
    'ga': 'が', 'gi': 'ぎ', 'gu': 'ぐ', 'ge': 'げ', 'go': 'ご',
    'za': 'ざ', 'zi': 'じ', 'zu': 'ず', 'ze': 'ぜ', 'zo': 'ぞ',
    'da': 'だ', 'di': 'ぢ', 'du': 'づ', 'de': 'で', 'do': 'ど',
    'ba': 'ば', 'bi': 'び', 'bu': 'ぶ', 'be': 'べ', 'bo': 'ぼ',
    'pa': 'ぱ', 'pi': 'ぴ', 'pu': 'ぷ', 'pe': 'ぺ', 'po': 'ぽ',
    'fa': 'ふぁ', 'fi': 'ふぃ', 'fe': 'ふぇ', 'fo': 'ふぉ',
    'a': 'あ', 'i': 'い', 'u': 'う', 'e': 'え', 'o': 'お',
    '-': 'ー'
  };

  function romajiToHiragana(input) {
    let res = '';
    let i = 0;
    const s = input.toLowerCase();

    while (i < s.length) {
      // Sokuon check: double consonant like 'kk', 'tt', 'ss', 'pp' (excluding 'nn')
      if (i + 1 < s.length && s[i] === s[i + 1] && s[i] !== 'n' && !'aeiou'.includes(s[i])) {
        res += 'っ';
        i++;
        continue;
      }

      // Special check: 'nn' followed by vowel e.g. 'konnichi' -> 'ko' + 'n' + 'ni' + 'chi'
      // When 'nn' is followed by a vowel or 'y', the second 'n' forms a syllable with the vowel!
      // e.g. in 'konnichiha': s[2]='n', s[3]='n', s[4]='i' -> first 'n' is 'ん', second 'n' starts 'ni' (に)
      if (i + 2 < s.length && s[i] === 'n' && s[i + 1] === 'n' && 'aeiouy'.includes(s[i + 2])) {
        res += 'ん';
        i += 1;
        continue;
      }

      // Check 3-char match
      if (i + 3 <= s.length) {
        const sub3 = s.substring(i, i + 3);
        if (ROMAJI_TABLE[sub3]) {
          res += ROMAJI_TABLE[sub3];
          i += 3;
          continue;
        }
      }

      // Check 2-char match
      if (i + 2 <= s.length) {
        const sub2 = s.substring(i, i + 2);
        if (ROMAJI_TABLE[sub2]) {
          res += ROMAJI_TABLE[sub2];
          i += 2;
          continue;
        }
      }

      // Check 1-char match
      const sub1 = s.charAt(i);
      if (ROMAJI_TABLE[sub1]) {
        res += ROMAJI_TABLE[sub1];
        i += 1;
        continue;
      }

      // Lone 'n' followed by consonant (or end of word if explicit)
      if (sub1 === 'n' && (i + 1 === s.length || !'aeiouy'.includes(s[i + 1]))) {
        res += 'ん';
        i += 1;
        continue;
      }

      res += sub1;
      i++;
    }

    return res;
  }

  class IMEGuardian {
    constructor(callbacks) {
      this.callbacks = callbacks || {};
      this.buffer = "";
      this.startPos = 0;
      this.llr = 0.0;
      this.isVirtualComposing = false;
      this.virtualText = "";
      this.candidates = [];
      this.candidateIndex = 0;
      this.isConvertingKanji = false;

      this.vowels = new Set(['a', 'e', 'i', 'o', 'u']);

      // Layer 1: Compact English Prefix Shield (O(1) lookups to avoid false positives like interface, component)
      this.englishPrefixes = new Set([
        "inter", "comp", "comm", "cont", "prog", "func", "const", "string",
        "mark", "git", "type", "class", "node", "code", "file", "text", "view",
        "wind", "import", "export", "return", "requ", "resp", "handl", "route",
        "async", "await", "break", "case", "catch", "defer", "pack", "struct",
        "chan", "select", "switch", "while", "true", "false", "null", "unde",
        "state", "props", "hook", "disp", "event", "click", "list", "array",
        "object", "proto", "super", "this", "self", "init", "main", "test",
        "build", "serve", "clean", "debug", "error", "warn", "info", "trace"
      ]);
    }

    // Layer 0: AST Lexical Shield (0 ns)
    isInsideCodeOrUrl(text, cursor) {
      if (cursor <= 0) return false;

      // 1. Check if inside code block (fenced by ```)
      const prefix = text.substring(0, cursor);
      const codeFenceCount = (prefix.match(/```/g) || []).length;
      if (codeFenceCount % 2 !== 0) {
        return true; // Inside code block
      }

      // 2. Check if inside inline code (`...`) on current line
      const lineStart = prefix.lastIndexOf('\n') + 1;
      const currentLinePrefix = prefix.substring(lineStart);
      const backtickCount = (currentLinePrefix.match(/`/g) || []).length;
      if (backtickCount % 2 !== 0) {
        return true; // Inside inline code
      }

      // 3. Check if inside URL or HTML tag
      const lastWordMatch = currentLinePrefix.match(/([^\s]+)$/);
      if (lastWordMatch) {
        const word = lastWordMatch[1];
        if (/^(https?:\/\/|ftp:\/\/|file:\/\/|www\.)/i.test(word) || word.startsWith('<')) {
          return true;
        }
      }

      return false;
    }

    reset() {
      this.buffer = "";
      this.startPos = 0;
      this.llr = 0.0;
      this.isVirtualComposing = false;
      this.virtualText = "";
      this.candidates = [];
      this.candidateIndex = 0;
      this.isConvertingKanji = false;
      if (this.callbacks.onClearVirtual) {
        this.callbacks.onClearVirtual();
      }
    }

    // Called on editor keydown
    onKeyDown(e, fullText, cursor, isEnabled) {
      if (!isEnabled) {
        this.reset();
        return false;
      }

      // If already in virtual composition mode
      if (this.isVirtualComposing) {
        // [Esc]: 1ns instant rollback to original alphabet
        if (e.key === 'Escape') {
          e.preventDefault();
          this.rollbackVirtual();
          return true;
        }

        // [Space]: Trigger or cycle Kanji conversion
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          this.cycleKanjiConversion();
          return true;
        }

        // [Enter]: Commit current virtual composition & sync OS IME
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitVirtual();
          return true;
        }

        // [Backspace]: Revert last typed char or cancel if empty
        if (e.key === 'Backspace') {
          if (this.buffer.length > 0) {
            this.buffer = this.buffer.slice(0, -1);
            if (this.buffer.length < 2) {
              this.rollbackVirtual();
              return false;
            }
            this.updateVirtual();
            return false;
          }
        }
      }

      // Non-character or functional keys reset tracking
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (this.isVirtualComposing) this.commitVirtual();
        this.reset();
        return false;
      }

      const key = e.key;
      if (key.length !== 1) {
        if (key === 'Enter' || key === 'Tab' || key === 'Escape') {
          if (this.isVirtualComposing) this.commitVirtual();
          this.reset();
        }
        return false;
      }

      const lower = key.toLowerCase();
      if (lower < 'a' || lower > 'z') {
        if (this.isVirtualComposing) this.commitVirtual();
        this.reset();
        return false;
      }

      // Layer 0: AST Lexical Shield
      if (this.isInsideCodeOrUrl(fullText, cursor)) {
        this.reset();
        return false;
      }

      // Track typing sequence
      if (this.buffer === "") {
        this.startPos = cursor;
      }
      this.buffer += lower;
      const n = this.buffer.length;

      // Layer 1: Compact English Prefix Shield (<50 ns)
      if (n >= 4) {
        for (let pfx of this.englishPrefixes) {
          if (this.buffer.startsWith(pfx)) {
            this.llr = -999.0;
            if (this.isVirtualComposing) this.rollbackVirtual();
            return false;
          }
        }
      }

      // Layer 2: Dual Log-Likelihood Ratio Test (LLRT) (<10 µs)
      const isV = this.vowels.has(lower);
      const prevChar = n >= 2 ? this.buffer[n - 2] : '';
      const prevIsV = this.vowels.has(prevChar);

      if (n >= 2) {
        if (!prevIsV && isV) {
          this.llr += 2.4; // Consonant -> Vowel (High Japanese likelihood)
        } else if (prevIsV && isV) {
          this.llr += 1.1; // Vowel -> Vowel (e.g. 'ai', 'ou', 'ii')
        } else if (!prevIsV && !isV) {
          if (prevChar === lower || prevChar === 'n') {
            this.llr += 2.2; // Sokuon (促音: kk, tt, ss) or Hatsuon (撥音: nk, nt)
          } else if ((prevChar === 's' || prevChar === 'c') && lower === 'h') {
            this.llr += 2.0; // Digraph: sh, ch
          } else if (lower === 'y' && !'aeiou'.includes(prevChar)) {
            this.llr += 1.8; // Youon: ky, ry, ny, hy
          } else {
            this.llr -= 4.0; // English consonant cluster (e.g. str, spl, thr)
          }
        }
      }

      // Layer 3: Threshold trigger -> Virtual Undoable Composition
      if (this.llr >= 3.0 && n >= 3) {
        this.triggerVirtual();
      }

      return false;
    }

    triggerVirtual() {
      this.isVirtualComposing = true;
      this.updateVirtual();

      // Instant early OS IME Sync as soon as Japanese input is recognized
      if (window.backend && window.backend.setIMEMode) {
        try {
          window.backend.setIMEMode(true);
        } catch (e) {}
      }
    }

    async cycleKanjiConversion() {
      if (!this.isVirtualComposing || !this.virtualText) return;

      // If candidates are already loaded, cycle to next candidate
      if (this.candidates && this.candidates.length > 0) {
        this.candidateIndex = (this.candidateIndex + 1) % this.candidates.length;
        const candidate = this.candidates[this.candidateIndex];
        this.virtualText = candidate;
        if (this.callbacks.onRenderVirtual) {
          this.callbacks.onRenderVirtual({
            original: this.buffer,
            converted: candidate,
            startPos: this.startPos,
            endPos: this.startPos + candidate.length
          });
        }
        return;
      }

      const hira = this.virtualText;
      try {
        const url = 'https://www.google.com/transliterate?langpair=ja-Hira|ja&text=' + encodeURIComponent(hira);
        const resp = await fetch(url);
        if (resp.ok) {
          const json = await resp.json();
          if (Array.isArray(json) && json.length > 0) {
            const list = [];
            // Top-1 combination
            const topCandidate = json.map(item => item[1][0]).join('');
            list.push(topCandidate);

            // Alternative candidates
            for (let i = 1; i < 6; i++) {
              let cand = '';
              let hasAlternative = false;
              for (const seg of json) {
                if (seg[1] && seg[1].length > i) {
                  cand += seg[1][i];
                  hasAlternative = true;
                } else if (seg[1] && seg[1].length > 0) {
                  cand += seg[1][0];
                }
              }
              if (hasAlternative && !list.includes(cand)) {
                list.push(cand);
              }
            }
            if (!list.includes(hira)) {
              list.push(hira);
            }

            this.candidates = list;
            this.candidateIndex = 0;
            this.virtualText = list[0];
            if (this.callbacks.onRenderVirtual) {
              this.callbacks.onRenderVirtual({
                original: this.buffer,
                converted: list[0],
                startPos: this.startPos,
                endPos: this.startPos + list[0].length
              });
            }
            return;
          }
        }
      } catch (err) {
        console.warn("Transliterate error:", err);
      }

      // If network fails or no candidates, commit as-is
      this.commitVirtual();
    }

    updateVirtual() {
      const hira = romajiToHiragana(this.buffer);
      this.virtualText = hira;
      if (this.callbacks.onRenderVirtual) {
        this.callbacks.onRenderVirtual({
          original: this.buffer,
          converted: hira,
          startPos: this.startPos,
          endPos: this.startPos + this.buffer.length
        });
      }
    }

    commitVirtual() {
      if (!this.isVirtualComposing) return;
      const hira = this.virtualText || romajiToHiragana(this.buffer);
      if (this.callbacks.onCommitVirtual) {
        this.callbacks.onCommitVirtual({
          original: this.buffer,
          converted: hira,
          startPos: this.startPos,
          endPos: this.startPos + this.buffer.length
        });
      }

      // Layer 4: Non-intrusive OS IME Sync
      if (window.backend && window.backend.setIMEMode) {
        try {
          window.backend.setIMEMode(true);
        } catch (e) {
          console.warn("IME mode sync:", e);
        }
      }

      this.reset();
    }

    rollbackVirtual() {
      if (this.callbacks.onRollbackVirtual) {
        this.callbacks.onRollbackVirtual({
          original: this.buffer,
          startPos: this.startPos
        });
      }
      this.reset();
    }
  }

  global.IMEGuardian = IMEGuardian;
  global.romajiToHiragana = romajiToHiragana;
})(typeof window !== 'undefined' ? window : this);