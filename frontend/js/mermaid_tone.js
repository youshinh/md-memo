// MD-Memo Mermaid diagram tone. Diagrams were always drawn with Mermaid's "dark" theme on the dark
// preview, and some of them are unreadable that way (a mindmap's root and first branch come out
// near-black with black text). The tone is a setting (Settings > General, general.mermaidTone) and a
// one-click flip on every diagram: dark, or one of three light tones drawn on a white card.
//
// Nothing here costs anything until a note has a diagram: app.js calls it while rendering one.
(function (global) {
  'use strict';

  const TONES = ['dark', 'light', 'neutral', 'forest'];
  const DEFAULT_TONE = 'dark';

  // Mermaid theme behind each tone.
  const THEME = { dark: 'dark', light: 'default', neutral: 'neutral', forest: 'forest' };

  function normalizeTone(value) {
    return TONES.indexOf(value) >= 0 ? value : DEFAULT_TONE;
  }

  // The one-click switch: dark <-> light. The other two tones are picked in Settings.
  function flipTone(value) {
    return normalizeTone(value) === 'dark' ? 'light' : 'dark';
  }

  // What mermaid.initialize() gets. The dark tone is the configuration the app has always used.
  function mermaidConfig(tone) {
    const t = normalizeTone(tone);
    const cfg = { startOnLoad: false, securityLevel: 'strict', theme: THEME[t] };
    if (t === 'dark') {
      cfg.themeVariables = {
        darkMode: true,
        background: '#252526',
        primaryColor: '#007acc',
        textColor: '#d4d4d4'
      };
    }
    return cfg;
  }

  // CSS classes for the card a diagram sits in (style.css: .mermaid-card / .tone-*).
  function cardClasses(tone) {
    return ['mermaid-card', 'tone-' + normalizeTone(tone)];
  }

  const TONE_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>';

  // Turns the <pre> that held the diagram source into the diagram's card and gives it the flip button.
  // `onFlip` is called with no arguments when the button is pressed.
  function decorate(container, tone, title, onFlip) {
    if (!container) return;
    container.classList.remove('tone-dark', 'tone-light', 'tone-neutral', 'tone-forest');
    cardClasses(tone).forEach(function (c) { container.classList.add(c); });
    const doc = container.ownerDocument;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'mermaid-tone-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = TONE_ICON;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onFlip();
    });
    container.appendChild(btn);
  }

  global.MermaidTone = {
    TONES: TONES,
    normalizeTone: normalizeTone,
    flipTone: flipTone,
    mermaidConfig: mermaidConfig,
    cardClasses: cardClasses,
    decorate: decorate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.MermaidTone;
  }
})(typeof window !== 'undefined' ? window : globalThis);
