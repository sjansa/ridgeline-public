// lens.js -- what the picture's metadata says about the lens.
//
// Photos: focal length, digital zoom and after-the-fact crops from EXIF.
// Live view: which lens a camera's name implies, and the zoom steps to offer.
// No browser dependencies, so the tests can run it in Node.

const DIAG_35 = 43.27;                   // mm, diagonal of a 35 mm film frame
const UNIT_MM = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 };   // FocalPlaneResolutionUnit

/**
 * Focal length of a photo as a fraction of its width (Camera.fn).
 *
 * exif: from parseExif. w, h: the picture as displayed (after EXIF rotation).
 * Returns {fn, known, zooms, why}: fn is null when EXIF says nothing useful;
 * zooms lists focal multiples the solver should also try when EXIF is
 * ambiguous (null when it is not).
 */
export function photoLens(exif, w, h) {
  if (!exif) return { fn: null, known: false, zooms: null, why: 'no EXIF' };
  // The frame as the camera recorded it, turned to match the displayed picture.
  let W0 = exif.pixelWidth, H0 = exif.pixelHeight;
  if (W0 > 0 && H0 > 0 && (W0 > H0) !== (w > h)) [W0, H0] = [H0, W0];
  const whole = W0 > 0 && H0 > 0;

  let f35 = exif.focal35, why = '35 mm equivalent from EXIF', opticalOnly = false;
  if (!f35 && exif.focalLength > 0 && exif.focalPlaneXRes > 0 && whole && UNIT_MM[exif.focalPlaneUnit]) {
    // No 35 mm figure, but the sensor size can be worked out from its pixel pitch.
    const mmPerPx = UNIT_MM[exif.focalPlaneUnit] / exif.focalPlaneXRes;
    f35 = exif.focalLength * DIAG_35 / (Math.hypot(exif.pixelWidth, exif.pixelHeight) * mmPerPx);
    why = 'focal length and sensor size from EXIF'; opticalOnly = true;
  }
  if (!(f35 > 3 && f35 < 3000)) return { fn: null, known: false, zooms: null, why: 'no focal length in EXIF' };

  // Digital zoom. Apple folds it into the 35 mm figure (a 2x crop of the 24 mm
  // camera is tagged 48 mm); other makers differ, and a figure derived from
  // the sensor never includes it. Where it is unclear, let the solver try both.
  const dz = exif.digitalZoom > 1.01 && exif.digitalZoom < 100 ? exif.digitalZoom : 1;
  let zooms = null;
  if (dz > 1) {
    if (opticalOnly) { f35 *= dz; why += `, x${dz.toFixed(1)} digital zoom`; }
    else if (!/apple/i.test(exif.make || '')) zooms = [1, dz];
  }

  // Focal length in pixels of the frame as recorded, then of this picture.
  // A plain resize keeps the shape; a different shape means it was cropped,
  // and the usual crop keeps the full extent of one side.
  const a = w / h, a0 = whole ? W0 / H0 : a;
  let fpx = f35 / DIAG_35 * Math.hypot(w, h);
  if (whole && Math.abs(a / a0 - 1) > 0.02) {
    const s = a > a0 ? w / W0 : h / H0;      // wider than recorded: the width survived
    fpx = f35 / DIAG_35 * Math.hypot(W0, H0) * s;
    why += ', cropped';
  }
  return { fn: fpx / w, known: true, zooms, why };
}

/**
 * What a camera's name says about its lens. mult is its focal length at zoom
 * 1 relative to the main camera. iOS names its cameras; "Triple" and "Dual
 * Wide" are virtual cameras that start at the ultra-wide and change lens as
 * the zoom rises. Android gives numbers only.
 */
export function describeCamera(label, index = 0) {
  const l = label || '';
  if (/triple|dual wide/i.test(l)) return { name: 'All lenses', mult: 0.5, sure: true };
  if (/ultra/i.test(l)) return { name: 'Ultra wide', mult: 0.5, sure: true };
  if (/tele/i.test(l)) return { name: 'Telephoto', mult: 3, sure: false };
  if (/dual/i.test(l)) return { name: 'Main + telephoto', mult: 1, sure: true };
  if (/^back camera$/i.test(l.trim())) return { name: 'Main', mult: 1, sure: true };
  return { name: `Camera ${index + 1}`, mult: 1, sure: false };
}

/** Is this a camera on the back of the phone, going by its name? */
export function isBackCamera(label) {
  return /back|rear|environment/i.test(label || '') && !/front|user|selfie/i.test(label || '');
}

/** Zoom steps to offer, in the units the phone's own camera app shows. */
export function zoomSteps(min, max) {
  const out = [0.5, 1, 2, 3, 5, 10].filter(z => z >= min * 0.98 && z <= max * 1.02);
  if (!out.length || out[0] > min * 1.3) out.unshift(Math.round(min * 10) / 10);
  return out.slice(0, 5);
}
