// sensors.js -- camera stream, device orientation, GPS.
//
// Orientation: the W3C deviceorientation angles give device -> earth as
// Rz(alpha) Rx(beta) Ry(gamma), earth = x east, y north, z up. Android's
// deviceorientationabsolute alpha is referenced to magnetic north. iOS alpha
// starts from an arbitrary heading, so the yaw offset is taken from
// webkitCompassHeading (see compassOffset) and low-pass filtered; the gyro-stabilized alpha then
// carries the motion. Either way the result is only as good as the compass:
// align.js removes what is left.

import { D2R } from './terrain.js?v=1118.0301-1e40894';
import { matMul, yawMat } from './camera.js?v=1118.0301-1e40894';
import { isBackCamera } from './lens.js?v=1118.0301-1e40894';

export async function startCamera(video, deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1280 }, height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return stream;
}

/** The phone's back cameras, [{deviceId, label}]. Names are only filled in once camera access is granted. */
export async function listCameras() {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId);
    const back = all.filter(d => isBackCamera(d.label));
    return (back.length ? back : all.filter(d => !/front|user|selfie/i.test(d.label))).map(d => ({ deviceId: d.deviceId, label: d.label }));
  } catch { return []; }
}

/**
 * The camera's own zoom, where the browser exposes it. Returns null if not,
 * else {min, max, value, set(z)}. set() is safe to call on every pinch move:
 * only the latest value is sent once the previous request has finished.
 */
export function cameraZoom(stream) {
  const track = stream?.getVideoTracks()[0];
  const cap = track?.getCapabilities?.().zoom;
  if (!cap || !(cap.max > cap.min)) return null;
  let busy = false, want = null;
  const send = async () => {
    if (busy) return;
    busy = true;
    while (want != null) {
      const z = want; want = null;
      try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch { /* out of range or mid-switch: the next one corrects it */ }
    }
    busy = false;
  };
  return {
    min: cap.min, max: cap.max, value: track.getSettings().zoom || cap.min,
    set(z) { want = Math.min(cap.max, Math.max(cap.min, z)); send(); },
    read: () => track.getSettings().zoom,
  };
}

function screenAngle() {
  return (screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle : (typeof window.orientation === 'number' ? window.orientation : 0);
}

/** Device -> earth rotation for deviceorientation angles (degrees). */
export function deviceMatrix(alpha, beta, gamma) {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
    cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
    -cB * sG, sB, cB * cG,
  ];
}

/**
 * World -> camera rotation of the back camera for a device matrix and screen
 * rotation. In device axes (x right, y top, z out of the screen) the image's
 * right is (cos t, -sin t, 0), its down is (-sin t, -cos t, 0) and the lens
 * looks along -z, t being the screen angle.
 */
export function cameraFromDevice(M, angleDeg) {
  const t = angleDeg * D2R, c = Math.cos(t), s = Math.sin(t);
  const col = (x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
  return [...col(c, -s, 0), ...col(-s, -c, 0), ...col(0, 0, -1)];
}

/**
 * Yaw offset (degrees) that turns alpha's arbitrary frame to magnetic north,
 * from one iOS compass reading.
 *
 * Measured on an iPhone (sensor log, 2026-11-13): held upright in portrait and
 * tipped from 45 degrees forward to 20 degrees back while aimed at one
 * landmark, webkitCompassHeading stays put. So upright it is the bearing of
 * the back camera, on both sides of vertical, not of the top edge (which
 * swings round to point behind you once the phone tips back). Lying flat the
 * lens points at the ground and the heading can only be the top edge's, and
 * held sideways (landscape) it is the top edge's too, at every tilt. Tipped
 * forward in portrait the two agree.
 */
export function compassOffset(M, heading) {
  const tE = M[1], tN = M[4], bE = -M[2], bN = -M[5];     // top edge, back of phone, in alpha's earth frame
  // Not "whichever is flatter": held sideways and aimed level, both are flat,
  // and flipping between them at that point swung the heading 90 degrees for a
  // moment (landscape log, same day). The top edge wins whenever it is within
  // 45 degrees of horizontal, which is always the case sideways.
  const useTop = Math.hypot(tE, tN) >= 0.7;
  return { off: heading - Math.atan2(useTop ? tE : bE, useTop ? tN : bN) / D2R, firm: true };
}

export class Orientation {
  constructor() {
    this.R = null;            // world -> camera, magnetic north until declination is applied
    this.declination = 0;     // degrees east; true = magnetic + declination
    this.offset = null;       // iOS: filtered yaw offset between alpha's frame and north
    this.rough = false;       // offset so far rests only on readings taken near vertical
    this.absolute = false;
    this.rate = 0;            // rough angular speed, deg/s, for "is the phone steady"
    this.last = null; this.lastT = 0;
    this.onEvent = this.onEvent.bind(this);
  }

  /** Must be called from a tap: iOS only prompts inside a user gesture. */
  async start() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error('This browser has no orientation sensors.');
    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') throw new Error('Motion access was denied. Allow it in Settings > Safari > Motion & Orientation Access.');
    }
    if ('ondeviceorientationabsolute' in window) {
      this.absolute = true;
      window.addEventListener('deviceorientationabsolute', this.onEvent);
    } else window.addEventListener('deviceorientation', this.onEvent);
  }
  stop() {
    window.removeEventListener('deviceorientationabsolute', this.onEvent);
    window.removeEventListener('deviceorientation', this.onEvent);
  }

  onEvent(ev) {
    if (ev.alpha == null || ev.beta == null) return;
    let M = deviceMatrix(ev.alpha, ev.beta, ev.gamma || 0);
    if (!this.absolute && typeof ev.webkitCompassHeading === 'number' && ev.webkitCompassHeading >= 0) {
      const o = compassOffset(M, ev.webkitCompassHeading);
      this.raw = { heading: ev.webkitCompassHeading, alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma || 0, firm: o.firm };
      if (o.firm || this.offset == null || this.rough) {
        if (this.offset == null || (this.rough && o.firm)) this.offset = o.off;
        else this.offset += (((o.off - this.offset + 540) % 360) - 180) * 0.03;
        this.rough = !o.firm;
      }
    }
    // Turn the earth frame so headings read true north.
    const turn = (this.offset || 0) + this.declination;
    let R = cameraFromDevice(M, screenAngle());
    if (turn) R = matMul(R, yawMat(turn));
    const now = performance.now();
    if (this.last) {
      const dot = (R[6] * this.last[6] + R[7] * this.last[7] + R[8] * this.last[8]);
      const ang = Math.acos(Math.min(1, dot)) / D2R, dt = Math.max(1, now - this.lastT) / 1000;
      this.rate += (ang / dt - this.rate) * 0.3;
    }
    this.last = R; this.lastT = now; this.R = R;
    this.tap?.(ev, R);           // diagnostics recorder, when one is attached
  }
}

/** Watch GPS; cb({lat, lon, alt, acc}) on each fix, err(message) on failure. */
export function watchPosition(cb, err) {
  if (!navigator.geolocation) { err('This browser has no location service.'); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    p => cb({ lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude, acc: p.coords.accuracy }),
    e => err(e.code === 1 ? 'Location access was denied.' : 'No GPS fix yet.'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  return () => navigator.geolocation.clearWatch(id);
}
