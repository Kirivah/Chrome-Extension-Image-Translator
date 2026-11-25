// @ts-check
var Client = (() => {
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** @type {(m: SwToCs) => void} */
  let onMessage = () => {};
  /** @type {() => void} */
  let onDrop = () => {};
  const rt = chrome.runtime;

  function alive() {
    try { return !!rt?.id; } catch { return false; }
  }

  function connect() {
    if (port) return port;
    if (!alive()) return null;
    try {
      port = rt.connect({ name: 'imgtr' });
    } catch {
      port = null;
      return null;
    }
    const p = port;
    p.onMessage.addListener((m) => { if (port === p) onMessage(/** @type {SwToCs} */ (m)); });
    p.onDisconnect.addListener(() => {
      void rt.lastError;
      if (port === p) { port = null; onDrop(); }
    });
    return p;
  }

  /** @param {CsToSw} m */
  function send(m) {
    const p = connect();
    if (!p) return false;
    try { p.postMessage(m); return true; } catch { port = null; return false; }
  }

  /** @param {CsToSw} m */
  function sendIfOpen(m) {
    if (!port) return false;
    try { port.postMessage(m); return true; } catch { port = null; return false; }
  }

  const isOpen = () => port !== null;

  function close() {
    const p = port;
    port = null;
    if (p) { try { p.disconnect(); } catch {} }
  }

  /** @param {(m: SwToCs) => void} message @param {() => void} drop */
  function setHandlers(message, drop) {
    onMessage = message;
    onDrop = drop;
  }

  return { connect, send, sendIfOpen, isOpen, close, alive, setHandlers };
})();
