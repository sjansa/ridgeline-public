// lerc1.js -- decode LERC version 1 ("CntZImage") blobs: what the USGS 3DEP
// elevation service sends for format=lerc. LERC stores each block of pixels as
// an offset plus small integers bit-packed at a stated tolerance, so 1 m
// elevations come over about five times smaller than raw floats. No DOM.
//
// Adapted from Esri's LercDecode.js (lerc 2.0.0, the version 1 decoder):
//   Copyright 2015-2018 Esri. Licensed under the Apache License, Version 2.0
//   (the "License"); you may not use this file except in compliance with the
//   License. You may obtain a copy of the License at
//   http://www.apache.org/licenses/LICENSE-2.0 . Distributed on an "AS IS"
//   BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND. Source and notices:
//   https://github.com/Esri/lerc/
// Changes: an ES module returning only what Ridgeline needs; masked pixels come
// back as NaN; uncompressed blocks sized by their own pixel count.

/**
 * Decode a LERC 1 blob.
 * Returns {width, height, data: Float32Array (row-major, top row first, NaN where
 * there is no data), maxZError}.
 */
export function decodeLerc1(buf) {
  const id = String.fromCharCode(...new Uint8Array(buf, 0, 10));
  if (id.trim() !== 'CntZImage') throw new Error('Not a LERC 1 blob.');
  let v = new DataView(buf, 10, 24), fp = 34;
  const height = v.getUint32(8, true), width = v.getUint32(12, true), maxZError = v.getFloat64(16, true);

  // mask: one bit per pixel, run-length coded; none means every pixel is valid
  v = new DataView(buf, fp, 16); fp += 16;
  const mBlocksY = v.getUint32(0, true), mBytes = v.getUint32(8, true), mMax = v.getFloat32(12, true);
  let mask = null;
  if (mBytes > 0) {
    mask = new Uint8Array(Math.ceil(width * height / 8));
    const m = new DataView(buf, fp, mBytes);
    let cnt = m.getInt16(0, true), ip = 2, op = 0;
    do {
      if (cnt > 0) { while (cnt--) mask[op++] = m.getUint8(ip++); }
      else { const val = m.getUint8(ip++); cnt = -cnt; while (cnt--) mask[op++] = val; }
      cnt = m.getInt16(ip, true); ip += 2;
    } while (ip < mBytes);
    if (cnt !== -32768 || op < mask.length) throw new Error('Bad LERC mask.');
    fp += mBytes;
  } else if ((mBytes | mBlocksY | mMax) === 0) {
    mask = new Uint8Array(Math.ceil(width * height / 8));     // no data at all
  }
  const valid = i => !mask || (mask[i >> 3] & (128 >> (i & 7)));

  // pixels: a grid of blocks, plus a narrower last column / row of blocks for the remainder
  v = new DataView(buf, fp, 16); fp += 16;
  const nY = v.getUint32(0, true), nX = v.getUint32(4, true), maxValue = v.getFloat32(12, true);
  const bw = Math.floor(width / nX), bh = Math.floor(height / nY);
  const out = new Float32Array(width * height).fill(NaN), scale = 2 * maxZError;
  const vals = new Float32Array(bw * bh + width + height);
  for (let by = 0; by <= nY; by++) {
    const h = by < nY ? bh : height % nY;
    if (!h) continue;
    for (let bx = 0; bx <= nX; bx++) {
      const w = bx < nX ? bw : width % nX;
      if (!w) continue;
      const y0 = by * bh, x0 = bx * bw;
      let nValid = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (valid((y0 + y) * width + x0 + x)) nValid++;
      const b = new DataView(buf, fp, Math.min(10, buf.byteLength - fp));
      let head = b.getUint8(0), size = 1;
      const enc = head & 63;
      if (enc > 3) throw new Error('Bad LERC block.');
      let offset = 0, src = null, count = nValid;
      if (enc === 1 || enc === 3) {
        const t = head >> 6;
        if (t === 2) { offset = b.getInt8(1); size += 1; } else if (t === 1) { offset = b.getInt16(1, true); size += 2; } else { offset = b.getFloat32(1, true); size += 4; }
        if (enc === 1) {
          head = b.getUint8(size); size++;
          const bits = head & 63, nt = head >> 6;
          if (nt === 2) { count = b.getUint8(size); size += 1; } else if (nt === 1) { count = b.getUint16(size, true); size += 2; } else { count = b.getUint32(size, true); size += 4; }
          fp += size;
          const nBytes = Math.ceil(count * bits / 8), words = new Uint32Array(Math.ceil(nBytes / 4));
          new Uint8Array(words.buffer).set(new Uint8Array(buf, fp, nBytes));
          fp += nBytes;
          unstuff(words, bits, count, offset, scale, vals, maxValue, nBytes);
          src = vals;
        } else fp += size;
      } else if (enc === 0) {
        fp += 1;
        src = new Float32Array(buf.slice(fp, fp + nValid * 4));
        fp += nValid * 4;
      } else fp += 1;                       // enc 2: all zero
      if (src && count !== nValid) throw new Error('LERC block and mask do not match.');
      let k = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y0 + y) * width + x0 + x;
        if (valid(i)) out[i] = src ? src[k++] : enc === 3 ? offset : 0;
      }
    }
  }
  return { width, height, data: out, maxZError };
}

// Values packed most significant bit first into little-endian 32-bit words;
// the last word holds only the bytes that belong to this block.
function unstuff(src, bits, n, offset, scale, dest, maxValue, nBytes) {
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1, nmax = Math.ceil((maxValue - offset) / scale);
  src[src.length - 1] <<= 8 * (src.length * 4 - nBytes);
  let i = 0, left = 0, word = 0;
  for (let o = 0; o < n; o++) {
    let q;
    if (left === 0) { word = src[i++]; left = 32; }
    if (left >= bits) { q = (word >>> (left - bits)) & mask; left -= bits; }
    else {
      const miss = bits - left;
      q = ((word & mask) << miss) & mask;
      word = src[i++]; left = 32 - miss;
      q += word >>> left;
    }
    // quantization can overshoot the block's top value
    dest[o] = q < nmax ? offset + q * scale : maxValue;
  }
}
