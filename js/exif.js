// Dependency-free EXIF reader for JPEG files.
// Works on any ES runtime: only ArrayBuffer/DataView and plain JS are used.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const MAX_IFD_ENTRIES = 512;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

const TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  DATETIME_ORIGINAL: 0x9003,
  FOCAL_LENGTH: 0x920a,
  PIXEL_WIDTH: 0xa002,
  PIXEL_HEIGHT: 0xa003,
  FOCAL_PLANE_XRES: 0xa20e,
  FOCAL_PLANE_UNIT: 0xa210,
  DIGITAL_ZOOM: 0xa404,
  FOCAL_35: 0xa405,
  GPS_LAT_REF: 0x0001,
  GPS_LAT: 0x0002,
  GPS_LON_REF: 0x0003,
  GPS_LON: 0x0004,
  GPS_ALT_REF: 0x0005,
  GPS_ALT: 0x0006,
  GPS_DIR_REF: 0x0010,
  GPS_DIR: 0x0011,
  GPS_H_ERROR: 0x001f,
};

/**
 * Parse EXIF from a JPEG.
 * @param {ArrayBuffer} buf  the whole file (or at least its first 256 KB)
 * @returns {null | {
 *   lat: number|null,        // decimal degrees, negative south
 *   lon: number|null,        // decimal degrees, negative west
 *   alt: number|null,        // meters (negative if GPSAltitudeRef == 1)
 *   direction: number|null,  // GPSImgDirection in degrees 0..360 (as stored; see directionRef)
 *   directionRef: 'T'|'M'|null, // GPSImgDirectionRef: true or magnetic north
 *   hError: number|null,     // GPSHPositioningError: horizontal position error, meters
 *   focalLength: number|null,   // mm (tag 0x920A)
 *   focal35: number|null,       // FocalLengthIn35mmFilm (tag 0xA405), null if 0/absent
 *   digitalZoom: number|null,   // DigitalZoomRatio (tag 0xA404)
 *   focalPlaneXRes: number|null, focalPlaneUnit: number|null,  // sensor pixel pitch (0xA20E, 0xA210)
 *   make: string|null, model: string|null,
 *   orientation: number|null,   // tag 0x0112, 1..8
 *   pixelWidth: number|null,    // ExifImageWidth 0xA002
 *   pixelHeight: number|null,   // ExifImageHeight 0xA003
 *   dateTime: string|null       // DateTimeOriginal 0x9003
 * }}  null if the buffer is not a JPEG or has no EXIF APP1 segment
 */
export function parseExif(buf) {
  try {
    return parseJpeg(buf);
  } catch (e) {
    return null;
  }
}

function parseJpeg(buf) {
  if (!buf || typeof buf.byteLength !== 'number') return null;
  const dv = new DataView(buf);
  const len = dv.byteLength;
  if (len < 4 || dv.getUint8(0) !== 0xff || dv.getUint8(1) !== 0xd8) return null;

  let pos = 2;
  while (pos + 4 <= len) {
    if (dv.getUint8(pos) !== 0xff) break;
    const marker = dv.getUint8(pos + 1);
    if (marker === 0xff) { // fill byte
      pos += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS or EOI: no more headers
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // standalone markers without a length
      continue;
    }
    const segLen = dv.getUint16(pos + 2);
    if (segLen < 2) break;
    if (marker === 0xe1 && hasExifHeader(dv, pos + 4, len)) {
      return parseTiff(dv, pos + 10, Math.min(pos + 2 + segLen, len));
    }
    pos += 2 + segLen;
  }
  return null;
}

function hasExifHeader(dv, p, len) {
  if (p + EXIF_HEADER.length > len) return false;
  for (let i = 0; i < EXIF_HEADER.length; i++) {
    if (dv.getUint8(p + i) !== EXIF_HEADER[i]) return false;
  }
  return true;
}

