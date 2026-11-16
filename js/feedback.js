// feedback.js -- beta testers' notes and screenshots, handed to the phone's
// own mail app as a new message. Nothing is sent by the app itself: the tester
// sees the message and presses Send.

export const FEEDBACK_EMAIL = 'nadir.balmy5d@icloud.com';
export const MAX_SHOTS = 6;
const MAX_SIDE = 2000;        // screenshots are shrunk to this many pixels on the long side
const MAILTO_BODY = 1800;     // longest body a mailto: link carries reliably

const hasNative = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'Feedback');

/** Re-encode a picked picture as a JPEG no larger than MAX_SIDE. Returns {blob, url}. */
export async function shrink(file) {
  const img = new Image(), src = URL.createObjectURL(file);
  try {
    img.src = src;
    await img.decode();
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(done => c.toBlob(done, 'image/jpeg', 0.85));
    if (!blob) throw new Error('That picture could not be read.');
    return { blob, url: URL.createObjectURL(blob) };
  } finally { URL.revokeObjectURL(src); }
}

const base64 = blob => new Promise((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result).split(',')[1]);
  r.onerror = () => fail(r.error);
  r.readAsDataURL(blob);
});

/**
 * Open a new mail to the developer with the notes, the app's readout and the screenshots.
 * Resolves {via, sent, dropped}:
 *   via: 'mail' (a mail message was opened), 'share' (the share sheet was opened instead)
 *   sent: true or false where the phone reports it, null where it does not
 *   dropped: screenshots that could not be attached (a browser's mail link carries none)
 */
export async function sendFeedback({ notes, shots, details, version }) {
  const subject = `Ridgeline feedback (version ${version})`;
  const body = `${notes.trim()}\n\n--- app details (delete if you prefer) ---\n${details}\n`;
  if (hasNative()) {
    const images = await Promise.all(shots.map(s => base64(s.blob)));
    const r = await window.Capacitor.nativePromise('Feedback', 'send', { to: FEEDBACK_EMAIL, subject, body, images });
    return { via: r?.via || 'mail', sent: r?.sent ?? null, dropped: 0 };
  }
  const files = shots.map((s, i) => new File([s.blob], `screenshot-${i + 1}.jpg`, { type: 'image/jpeg' }));
  if (files.length && navigator.canShare?.({ files })) {
    // a browser cannot attach files to a mail link; the share sheet can pass them to a mail app
    try {
      await navigator.share({ title: subject, text: `Send to: ${FEEDBACK_EMAIL}\n\n${body}`, files });
      return { via: 'share', sent: null, dropped: 0 };
    } catch (e) {
      if (e.name === 'AbortError') return { via: 'share', sent: false, dropped: 0 };
    }
  }
  const short = body.length > MAILTO_BODY ? `${body.slice(0, MAILTO_BODY)}…` : body;
  location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
  return { via: 'mail', sent: null, dropped: files.length };
}
