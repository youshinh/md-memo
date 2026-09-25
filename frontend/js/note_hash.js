// MD-Memo: the hash of a note's text, the value `buffer.get` reports as "hash" and that
// `buffer.set --expected-hash` / `buffer.save` compare against.
//
//   NoteHash.hash16(text) -> string     the first 8 bytes (16 hex characters) of SHA-256 of the UTF-8 text
//   NoteHash.sha256Hex(text) -> string  the whole SHA-256, 64 hex characters
//
// It is the same function as computeHash in app_rpc.go (which hashes a Go string, i.e. UTF-8). The page needs
// its own copy because the optimistic lock of the RPC writes must check the hash and write in ONE synchronous
// step (crypto.subtle is asynchronous: a keystroke could land between the check and the write). A lone
// surrogate is hashed as U+FFFD (EF BF BD), which is what Go makes of it when the text crosses the RPC.
//
// Pure: no DOM, nothing runs until it is called (the RPC writes, buffer.save), so it costs nothing at start-up.
(function (global) {
  'use strict';

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  // The UTF-8 bytes of a JS string, by hand: TextEncoder is not a JS built-in (a bare vm context lacks it) and
  // this keeps the lone-surrogate rule explicit.
  function utf8Bytes(str) {
    const s = String(str);
    const out = new Uint8Array(s.length * 3);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // a lone surrogate
      if (c < 0x80) {
        out[n++] = c;
      } else if (c < 0x800) {
        out[n++] = 0xc0 | (c >> 6);
        out[n++] = 0x80 | (c & 0x3f);
      } else if (c < 0x10000) {
        out[n++] = 0xe0 | (c >> 12);
        out[n++] = 0x80 | ((c >> 6) & 0x3f);
        out[n++] = 0x80 | (c & 0x3f);
      } else {
        out[n++] = 0xf0 | (c >> 18);
        out[n++] = 0x80 | ((c >> 12) & 0x3f);
        out[n++] = 0x80 | ((c >> 6) & 0x3f);
        out[n++] = 0x80 | (c & 0x3f);
      }
    }
    return out.subarray(0, n);
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Bytes(bytes) {
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const len = bytes.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const bitsHigh = Math.floor(len / 0x20000000); // len * 8 / 2^32
    const bitsLow = (len << 3) >>> 0;
    const end = padded.length;
    padded[end - 8] = (bitsHigh >>> 24) & 0xff;
    padded[end - 7] = (bitsHigh >>> 16) & 0xff;
    padded[end - 6] = (bitsHigh >>> 8) & 0xff;
    padded[end - 5] = bitsHigh & 0xff;
    padded[end - 4] = (bitsLow >>> 24) & 0xff;
    padded[end - 3] = (bitsLow >>> 16) & 0xff;
    padded[end - 2] = (bitsLow >>> 8) & 0xff;
    padded[end - 1] = bitsLow & 0xff;

    const w = new Uint32Array(64);
    for (let off = 0; off < end; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    let hex = '';
    for (let i = 0; i < 8; i++) hex += ('00000000' + h[i].toString(16)).slice(-8);
    return hex;
  }

  function sha256Hex(text) {
    return sha256Bytes(utf8Bytes(text));
  }

  function hash16(text) {
    return sha256Hex(text).slice(0, 16);
  }

  const api = { hash16: hash16, sha256Hex: sha256Hex, utf8Bytes: utf8Bytes };
  global.NoteHash = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
