// Haelt Extension-Popups (Bitwarden & Co.) innerhalb der Bildschirm-Arbeitsflaeche.
//
// WARUM: electron-chrome-extensions positioniert sein Popup in updatePosition()
// absolut ueber winBounds + anchorRect - OHNE Begrenzung auf den Bildschirm.
// Mit alignment="top right" (index.html) startet das Popup links am Anker-Icon
// und laeuft nach rechts; sitzt das Icon wie in der unteren App-Leiste weit
// rechts, verschwindet die Haelfte des Popups ausserhalb des Bildschirms.
//
// WIE: ECE wirft VOR dem setBounds das Event "will-move" und uebergibt das
// Positionsobjekt per Referenz (EventEmitter). Wer den Listener direkt am
// Popup haengt und x/y dort anpasst, aendert die tatsaechlich gesetzte
// Position - ohne den node_modules-Code zu patchen (der waere beim naechsten
// "npm ci" weg).
//
// Der Listener haengt an jedem Popup-Objekt, das das Event
// "browser-action-popup-created" der ElectronChromeExtensions-Instanz liefert.
const electron = require('electron');

// workArea statt bounds: Taskleiste/Dock bleiben frei.
function clamp(value, min, max) {
  // popup breiter als die Arbeitsflaeche -> links verankern statt negativ
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function clampPopupToScreen(popup) {
  if (!popup || typeof popup.on !== 'function') return popup;

  popup.on('will-move', (position) => {
    try {
      if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return;
      const bw = popup.browserWindow;
      const parent = popup.parent;
      if (!bw || bw.isDestroyed() || !parent || parent.isDestroyed()) return;

      const size = bw.getBounds();   // setSize liefert VOR will-move, hier ist die Endgroesse drin
      // Display des Elternfensters: das Popup gehoert zu seinem Anker, auch bei mehreren Monitoren
      const pb = parent.getBounds();
      const wa = electron.screen.getDisplayNearestPoint({
        x: Math.round(pb.x + pb.width / 2),
        y: Math.round(pb.y + pb.height / 2),
      }).workArea;

      const x = clamp(position.x, wa.x, wa.x + wa.width - size.width);
      const y = clamp(position.y, wa.y, wa.y + wa.height - size.height);
      if (x !== position.x || y !== position.y) {
        position.x = x;
        position.y = y;
      }
    } catch (err) {
      // Clamping ist Kosmetik - nie den Popup-Aufbau daran scheitern lassen
      console.warn('[popup-clamp]', (err && err.message) || err);
    }
  });

  return popup;
}

module.exports = { clampPopupToScreen, clamp };