function parseTiff(dv, tb, limit) {
  if (tb + 8 > limit) return null;
  const bo = dv.getUint16(tb);
  const le = bo === 0x4949 ? true : bo === 0x4d4d ? false : null;
  if (le === null || dv.getUint16(tb + 2, le) !== 42) return null;

  const t = { dv, tb, limit, le };
  const ifd0 = readIfd(t, dv.getUint32(tb + 4, le));
  if (!ifd0) return null;
  const exif = readIfd(t, first(readNumbers(t, ifd0, TAG.EXIF_IFD)));
  const gps = readIfd(t, first(readNumbers(t, ifd0, TAG.GPS_IFD)));

  const orientation = first(readNumbers(t, ifd0, TAG.ORIENTATION));
  const dirRef = readAscii(t, gps, TAG.GPS_DIR_REF);
  const altRef = first(readNumbers(t, gps, TAG.GPS_ALT_REF));
  const alt = first(readNumbers(t, gps, TAG.GPS_ALT));
  const f35 = first(readNumbers(t, exif, TAG.FOCAL_35));

  return {
    lat: coord(readNumbers(t, gps, TAG.GPS_LAT), readAscii(t, gps, TAG.GPS_LAT_REF), 'S'),
    lon: coord(readNumbers(t, gps, TAG.GPS_LON), readAscii(t, gps, TAG.GPS_LON_REF), 'W'),
    alt: alt === null ? null : altRef === 1 ? -alt : alt,
    direction: first(readNumbers(t, gps, TAG.GPS_DIR)),
    directionRef: dirRef === 'T' || dirRef === 'M' ? dirRef : null,
    hError: first(readNumbers(t, gps, TAG.GPS_H_ERROR)),
    focalLength: first(readNumbers(t, exif, TAG.FOCAL_LENGTH)),
    focal35: f35 || null,
    digitalZoom: first(readNumbers(t, exif, TAG.DIGITAL_ZOOM)),
    focalPlaneXRes: first(readNumbers(t, exif, TAG.FOCAL_PLANE_XRES)),
    focalPlaneUnit: first(readNumbers(t, exif, TAG.FOCAL_PLANE_UNIT)),
    make: readAscii(t, ifd0, TAG.MAKE),
    model: readAscii(t, ifd0, TAG.MODEL),
    orientation: orientation >= 1 && orientation <= 8 ? orientation : null,
    pixelWidth: first(readNumbers(t, exif, TAG.PIXEL_WIDTH)),
    pixelHeight: first(readNumbers(t, exif, TAG.PIXEL_HEIGHT)),
    dateTime: readAscii(t, exif, TAG.DATETIME_ORIGINAL),
  };
}

// Returns Map(tag -> {type, count, pos}) with pos as an absolute byte offset,
// or null if the IFD offset itself is unreadable. Entries whose data would
// fall outside the segment are skipped.
function readIfd(t, off) {
  if (off === null || off === undefined) return null;
  const { dv, tb, limit, le } = t;
  const start = tb + off;
  if (start + 2 > limit) return null;
  const n = Math.min(dv.getUint16(start, le), MAX_IFD_ENTRIES);
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const p = start + 2 + i * 12;
    if (p + 12 > limit) break;
    const tag = dv.getUint16(p, le);
    const type = dv.getUint16(p + 2, le);
    const count = dv.getUint32(p + 4, le);
    const unit = TYPE_SIZE[type];
    if (!unit || count === 0) continue;
    const size = unit * count;
    const pos = size <= 4 ? p + 8 : tb + dv.getUint32(p + 8, le);
    if (pos + size > limit) continue;
    entries.set(tag, { type, count, pos });
  }
  return entries;
}

function readNumbers(t, entries, tag) {
  const e = entries && entries.get(tag);
  if (!e) return null;
  const { dv, le } = t;
  const { type, count, pos } = e;
  const out = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1:
      case 7:
        out.push(dv.getUint8(pos + i));
        break;
      case 3:
        out.push(dv.getUint16(pos + 2 * i, le));
        break;
      case 4:
        out.push(dv.getUint32(pos + 4 * i, le));
        break;
      case 9:
        out.push(dv.getInt32(pos + 4 * i, le));
        break;
      case 5:
        out.push(ratio(dv.getUint32(pos + 8 * i, le), dv.getUint32(pos + 8 * i + 4, le)));
        break;
      case 10:
        out.push(ratio(dv.getInt32(pos + 8 * i, le), dv.getInt32(pos + 8 * i + 4, le)));
        break;
      default:
        return null;
    }
  }
  return out;
}

function readAscii(t, entries, tag) {
  const e = entries && entries.get(tag);
  if (!e || e.type !== 2) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = t.dv.getUint8(e.pos + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

function ratio(num, den) {
  return den === 0 ? null : num / den;
}

function first(arr) {
  return arr && arr.length ? arr[0] : null;
}

function coord(parts, ref, negRef) {
  if (!parts || parts.length < 3) return null;
  if (parts[0] === null || parts[1] === null || parts[2] === null) return null;
  const v = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return ref === negRef ? -v : v;
}
