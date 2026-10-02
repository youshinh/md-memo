// MD-Memo: printing the preview (the printer button at the top right of the preview; the paper look is css/print.css).
//
// The window.print() that follows opens the system's print dialog (the app starts WebView2 with the print preview off), where the
// person picks a printer such as "Microsoft Print to PDF" and the paper. What has to be done before that is here: wait for the
// images, and draw the diagrams that are in the DARK tone again in the light one (dark nodes with pale text on white paper are
// unreadable, and a dark background is not printed). The page itself is not touched for good: restore() puts every diagram back.
//
// The file is loaded the first time the button is pressed, so it costs nothing before that.
(function (global) {
  'use strict';

  const IMAGE_WAIT_MS = 6000;

  // Resolves when every image of the pane has loaded (or failed), or after waitMs (IMAGE_WAIT_MS): a picture that never arrives does not
  // stop the printing.
  function imagesReady(pane, waitMs) {
    const pending = Array.prototype.filter.call(pane.querySelectorAll('img'), function (img) { return !img.complete; });
    if (!pending.length) return Promise.resolve();
    const loaded = Promise.all(pending.map(function (img) {
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
    return Promise.race([loaded, new Promise(function (resolve) { setTimeout(resolve, waitMs > 0 ? waitMs : IMAGE_WAIT_MS); })]);
  }

  // Draws one diagram again in the light tone, in place. Returns what restore() needs, or null when it could not be done (the
  // diagram then prints as it is). The children of the card are kept as they are (not as HTML), so that the tone button keeps its
  // listener when they come back.
  async function lighten(card, index) {
    const source = card.dataset ? card.dataset.mermaidSrc : '';
    if (!source) return null;
    const stamp = 'mermaid-print-' + index + '-' + Date.now();
    const result = await global.mermaid.render(stamp, source);
    const holder = card.ownerDocument.createElement('div');
    holder.innerHTML = result.svg;
    const kept = card.ownerDocument.createDocumentFragment();
    while (card.firstChild) kept.appendChild(card.firstChild);
    while (holder.firstChild) card.appendChild(holder.firstChild);
    card.classList.remove('tone-dark');
    card.classList.add('tone-light');
    return { card: card, kept: kept };
  }

  // Gets the pane ready for paper and returns restore(). host.resetMermaid() puts Mermaid's own configuration back to the tone of the
  // settings (it is called as soon as the light diagrams are drawn, not at restore()); host.imageWaitMs shortens the wait for images.
  async function prepare(pane, host) {
    await imagesReady(pane, host && host.imageWaitMs);
    const cards = Array.prototype.slice.call(pane.querySelectorAll('pre.mermaid-card.tone-dark'));
    const done = [];
    if (cards.length && global.mermaid && global.MermaidTone) {
      try {
        global.mermaid.initialize(global.MermaidTone.mermaidConfig('light'));
        for (let i = 0; i < cards.length; i++) {
          try {
            const record = await lighten(cards[i], i);
            if (record) done.push(record);
          } catch (e) { /* this diagram prints as it is */ }
        }
      } finally {
        if (host && typeof host.resetMermaid === 'function') host.resetMermaid();
      }
    }
    let restored = false;
    return function restore() {
      if (restored) return;
      restored = true;
      done.forEach(function (record) {
        const card = record.card;
        if (!card.isConnected) return; // the preview was drawn again meanwhile: this card is gone, the new one is as it should be
        while (card.firstChild) card.removeChild(card.firstChild);
        card.appendChild(record.kept);
        card.classList.remove('tone-light');
        card.classList.add('tone-dark');
      });
    };
  }

  const api = { prepare: prepare, imagesReady: imagesReady };
  global.PrintPreview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
