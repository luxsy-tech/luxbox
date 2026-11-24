// Kleiner Bruecken-Preload fuer die App-Ansichten:
// 1) Frueh: Notification-Shim vor dem Seiten-Code injizieren (sonst bauen Seiten
//    sich den nativen Konstruktor, der in gesandboxten Ansichten scheitert),
// 2) danach Seiten-Benachrichtigungen per DOM-Ereignis an den Hauptprozess melden.
const { ipcRenderer, webFrame } = require('electron');

try {
  window.addEventListener('luxbox-notify', (e) => {
    try {
      const d = (e && e.detail) || {};
      ipcRenderer.send('app:notify', {
        title: String(d.title || '').slice(0, 200),
        body: String(d.body || '').slice(0, 500),
        tag: String(d.tag || '').slice(0, 100),
      });
    } catch { /* egal */ }
  });
} catch { /* egal */ }

// Fruehinjektion in die Seitenwelt, solange das Dokument noch frisch ist
try {
  const src = ipcRenderer.sendSync('notify:shim-source');
  if (!src) {
    ipcRenderer.send('app:diag', 'Shim-Quelle nicht erhaeltlich');
  } else if (webFrame && typeof webFrame.executeJavaScript === 'function') {
    webFrame.executeJavaScript(
      `${src}; try { window.__shimEarly = { ok: window.__luxboxNotify === true, state: document.readyState }; } catch (e) {}`,
    ).catch((err) => {
      ipcRenderer.send('app:diag', 'frueh fehlgeschlagen: ' + err.message);
    });
  } else {
    ipcRenderer.send('app:diag', 'webFrame nicht verfuegbar: ' + String(webFrame));
  }
} catch (err) {
  ipcRenderer.send('app:diag', 'Fruehinjektion fehlgeschlagen: ' + err.message);
}
