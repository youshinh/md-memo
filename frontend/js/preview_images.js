// MD-Memo note preview, local images. Two things kept the picture of a generated diagram from
// showing on macOS (and for any Windows user name with a space):
//
//  1. markdown-it does not read `![alt](/Users/me/Library/Application Support/x.png)` as an image at
//     all: a raw space ends the link target, so the preview showed the Markdown source. installLooseImageRule()
//     teaches it to accept a space in the target when the target ends in an image extension.
//  2. Once markdown-it did read a target, it handed the preview a percent-encoded `src`
//     ("Application%20Support", "%E5%86%99%E7%9C%9F.png") and the preview asked /api/image for that
//     text as if it were the file name. resolveLocalImagePath() decodes it first.
//
// Nothing here runs until a note contains an image, and the rule costs one character comparison
// per inline position that does not start with "![".
(function (global) {
  'use strict';

  const IMAGE_EXT = 'png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico';
  // ![alt](target with a space.ext) - no quotes (a title), no angle brackets (already the CommonMark
  // way to allow spaces) and no parentheses in the target; the target must end in an image extension.
  const LOOSE_IMAGE = new RegExp(
    '^!\\[([^\\]\\n]*)\\]\\(([^()<>"\\n]*?\\s[^()<>"\\n]*?\\.(?:' + IMAGE_EXT + '))\\)', 'i');

  // Adds an inline rule in front of markdown-it's own `image` rule. It only fires for a target the
  // built-in rule cannot read (one with whitespace in it), and otherwise builds the same token.
  function installLooseImageRule(md) {
    if (!md || !md.inline || !md.inline.ruler || md.__looseImageRule) return;
    md.__looseImageRule = true;
    md.inline.ruler.before('image', 'image_loose', function (state, silent) {
      const pos = state.pos;
      // Cheap exit for nearly every position: "![" is the only start.
      if (state.src.charCodeAt(pos) !== 0x21 || state.src.charCodeAt(pos + 1) !== 0x5B) return false;
      const m = LOOSE_IMAGE.exec(state.src.slice(pos, pos + 4096));
      if (!m) return false;
      const url = state.md.normalizeLink(m[2].trim());
      if (!state.md.validateLink(url)) return false;
      if (!silent) {
        const content = m[1];
        const children = [];
        state.md.inline.parse(content, state.md, state.env, children);
        const token = state.push('image', 'img', 0);
        token.attrs = [['src', url], ['alt', '']];
        token.children = children;
        token.content = content;
      }
      state.pos += m[0].length;
      return true;
    });
  }

  function decodeEscapes(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s; // a stray "%" that is not an escape: keep the text as it is
    }
  }

  // The file system path a rendered <img src> stands for, or null when it is not a local file
  // (a web address, a data: URI, or a preview URL that is already served by the app).
  function resolveLocalImagePath(rawSrc, noteDir) {
    if (!rawSrc) return null;
    if (rawSrc.startsWith('http://') || rawSrc.startsWith('https://') || rawSrc.startsWith('data:') || rawSrc.startsWith('/api/image')) {
      return null;
    }
    let p = rawSrc;
    if (p.startsWith('file://')) {
      p = p.slice(7);
      // file:///C:/x has the drive after a slash that is not part of the path; file:///Users/x keeps it.
      if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
    }
    p = decodeEscapes(p);
    const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(p);
    const isUnixAbs = p.startsWith('/');
    if (!isWindowsAbs && !isUnixAbs && noteDir) {
      p = noteDir + '/' + p;
    }
    return p;
  }

  global.PreviewImages = {
    installLooseImageRule: installLooseImageRule,
    resolveLocalImagePath: resolveLocalImagePath
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      installLooseImageRule: installLooseImageRule,
      resolveLocalImagePath: resolveLocalImagePath,
      LOOSE_IMAGE: LOOSE_IMAGE
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
