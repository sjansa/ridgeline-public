// ask.js -- a question with two answers, as the phone's own alert (not one drawn in the page,
// which blends in with everything else on screen). Native shell: the Ask plugin, with the
// answers as its buttons; elsewhere the browser's confirm() (OK / Cancel).
// Shared by Ridgeline and Moonshot (app/core/ask.js there).

const native = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'Ask');

/** Resolves true for yes. title is optional; message is the question. */
export async function ask(message, yes = 'OK', no = 'Cancel', title = '') {
  if (native()) {
    try { return !!(await window.Capacitor.nativePromise('Ask', 'confirm', { title, message, yes, no })).value; }
    catch { /* fall through to the browser's */ }
  }
  return window.confirm(title ? `${title}\n\n${message}` : message);
}
