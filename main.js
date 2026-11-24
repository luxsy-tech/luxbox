const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, session, dialog, net, nativeImage, powerMonitor,
  clipboard, globalShortcut, powerSaveBlocker, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const sync = require('./sync');
const { parseStoreInput, installFromStore, removeInstalled, readManifest } = require('./webstore');
const i18n = require('./i18n.js');
const t = (key, vars) => i18n.t(key, vars);

// --- Fremd-Meldungen in der Konsole reduzieren ---
// 1) Chromium-eigene Logs (Extension-Errors der Store-Erweiterungen, CSP-Hinweise von
//    Webseiten, Mojo-Warnungen) stammen nicht aus unserem Code und verstauben nur die
//    Konsole. "log-level 3" zeigt nur noch Fatales; eigene console.log/warn bleiben sichtbar.
app.commandLine.appendSwitch('log-level', '3');
// 2) Electron meldet beim Laden von Store-Erweiterungen Node-Warnungen über Rechte,
//    die electron-chrome-extensions nicht kennt (sidePanel, contextMenus, ...).
//    Diese Warnung ausblenden, andere Warnungen weiterzeigen.
{
  const printWarning = process.listeners('warning')[0] || ((w) => console.warn(w.name + ': ' + w.message));
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name === 'ExtensionLoadWarning') return;
    printWarning(w);
  });
}

// Platzhalter fuer 'crx-msg-remote': Das browser-action-Element meldet sich schon beim
// Laden des Fensters, electron-chrome-extensions registriert seinen Handler aber erst mit
// der ersten Erweiterungs-Instanz. Ohne Platzhalter protokolliert Electron ansonsten
// "No handler registered for 'crx-msg-remote'".
const crxStub = () => ({ actions: [] });
let crxStubActive = true;
ipcMain.handle('crx-msg-remote', crxStub);

// Weniger Renderer-Prozesse: Seiten derselben Website teilen sich einen Prozess
app.commandLine.appendSwitch('process-per-site');

// Die Erweiterungs-Bibliothek wird erst geladen, wenn wirklich eine Erweiterung installiert ist
let ECE = null;
let crxHandled = false;
const getECE = () => {
  if (!ECE) ECE = require('electron-chrome-extensions').ElectronChromeExtensions;
  return ECE;
};

// Das Icon ist optional: Fehlt die Datei, startet die App trotzdem ohne Icon
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const appIcon = (() => {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
})();
if (!appIcon) console.warn(`Icon nicht gefunden: ${ICON_PATH}`);
const SIDEBAR_SIZE = 72;   // Breite (Leiste links/rechts) bzw. Hoehe (Leiste oben/unten)
const MENU_BAR_HEIGHT = 34; // Hoehe der eigenen Menueleiste, muss zu .menubar in styles.css passen
const CLIENT_HINT_HOSTS = /(^|\.)whatsapp\.(com|net)$/i;   // nur hier werden Client Hints überschrieben
const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read',
]);

// Pro App einstellbare Berechtigungen (Standard: erlaubt wie bisher)
const PERM_KEYS = ['notifications', 'media', 'microphone', 'clipboard-sanitized-write', 'fullscreen'];

function permFor(entry, permission) {
  const custom = entry && entry.perms ? entry.perms[permission] : null;
  if (custom === 'allow' || custom === 'deny' || custom === 'ask') return custom;
  return ALLOWED_PERMISSIONS.has(permission) ? 'allow' : 'deny';
}

function sanitizePerms(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const key of PERM_KEYS) {
      const v = raw[key];
      if (v === 'allow' || v === 'deny' || v === 'ask') out[key] = v;
    }
  }
  return out;
}

let win = null;
let splash = null;      // Boot-Animation: Splash-Fenster ueber dem Hauptfenster
let splashStart = 0;    // Startzeitpunkt fuer die Mindestanzeigedauer
const BOOT_MIN_MS = 2200; // Mindestanzeigedauer der Boot-Animation
let activeId = null;
let attachedView = null;
let overlayOpen = false;
let allowQuit = false;  // true nur bei echtem Beenden (Menue "Beenden", Neustart, System-Shutdown)
let splitId = null;     // zweite App in der Split-View neben der aktiven
let locked = false;     // App-Sperre: solange gesperrt, bleibt die App-Ansicht abgehaengt
const lockedApps = new Set();   // geschuetzte Apps, die ihre eigene Freigabe brauchen
let awakeBlockerId = null;   // powerSaveBlocker waehrend Audio/Anrufen

let apps = [];                    // gespeicherte Apps: { id, name, url, ignoreCerts, muted, favicon }
let extensions = [];              // geladene Chrome-Erweiterungen: { path, name, version }
const loadedExt = new Map();      // partition -> Map(path -> extensionId)
const extSystems = new Map();     // partition -> ElectronChromeExtensions (eine Instanz je Sitzung)
let storeWin = null;
const views = new Map();          // appId -> WebContentsView (lazy erzeugt)
const runtime = new Map();        // appId -> { badge, favicon, loading }
const wcToApp = new Map();        // webContents.id -> appId
const lastActive = new Map();     // appId -> Zeitpunkt, an dem die App zuletzt verlassen wurde
const tabbed = new WeakSet();     // webContents, die bei der Erweiterungs-Bibliothek angemeldet sind
let settings = { hibernateMinutes: 15, updatedAt: 0 };

// Sync-Daten (nur lokal gespeichert, nie im Sync-Ordner)
let syncCfg = { folder: null, deviceId: null };
let orderAt = 0;
let deletedApps = {};     // appId -> Zeitpunkt des Löschens
let deletedExt = {};      // Erweiterungs-ID -> Zeitpunkt des Löschens
let skippedExt = [];      // vom Nutzer abgelehnte Erweiterungen aus dem Sync

/* ---------- Persistenz ---------- */

const storeFile = () => path.join(app.getPath('userData'), 'apps.json');

let storeWritable = true;   // false: apps.json nicht lesbar, dann wird nichts ueberschrieben

function loadApps() {
  const file = storeFile();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // BOM-tolerant: manche Tools speichern UTF-8 mit BOM, das wuerde JSON.parse
      // sonst schlucken lassen und die Daten waeren scheinbar "weg".
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    apps = Array.isArray(parsed.apps) ? parsed.apps : [];
    extensions = Array.isArray(parsed.extensions) ? parsed.extensions : [];
    if (parsed.settings && Number.isFinite(parsed.settings.hibernateMinutes)) {
      settings.hibernateMinutes = parsed.settings.hibernateMinutes;
      settings.updatedAt = Number.isFinite(parsed.settings.updatedAt) ? parsed.settings.updatedAt : 0;
    }
    if (parsed.sync && typeof parsed.sync === 'object') {
      syncCfg = { folder: parsed.sync.folder || null, deviceId: parsed.sync.deviceId || null };
    }
    orderAt = Number.isFinite(parsed.orderAt) ? parsed.orderAt : 0;
    deletedApps = parsed.deletedApps && typeof parsed.deletedApps === 'object' ? parsed.deletedApps : {};
    deletedExt = parsed.deletedExt && typeof parsed.deletedExt === 'object' ? parsed.deletedExt : {};
    skippedExt = Array.isArray(parsed.skippedExt) ? parsed.skippedExt : [];
    // Store-Erweiterungen liegen im aktuellen Datenordner, auch wenn der Pfad noch auf den alten zeigt
    for (const e of extensions) {
      if (!e.id || !e.store) continue;
      const expected = path.join(app.getPath('userData'), 'store-extensions', `${e.store}-${e.id}`);
      if (e.path !== expected && fs.existsSync(expected)) e.path = expected;
    }
      // Altbestand: Favicons aus apps.json in den eigenen Cache uebernehmen
      let migratedFavicons = false;
      for (const a of apps) {
        if (a.favicon) { writeFaviconCache(a.id, a.favicon); migratedFavicons = true; }
        else a.favicon = readFaviconCache(a.id);
      }
      storeWritable = true;
      if (migratedFavicons) saveApps();   // apps.json dann auch ohne die Favicons
      return;
    } catch (err) {
      if (attempt < 3 && fs.existsSync(file)) {
        // Eventuell nur voruebergehend gesperrt: kurz warten und erneut versuchen
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        continue;
      }
      apps = [];
      extensions = [];
      if (!fs.existsSync(file)) {
        storeWritable = true;   // neue Installation: leeres Profil ist in Ordnung
        return;
      }
      // Die Datei darf auf keinen Fall stillschweigend mit leerem Stand ueberschrieben
      // werden: eine kaputte Datei wird gesichert, eine gesperrte blockiert das Schreiben.
      try {
        const broken = file + '.broken-' + Date.now();
        fs.renameSync(file, broken);
        storeWritable = true;
        console.warn('apps.json war nicht lesbar (' + err.message + ') und wurde gesichert als ' + path.basename(broken) + '.');
      } catch {
        storeWritable = false;
        console.warn('apps.json ist derzeit nicht lesbar (' + err.message + '). Es wird nichts ueberschrieben - bitte Luxbox neu starten.');
      }
    }
  }
}

// apps.json wird entprellt und asynchron geschrieben: schnelle Aenderungen
// (Symbole, Status, Mute) sollen den Hauptprozess nicht blockieren. Beim Beenden
// wird der ausstehende Stand noch synchron geschrieben, damit nichts verlorengeht.
let saveTimer = null;
let savePending = false;

// Favicons stehen nicht in apps.json, sondern in eigenen Dateien (siehe "Favicons"):
// sonst wuerde jede Symbol-Aenderung die komplette Konfiguration neu schreiben.
function storeData() {
  return JSON.stringify({
    apps: apps.map((a) => { const { favicon, ...rest } = a; return rest; }),
    extensions, settings, sync: syncCfg, orderAt, deletedApps, deletedExt, skippedExt,
  }, null, 2);
}

function writeStoreSync() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), storeData());
  savePending = false;
  clearTimeout(saveTimer);
  saveTimer = null;
  buildJumpList();   // Apps geaendert: Sprungmarken mitziehen
}

function flushSave() {
  if (!savePending || !storeWritable) return;
  try { writeStoreSync(); } catch (err) { console.error('Speichern fehlgeschlagen:', err); }
}

function saveApps() {
  if (!storeWritable) {
    console.warn('Speichern uebersprungen: apps.json konnte beim Start nicht gelesen werden.');
    scheduleSync();
    return;
  }
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.promises.writeFile(storeFile(), storeData()).catch((err) => console.error('Speichern fehlgeschlagen:', err));
  }, 400);
  scheduleSync();
}

app.on('before-quit', flushSave);
// Beenden (Menue, Neustart, System-Shutdown) darf das Fenster wirklich schliessen
app.on('before-quit', () => { allowQuit = true; });

// Übernimmt Apps und Logins der früheren Version „ops-browser“
function migrateOldData() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'ops-browser');
    const newDir = app.getPath('userData');
    if (fs.existsSync(path.join(newDir, 'apps.json')) || !fs.existsSync(path.join(oldDir, 'apps.json'))) return;
    const skip = /^(Singleton.*|Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache|Crashpad|blob_storage)$/;
    fs.cpSync(oldDir, newDir, { recursive: true, filter: (src) => !skip.test(path.basename(src)) });
  } catch (err) {
    console.warn('Übernahme der alten Daten fehlgeschlagen:', err.message);
  }
}

/* ---------- Helfer ---------- */

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const findApp = (id) => apps.find((a) => a.id === id);

// Apps ohne eigene Sitzung teilen sich Cookies, Logins und Erweiterungsdaten.
// Ältere Einträge (ohne Feld) behalten ihre eigene Sitzung.
const SHARED_PARTITION = 'persist:shared';
const partitionOf = (entry) => (entry.ownSession === false ? SHARED_PARTITION : `persist:app-${entry.id}`);

function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0];
  const os = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  }[process.platform] || 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function normalizeUrl(input) {
  let value = String(input || '').trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sanitize(data) {
  const url = normalizeUrl(data.url);
  const name = String(data.name || '').trim() || (url ? new URL(url).hostname : '');
  if (!url) throw new Error(t('err.invalidUrl'));
  const out = {
    name: name.slice(0, 60),
    url,
    group: String(data.group || '').trim().slice(0, 24),
    ignoreCerts: data.ignoreCerts === true,
    ownSession: data.ownSession === true,
    keepAlive: data.keepAlive === true,
  };
  // Nur mitgeben, wenn vorhanden: sonst wuerden Zoom/Berechtigungen zurueckgesetzt
  if (data.perms !== undefined) out.perms = sanitizePerms(data.perms);
  if (data.zoom !== undefined && Number.isFinite(Number(data.zoom))) out.zoom = Number(data.zoom);
  if (data.protect !== undefined) out.protect = data.protect === true;
  if (data.lockAfter !== undefined) {
    const v = Number(data.lockAfter);
    out.lockAfter = [-1, 1, 5, 15, 30, 60].includes(v) ? v : 0;
  }
  return out;
}

function publicState() {
  return {
    activeId,
    splitId,
    activeTabId: views.get(activeId)?.webContents.id ?? null,
    extensionCount: extensions.length,
    apps: apps.map((a) => ({ ...a, partition: partitionOf(a), locked: lockedApps.has(a.id), ...(runtime.get(a.id) || {}) })),
  };
}

// Das Favicon (data:-URL) wird nur gesendet, wenn es sich geändert hat
function pushState(id, withIcon = false) {
  const payload = { id, ...(runtime.get(id) || {}) };
  if (withIcon) payload.favicon = findApp(id)?.favicon || null;
  send('app:state', payload);
}

function setRuntime(id, patch) {
  const prev = runtime.get(id) || {};
  if (Object.keys(patch).every((key) => prev[key] === patch[key])) return;   // nichts geändert
  runtime.set(id, { ...prev, ...patch });
  pushState(id);
}

function badgeFromTitle(title) {
  const m = /^[(\[](\d+)[)\]]/.exec(title || '');
  return m ? Number(m[1]) : 0;
}

// Setzt zusätzlich zum User-Agent die Client Hints (navigator.userAgentData, Sec-CH-UA),
// damit Seiten wie WhatsApp Web keinen Hinweis auf Electron finden.
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(t('err.timeout', { ms }))), ms)),
]);

async function applyUserAgentMetadata(wc, userAgent) {
  const full = process.versions.chrome;
  const major = full.split('.')[0];
  const brands = (version) => [
    { brand: 'Not)A;Brand', version: version === major ? '99' : '99.0.0.0' },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  ];
  const metadata = {
    brands: brands(major),
    fullVersionList: brands(full),
    platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux',
    platformVersion: { win32: '10.0.0', darwin: '14.0.0' }[process.platform] || '6.0.0',
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    mobile: false,
  };

  // Ohne geladene Seite beantwortet der Renderer keine CDP-Kommandos – dann hängt
  // Network.setUserAgentOverride und läuft in den Timeout. Darum zuerst ein leeres
  // Dokument laden, damit der Override sicher vor der eigentlichen Seite greift.
  if (!wc.isDestroyed() && !wc.getURL()) {
    try { await withTimeout(wc.loadURL('about:blank'), 1500); } catch {}
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (wc.isDestroyed()) return false;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await withTimeout(wc.debugger.sendCommand('Network.setUserAgentOverride', {
        userAgent,
        userAgentMetadata: metadata,
      }), 1500);
      // Der Debugger bleibt angehaengt: CDP-Overrides gelten nur fuer die offene
      // Sitzung, nach wc.debugger.detach() faellt die Seite sofort auf die
      // Electron-UA zurueck (per Testfenster geprueft).
      return true;
    } catch (err) {
      if (wc.isDestroyed()) return false;
      if (attempt === 3) {
        console.warn(`Client Hints konnten nicht gesetzt werden: ${err.message}`);
        try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* egal */ }
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return false;
}

/* ---------- Favicons ---------- */

// Favicons liegen als eigene Dateien im Profil und nicht in apps.json: sonst
// wuerde jede Symbol-Aenderung die komplette Konfigurationsdatei neu schreiben.
const favDir = () => path.join(app.getPath('userData'), 'favicons');
const favFile = (id) => path.join(favDir(), `${id}.txt`);

function writeFaviconCache(id, data) {
  try {
    fs.mkdirSync(favDir(), { recursive: true });
    fs.writeFileSync(favFile(id), data);
  } catch (err) {
    console.warn(`Favicon konnte nicht gespeichert werden: ${err.message}`);
  }
}

function readFaviconCache(id) {
  try {
    return fs.readFileSync(favFile(id), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function dropFaviconCache(id) {
  try { fs.rmSync(favFile(id), { force: true }); } catch { /* egal */ }
}

async function fetchIcon(url, ses) {
  try {
    const res = await (ses ? ses.fetch(url) : net.fetch(url));
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 300 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Lädt das erste erreichbare Icon und speichert es dauerhaft als data:-URL.
async function updateFavicon(id, candidates, { ses = null, onlyIfEmpty = false } = {}) {
  const entry = findApp(id);
  if (!entry || !candidates.length) return;
  if (entry.customIcon) return;   // eigenes Icon bleibt, bis es entfernt wird
  if (!onlyIfEmpty && entry.faviconSrc === candidates[0] && entry.favicon) return;
  for (const url of candidates) {
    const data = await fetchIcon(url, ses);
    const current = findApp(id);
    if (!current) return;
    if (data && (!onlyIfEmpty || !current.favicon)) {
      current.favicon = data;
      current.faviconSrc = candidates[0];
      writeFaviconCache(id, data);
      saveApps();
      pushState(id, true);
      return;
    }
  }
}

const fallbackIcon = (id) => {
  const entry = findApp(id);
  if (entry) updateFavicon(id, [`${new URL(entry.url).origin}/favicon.ico`], { onlyIfEmpty: true });
};

/* ---------- Seiten-Benachrichtigungen: Klick springt zur App ---------- */
// Electron bietet kein Klick-Event fuer Benachrichtigungen von Webseiten.
// Darum wird in der Seitenkontext die Notification-API ueberschrieben und
// meldet Titel/Text an uns; wir zeigen eigene Meldungen an, deren Klick die
// passende App oeffnet (notify-preload.js leitet die Meldung weiter).
const NOTIFIESHIM = `(() => {
  if (window.__luxboxNotify) return;
  window.__luxboxNotify = true;
  const send = (title, options) => {
    try {
      window.dispatchEvent(new CustomEvent('luxbox-notify', { detail: {
        title: String(title || ''),
        body: String((options && options.body) || ''),
        tag: String((options && options.tag) || ''),
      } }));
    } catch {}
  };
  const Native = window.Notification;
  // Vollstaendiger Ersatz als EventTarget mit allen Standard-Mitgliedern, damit
  // Seiten-Codes (addEventListener/show/close/tag) weiterlaufen und nicht an
  // unserem Ersatz abstuerzen - das killte Meldungs-Handler und dadurch die Badges
  window.Notification = class extends EventTarget {
    constructor(title, options) {
      super();
      const opts = options || {};
      this.title = String(title || '');
      this.body = String(opts.body || '');
      this.tag = String(opts.tag || '');
      this.data = opts.data;
      this.onclick = null;
      this.onshow = null;
      this.onclose = null;
      this.onerror = null;
      send(this.title, { body: this.body, tag: this.tag });
    }
    static get permission() { return Native ? Native.permission : 'granted'; }
    static requestPermission(cb) {
      let p;
      try { p = Native && Native.requestPermission ? Native.requestPermission() : Promise.resolve('granted'); }
      catch { p = Promise.resolve('granted'); }
      Promise.resolve(p).then((v) => { if (cb) cb(v); }).catch(() => { if (cb) cb('granted'); });
      return Promise.resolve(p);
    }
    show() {
      setTimeout(() => { try { if (this.onshow) this.onshow(); this.dispatchEvent(new Event('show')); } catch {} }, 0);
    }
    close() {
      setTimeout(() => { try { if (this.onclose) this.onclose(); this.dispatchEvent(new Event('close')); } catch {} }, 0);
    }
  };
  try {
    if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
      ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
        send(title, options);
        return Promise.resolve();
      };
    }
  } catch {}
})();`;

ipcMain.on('notify:shim-source', (event) => {
  event.returnValue = NOTIFIESHIM;
});

ipcMain.on('app:diag', (_event, message) => {
  console.warn('[preload-diag]', message);
});

ipcMain.on('app:notify', (event, data) => {
  // Nie in den Hauptprozess crashen lassen: eine kaputte Meldung darf die
  // App nicht stoeren
  try {
    const id = wcToApp.get(event.sender.id);
    const entry = id && findApp(id);
    if (!entry || !data || !data.title) return;
    if (permFor(entry, 'notifications') === 'deny') return;
    let icon = appIcon;
    try {
      if (entry.favicon) icon = nativeImage.createFromDataURL(entry.favicon);
      if (!icon || icon.isEmpty()) icon = appIcon;
    } catch { icon = appIcon; }
    const n = new Notification({ title: data.title, body: data.body || '', icon });
    n.on('click', () => {
      activate(id);
      if (win && !win.isDestroyed()) { win.show(); win.restore(); win.focus(); }
    });
    n.show();
  } catch (err) {
    console.warn('Benachrichtigung konnte nicht angezeigt werden:', err.message);
  }
});

/* ---------- Chrome-Erweiterungen ---------- */

const extLoader = (ses) => ses.extensions ?? ses;   // Electron >= 35: session.extensions

const extQueue = new Map();   // partition -> Promise, verhindert doppeltes Laden bei geteilten Sitzungen

function loadExtensionsInto(ses, partition) {
  const next = (extQueue.get(partition) || Promise.resolve()).then(() => loadExtensionsNow(ses, partition));
  extQueue.set(partition, next.catch(() => {}));
  return next;
}

const extErrors = new Map();   // Pfad -> letzte Fehlermeldung beim Laden

const activePartition = () => (activeId && findApp(activeId) ? partitionOf(findApp(activeId)) : null);

// Liste für die Oberfläche: mit Status in der Sitzung der aktiven App
function extView() {
  const loaded = loadedExt.get(activePartition());
  return extensions.map((e) => ({
    ...e,
    loaded: Boolean(loaded && loaded.has(e.path)),
    error: extErrors.get(e.path) || null,
  }));
}

async function loadExtensionsNow(ses, partition) {
  const loaded = loadedExt.get(partition) || new Map();
  loadedExt.set(partition, loaded);
  for (const ext of extensions) {
    if (loaded.has(ext.path)) continue;
    try {
      if (!fs.existsSync(ext.path)) throw new Error(t('err.extFolderMissing'));
      const loadedExtension = await extLoader(ses).loadExtension(ext.path, { allowFileAccess: true });
      loaded.set(ext.path, loadedExtension.id);
      extErrors.delete(ext.path);
    } catch (err) {
      extErrors.set(ext.path, err.message);
      console.warn(`Erweiterung "${ext.name}" konnte nicht geladen werden: ${err.message}`);
    }
  }
  // Die Symbolleiste der Oberfläche muss neu abfragen, wenn eine Erweiterung erst jetzt fertig geladen ist
  send('ext:loaded', { partition });
  send('ext:changed', extView());
}

function registerTab(wc, ses, partition) {
  if (tabbed.has(wc)) return;
  tabbed.add(wc);
  try {
    getExtSystem(ses, partition).addTab(wc, win);
  } catch (err) {
    // Fehlt electron-chrome-extensions, laden die Seiten trotzdem (ohne Popups der Erweiterungen)
    console.warn(`Erweiterungs-System nicht verfügbar (npm install ausführen): ${err.message}`);
  }
}

function getExtSystem(ses, partition) {
  if (extSystems.has(partition)) return extSystems.get(partition);

  if (!crxHandled) {
    getECE().handleCRXProtocol(session.defaultSession);   // Symbole (crx://) in der Oberfläche anzeigen
    crxHandled = true;
  }

  const openWindow = (details = {}) => {
    const w = new BrowserWindow({
      parent: win,
      width: details.width || 1000,
      height: details.height || 720,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true },
    });
    if (details.url) w.loadURL(details.url).catch(() => {});
    return w;
  };

  const EceClass = getECE();
  if (crxStubActive) {
    // Platzhalter entfernen, damit electron-chrome-extensions seinen Handler registrieren kann
    crxStubActive = false;
    ipcMain.removeHandler('crx-msg-remote');
  }
  const system = new EceClass({
    license: 'GPL-3.0',
    session: ses,
    createTab: async (details) => {
      const w = openWindow(details);
      system.addTab(w.webContents, w);
      return [w.webContents, w];
    },
    selectTab: (wc) => {
      const id = wcToApp.get(wc.id);
      if (id) activate(id);
    },
    removeTab: (_wc, w) => { if (w && w !== win && !w.isDestroyed()) w.close(); },
    createWindow: async (details) => openWindow(details),
    removeWindow: (w) => { if (w !== win && !w.isDestroyed()) w.close(); },
  });
  extSystems.set(partition, system);
  return system;
}

/* ---------- Zusatzfenster (window.open / Ziel _blank) ---------- */

const auxWindows = new Set();

function openAuxWindow(url, ses) {
  for (const w of auxWindows) {
    if (!w.isDestroyed() && w.webContents.getURL() === url) {
      w.focus();
      return;
    }
  }
  const w = new BrowserWindow({
    width: 1100,
    height: 800,
    icon: appIcon,
    backgroundColor: THEME_BG[theme],
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.setMenuBarVisibility(false);
  w.webContents.setUserAgent(chromeUserAgent());
  w.webContents.setWindowOpenHandler(({ url: next }) => {
    if (/^https?:\/\//i.test(next)) openAuxWindow(next, w.webContents.session);
    else if (/^mailto:/i.test(next)) shell.openExternal(next);
    return { action: 'deny' };
  });
  w.loadURL(url).catch(() => {});
  w.on('closed', () => auxWindows.delete(w));
  auxWindows.add(w);
}

/* ---------- Windows Hello (Freigabe ueber Fingerabdruck/Gesicht/PIN) ---------- */

function runPowerShell(script) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', () => finish(out.trim() || (err.trim() ? `error: ${err.trim().split('\n')[0]}` : 'error')));
      p.on('error', () => finish('error'));
      setTimeout(() => { try { p.kill(); } catch { /* egal */ } finish('timeout'); }, 20000);
    } catch {
      finish('error');
    }
  });
}

// WinRT-Asynchrony in PowerShell: AsTask braucht die explizite generische
// Variante, sonst findet PowerShell keine passende Ueberladung
const helloScript = (call, resultType) => `
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null;
$m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0];
$t = $m.MakeGenericMethod([Windows.Security.Credentials.UI.${resultType}]).Invoke($null, @(${call}));
$t.Wait() | Out-Null;
$t.Result.ToString()`;

// Liefert 'Available' oder den Grund, warum es nicht geht (z. B. 'DeviceNotPresent')
const helloStatus = () => runPowerShell(helloScript(
  '[Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()',
  'UserConsentVerifierAvailability',
));

const helloVerify = () => runPowerShell(helloScript(
  '[Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(\'Luxbox\')',
  'UserConsentVerificationResult',
)).then((r) => r === 'Verified');

/* ---------- Views ---------- */

function contentRect(w, h) {
  const m = MENU_BAR_HEIGHT;
  const rects = {
    left: { x: SIDEBAR_SIZE, y: m, width: Math.max(0, w - SIDEBAR_SIZE), height: Math.max(0, h - m) },
    right: { x: 0, y: m, width: Math.max(0, w - SIDEBAR_SIZE), height: Math.max(0, h - m) },
    top: { x: 0, y: m + SIDEBAR_SIZE, width: w, height: Math.max(0, h - m - SIDEBAR_SIZE) },
    bottom: { x: 0, y: m, width: w, height: Math.max(0, h - m - SIDEBAR_SIZE) },
  };
  return rects[rail] || rects.left;
}

function layout() {
  if (!win || !attachedView) return;
  const [w, h] = win.getContentSize();
  const rect = contentRect(w, h);
  const splitView = splitId ? views.get(splitId) : null;
  if (splitView && splitView !== attachedView) {
    // Split-View: aktive App haelt links Platz, die zweite App sitzt rechts daneben
    const half = Math.floor(rect.width / 2);
    attachedView.setBounds({ ...rect, width: half });
    splitView.setBounds({ x: rect.x + half, y: rect.y, width: rect.width - half, height: rect.height });
  } else {
    attachedView.setBounds(rect);
  }
}

function detach() {
  if (win && !win.isDestroyed()) {
    const both = [attachedView, splitId ? views.get(splitId) : null];
    for (const v of both) {
      if (!v) continue;
      try { win.contentView.removeChildView(v); } catch { /* bereits entfernt */ }
    }
  }
  attachedView = null;
}

function attach(id) {
  if (!win || overlayOpen || locked || !id || isLockedApp(id)) return;
  const view = ensureView(id);
  if (!view) return;
  win.contentView.addChildView(view);
  attachedView = view;
  const splitView = splitId ? views.get(splitId) : null;
  if (splitView && splitView !== view) win.contentView.addChildView(splitView);
  layout();
  view.webContents.focus();
}

// Split-View: zweite App neben der aktiven anzeigen (halb/halb)
function setSplit(id) {
  if (!findApp(id) || id === activeId || isLockedApp(id)) return;
  splitId = id;
  ensureView(id);
  if (attachedView) { detach(); attach(activeId); }
  layout();
  send('apps:changed', publicState());
}

function clearSplit() {
  if (!splitId) return;
  const view = views.get(splitId);
  if (view && win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(view); } catch { /* egal */ }
  }
  splitId = null;
  layout();
  send('apps:changed', publicState());
}

function ensureView(id) {
  if (views.has(id)) return views.get(id);
  const data = findApp(id);
  if (!data) return null;

  const partition = partitionOf(data);
  const view = new WebContentsView({
    webPreferences: {
      partition,                      // eigene oder geteilte Cookies/Logins
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,              // spart Speicher (Wörterbuch pro Ansicht)
      backgroundThrottling: true,
      preload: path.join(__dirname, 'notify-preload.js'),   // leitet Seiten-Benachrichtigungen weiter
    },
  });
  const wc = view.webContents;
  views.set(id, view);
  wcToApp.set(wc.id, id);
  runtime.set(id, { badge: 0, loading: true, hibernated: false });
  pushState(id);

  // Wie ein normaler, aktueller Chrome auftreten (WhatsApp, Teams usw. sperren sonst)
  const userAgent = chromeUserAgent();
  wc.setUserAgent(userAgent);
  wc.setAudioMuted(data.muted === true);

  const ses = wc.session;
  ses.setUserAgent(userAgent);
  ses.setPermissionRequestHandler((reqWc, permission, callback) => {
    const entry = findApp(wcToApp.get(reqWc.id));
    const decision = permFor(entry, permission);
    if (decision !== 'ask') return callback(decision === 'allow');
    // Nachfragen wie im Browser, mit Merk-Option
    dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('perm.allowOnce'), t('perm.allowAlways'), t('perm.denyOnce'), t('perm.denyAlways')],
      defaultId: 1,
      cancelId: 2,
      message: t('perm.askMessage', { name: entry ? entry.name : '?', permission }),
    }).then(({ response }) => {
      const result = ['allow', 'allow', 'deny', 'deny'][response];
      if ((response === 1 || response === 3) && entry) {
        entry.perms = { ...(entry.perms || {}), [permission]: result };
        entry.updatedAt = Date.now();
        saveApps();
      }
      callback(result === 'allow');
    });
  });

  // Zoom pro App: eigener Zoom je Ansicht, wird beim Neuladen wiederhergestellt
  try {
    wc.setZoomMode('isolated');
    if (Number(data.zoom)) wc.setZoomLevel(Number(data.zoom));
  } catch { /* aeltere Versionen koennen das nicht */ }
  wc.on('zoom-changed', () => {
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const entry = findApp(id);
      if (!entry) return;
      entry.zoom = wc.getZoomLevel();
      entry.updatedAt = Date.now();
      saveApps();
    }, 400);
  });

  // Links, die neue Fenster oeffnen wollen (window.open, Ziel _blank), kommen
  // als eigenes Fenster in Luxbox - mit der gleichen Sitzung und den Logins
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openAuxWindow(url, wc.session);
    else if (/^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Benachrichtigungs-API der Seite umbiegen, damit der Klick zur App fuehrt
  wc.on('did-finish-load', () => {
    wc.executeJavaScript(NOTIFIESHIM).catch(() => {});
  });

  wc.on('page-title-updated', (_e, title) => setRuntime(id, { badge: badgeFromTitle(title) }));
  wc.on('page-favicon-updated', (_e, icons) => updateFavicon(id, icons, { ses }));
  wc.on('did-start-loading', () => setRuntime(id, { loading: true }));
  wc.on('did-stop-loading', () => setRuntime(id, { loading: false }));
  wc.on('destroyed', () => wcToApp.delete(wc.id));

  // Crash-Recovery: Abgestuerzte Ansichten laden sich nach kurzer Pause neu,
  // statt weiss stehen zu bleiben
  wc.on('render-process-gone', (_e, details) => {
    if (details && (details.reason === 'clean-exit' || details.reason === 'killed')) return;
    setTimeout(() => {
      if (!wc.isDestroyed() && views.has(id)) {
        console.warn(`${data.name}: Renderer abgestuerzt (${details && details.reason}), lade neu`);
        wc.reload();
      }
    }, 600);
  });

  // Waehrend Audio/Anrufen laeuft der Bildschirm nicht in den Ruhezustand
  wc.on('media-started-playing', updateAwakeBlocker);
  wc.on('media-paused', updateAwakeBlocker);

  // Rechtsklick in einer App: Kontextmenue im Fenster zeigen (Standardfunktionen)
  wc.on('context-menu', (_e, params) => {
    if (!win || win.isDestroyed()) return;
    const b = view.getBounds();
    send('ui:context-menu', {
      x: b.x + (params.x || 0),
      y: b.y + (params.y || 0),
      flags: params.editFlags || {},
      where: 'view',
    });
  });

  const needsHints = CLIENT_HINT_HOSTS.test(new URL(data.url).hostname);
  let prepare = Promise.resolve();
  if (extensions.length) {
    registerTab(wc, ses, partition);
    // Erst Erweiterungen laden, damit ihre Content-Scripts schon beim ersten Laden greifen
    prepare = withTimeout(loadExtensionsInto(ses, partition), 8000);
  }
  prepare
    .catch(() => {})
    .then(() => (needsHints && !wc.isDestroyed() ? applyUserAgentMetadata(wc, userAgent) : null))
    .catch(() => {})
    .then(() => {
      if (wc.isDestroyed()) return;
      wc.loadURL(data.url).catch((err) => {
        if (err.code !== 'ERR_ABORTED') console.warn(`${data.name}: ${err.message}`);
      });
    });
  return view;
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  const wasSplit = splitId === id;
  if (view === attachedView || wasSplit) detach();
  if (wasSplit) splitId = null;
  views.delete(id);
  runtime.delete(id);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

// Gibt den Speicher einer inaktiven App frei. Sie lädt beim nächsten Öffnen neu.
function hibernate(id) {
  if (!findApp(id) || id === activeId || id === splitId || !views.has(id)) return;
  const badge = (runtime.get(id) || {}).badge || 0;
  destroyView(id);
  runtime.set(id, { badge, loading: false, hibernated: true });
  pushState(id);
}

function sweepHibernation() {
  const limit = settings.hibernateMinutes * 60 * 1000;
  if (!limit) return;
  const now = Date.now();
  for (const [id, view] of views) {
    const entry = findApp(id);
    if (!entry || id === activeId || id === splitId || entry.keepAlive === true) continue;
    const wc = view.webContents;
    if (wc.isDestroyed() || wc.isCurrentlyAudible()) continue;
    if (now - (lastActive.get(id) || 0) > limit) hibernate(id);
  }
}

/* ---------- Bildschirm waehrend Audio/Anrufen aktiv halten ---------- */

function updateAwakeBlocker() {
  let audible = false;
  for (const view of views.values()) {
    try {
      if (!view.webContents.isDestroyed() && view.webContents.isCurrentlyAudible()) { audible = true; break; }
    } catch { /* egal */ }
  }
  if (audible && awakeBlockerId === null) {
    awakeBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!audible && awakeBlockerId !== null) {
    powerSaveBlocker.stop(awakeBlockerId);
    awakeBlockerId = null;
  }
}

/* ---------- App-Sperre (PIN) ---------- */

const lockFile = () => path.join(app.getPath('userData'), 'lock.json');
let lockCfg = { enabled: false, hash: null, salt: null, autoLockMinutes: 0, hello: false };

const hashPin = (pin, salt) => crypto.createHash('sha256').update(String(salt) + String(pin)).digest('hex');

function loadLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw.hash === 'string') {
      lockCfg = {
        enabled: raw.enabled === true,
        hash: raw.hash,
        salt: String(raw.salt || ''),
        autoLockMinutes: Number(raw.autoLockMinutes) || 0,
        hello: raw.hello === true,
      };
    }
  } catch { /* keine Sperre gesetzt */ }
  return lockCfg;
}

function saveLock() {
  try { fs.writeFileSync(lockFile(), JSON.stringify(lockCfg)); } catch { /* egal */ }
}

function lockNow() {
  // Gesperrt werden kann mit PIN, mit Windows Hello oder mit beidem
  if ((!lockCfg.hash && lockCfg.hello !== true) || locked) return;
  locked = true;
  // Geschuetzte Apps sind nach der globalen Sperre wieder gesperrt
  for (const a of apps) if (a.protect === true) lockedApps.add(a.id);
  detach();
  send('ui:locked', true);
}

/* ---------- Geschuetzte Apps (eigene Sperre pro App) ---------- */

const isLockedApp = (id) => {
  const entry = findApp(id);
  return Boolean(entry && entry.protect === true && lockedApps.has(id));
};

function setAppProtect(id, on, verified = false) {
  const entry = findApp(id);
  if (!entry) return;
  if (!on && entry.protect === true && !verified) {
    // Schutz darf nicht ohne Bestaetigung entfernt werden
    send('ui:auth', { mode: 'unprotect', id });
    return;
  }
  if (on && !lockCfg.hash && lockCfg.hello !== true) {
    // Ohne PIN/Windows Hello gaebe es keinen Weg, die App wieder zu oeffnen
    dialog.showMessageBox(win, {
      type: 'warning',
      message: t('lock.needCredential'),
      detail: t('lock.needCredentialDetail'),
    });
    return;
  }
  entry.protect = on === true;
  entry.updatedAt = Date.now();
  if (on) lockedApps.add(id);
  else lockedApps.delete(id);
  saveApps();
  if (on && id === activeId) {
    detach();
    send('app:lock', { id });
  }
  send('apps:changed', publicState());
}

function lockAppNow(id) {
  const entry = findApp(id);
  if (!entry || entry.protect !== true) return;
  lockedApps.add(id);
  if (id === activeId) {
    detach();
    send('app:lock', { id });
  }
  send('apps:changed', publicState());
}

// Schutzstatus aus den App-Daten uebernehmen: ohne Anmeldedaten darf nie
// gesperrt werden, und neu geschuetzte Apps starten hinter ihrer Sperre
function syncProtectState(entry, wasProtect) {
  if (entry.protect === true && !lockCfg.hash && lockCfg.hello !== true) {
    entry.protect = false;
    dialog.showMessageBox(win, {
      type: 'warning',
      message: t('lock.needCredential'),
      detail: t('lock.needCredentialDetail'),
    });
  }
  if (entry.protect === true) {
    if (!wasProtect && (lockCfg.hash || lockCfg.hello === true)) {
      lockedApps.add(entry.id);
      if (activeId === entry.id) {
        detach();
        send('app:lock', { id: entry.id });
      }
    }
  } else {
    lockedApps.delete(entry.id);
  }
}

function unlockApp(id) {
  lockedApps.delete(id);
  send('apps:changed', publicState());
  attach(id);
}

// Komplette Sperre entfernen: ohne Anmeldedaten duerfen keine App-Sperren
// zurueckbleiben, sonst gibt es keinen Weg mehr in diese Apps
function clearLock() {
  lockCfg = { enabled: false, hash: null, salt: null, autoLockMinutes: 0, hello: false };
  saveLock();
  lockedApps.clear();
  for (const a of apps) {
    if (a.protect === true) {
      a.protect = false;
      a.updatedAt = Date.now();
    }
  }
  saveApps();
  if (locked) unlock();
  else {
    send('apps:changed', publicState());
    attach(activeId);   // falls eine App gerade hinter ihrer eigenen Sperre hing
    // Falls ihr Freigabe-Fenster offen ist: Zustand melden, damit es verschwindet
    send('app:active', {
      id: activeId,
      tabId: activeId ? (views.get(activeId)?.webContents.id ?? null) : null,
      partition: activeId && findApp(activeId) ? partitionOf(findApp(activeId)) : null,
    });
  }
  return lockState();
}

function unlock() {
  locked = false;
  send('ui:locked', false);
  attach(activeId);
}

const lockState = () => ({
  locked,
  hasPin: Boolean(lockCfg.hash),
  autoLockMinutes: lockCfg.autoLockMinutes,
});

// Nach Ablauf der Inaktivitaet automatisch sperren
function sweepLock() {
  if ((!lockCfg.hash && lockCfg.hello !== true) || locked || !lockCfg.autoLockMinutes) return;
  if (powerMonitor.getSystemIdleTime() >= lockCfg.autoLockMinutes * 60) lockNow();
}

// Geschuetzte Apps nach der eingestellten Zeit wieder sperren
// (lockAfter: -1 = beim Wechseln der App, > 0 = Minuten ohne Blick auf die App)
function sweepAppLocks() {
  if (!lockCfg.hash && lockCfg.hello !== true) return;
  const now = Date.now();
  for (const a of apps) {
    if (a.protect !== true || lockedApps.has(a.id) || !a.lockAfter || a.lockAfter < 0) continue;
    if (a.id === activeId) continue;   // die sichtbare App nicht vor der Nase wegsperren
    const idle = now - (lastActive.get(a.id) || now);
    if (idle > a.lockAfter * 60 * 1000) lockAppNow(a.id);
  }
}

/* ---------- Merker (lokale Flags wie "Tour gesehen") ---------- */

const flagsFile = () => path.join(app.getPath('userData'), 'flags.json');

function flagsRead() {
  try { return JSON.parse(fs.readFileSync(flagsFile(), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

function flagsWrite(patch) {
  try { fs.writeFileSync(flagsFile(), JSON.stringify({ ...flagsRead(), ...patch })); } catch { /* egal */ }
}

/* ---------- Jumplist (Windows) & Sprungmarken ---------- */

const activationArg = (argv) => {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--activate='));
  return hit ? hit.slice('--activate='.length) : null;
};

function buildJumpList() {
  if (process.platform !== 'win32' || !app.isReady()) return;
  try {
    const items = apps.slice(0, 10).map((a) => ({
      type: 'task',
      title: a.name,
      description: a.url,
      program: process.execPath,
      args: `--activate=${a.id}`,
      iconPath: path.join(__dirname, 'assets', 'icon.ico'),
      iconIndex: 0,
    }));
    app.setJumpList([{ type: 'custom', name: t('menu.apps'), items }]);
  } catch { /* egal */ }
}

/* ---------- Globaler Hotkey (Strg+Alt+L): Fenster ein-/ausblenden ---------- */

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused() && !locked) win.minimize();
  else {
    win.show();
    win.restore();
    win.focus();
    // Tastaturfokus sofort zurueck in die aktive App
    if (!locked && attachedView && !attachedView.webContents.isDestroyed()) attachedView.webContents.focus();
  }
}

function activate(id) {
  if (!findApp(id)) return;
  // Geschuetzte App: erst freigeben, dann wird sie angezeigt
  if (isLockedApp(id)) {
    activeId = id;
    detach();
    send('app:active', { id, tabId: null, partition: partitionOf(findApp(id)) });
    send('app:lock', { id });
    return;
  }
  // Klick auf die zweite Split-App tauscht die beiden Seiten
  if (splitId === id && activeId && activeId !== id) splitId = activeId;
  const prevId = activeId;
  if (activeId && activeId !== id) lastActive.set(activeId, Date.now());
  lastActive.set(id, Date.now());
  activeId = id;
  // "Beim Wechseln der App": die verlassene App wird wieder gesperrt
  const prev = prevId && prevId !== id ? findApp(prevId) : null;
  let justLocked = false;
  if (prev && prev.protect === true && prev.lockAfter === -1 && !lockedApps.has(prev.id)) {
    lockedApps.add(prev.id);
    justLocked = true;
  }
  detach();
  const view = ensureView(id);
  attach(id);
  const partition = partitionOf(findApp(id));
  if (view) extSystems.get(partition)?.selectTab(view.webContents);
  send('app:active', { id, tabId: view ? view.webContents.id : null, partition });
  if (justLocked) send('apps:changed', publicState());
}

async function removeApp(id, deletedAt = Date.now()) {
  const entry = findApp(id);
  if (!entry) return publicState();
  const partition = partitionOf(entry);
  destroyView(id);
  apps = apps.filter((a) => a.id !== id);
  deletedApps[id] = deletedAt;
  dropFaviconCache(id);
  saveApps();
  // Geteilte Sitzung nie löschen, sie gehört auch den anderen Apps
  if (partition !== SHARED_PARTITION) {
    try { await session.fromPartition(partition).clearStorageData(); } catch { /* egal */ }
  }
  if (activeId === id) {
    activeId = null;
    if (apps.length) activate(apps[0].id);
    else send('app:active', null);
  }
  return publicState();
}

/* ---------- Zertifikatsfehler: nur für Apps, die es ausdrücklich erlauben ---------- */

app.on('certificate-error', (event, webContents, _url, _error, _cert, callback) => {
  const data = webContents ? findApp(wcToApp.get(webContents.id)) : null;
  if (data && data.ignoreCerts) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

/* ---------- Fenster & Menü ---------- */

/* ---------- Sprache (deutsch/englisch) ---------- */

const langFile = () => path.join(app.getPath('userData'), 'lang.json');

// Gespeicherte Auswahl, sonst Systemsprache
function loadLocale() {
  try {
    const raw = JSON.parse(fs.readFileSync(langFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw.lang === 'string') return i18n.setLocale(raw.lang);
  } catch {}
  return i18n.setLocale(app.getLocale());
}

// Wechsel speichern und App neu starten, damit Menues und Fenster sauber umschalten
function changeLanguage(lang) {
  flushSave();   // app.exit feuert kein before-quit
  try { fs.writeFileSync(langFile(), JSON.stringify({ lang })); } catch {}
  app.relaunch();
  app.exit(0);
}

/* ---------- Farbschema (lila / original / blau / matrix) ---------- */

const THEME_BG = { lila: '#17122b', original: '#14161b', blau: '#0f1b2e', matrix: '#030803' };
let theme = 'lila';

const themeFile = () => path.join(app.getPath('userData'), 'theme.json');

// Gespeichertes Farbschema laden, Standard ist "lila"
function loadTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && THEME_BG[raw.theme]) theme = raw.theme;
  } catch {}
  return theme;
}

// Sofort umschalten: Fensterfarbe, Oberflaeche und Menue folgen ohne Neustart
function changeTheme(name) {
  if (!THEME_BG[name]) return;
  theme = name;
  try { fs.writeFileSync(themeFile(), JSON.stringify({ theme: name })); } catch {}
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(THEME_BG[name]);
    send('ui:theme', name);
  }
  buildMenu();
}

/* ---------- Position der App-Leiste (links / rechts / oben / unten) ---------- */

const RAIL_POSITIONS = new Set(['left', 'right', 'top', 'bottom']);
let rail = 'left';

const railFile = () => path.join(app.getPath('userData'), 'rail.json');

// Gespeicherte Position laden, Standard ist "links"
function loadRail() {
  try {
    const raw = JSON.parse(fs.readFileSync(railFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && RAIL_POSITIONS.has(raw.rail)) rail = raw.rail;
  } catch {}
  return rail;
}

// Sofort umschalten: Ansichtsgrenzen, Oberflaeche und Menue folgen ohne Neustart
function changeRail(name) {
  if (!RAIL_POSITIONS.has(name)) return;
  rail = name;
  try { fs.writeFileSync(railFile(), JSON.stringify({ rail: name })); } catch {}
  if (win && !win.isDestroyed()) send('ui:rail', name);
  layout();
  buildMenu();
}

/* ---------- Auto-Update (GitHub-Releases) ---------- */

// Stille Suche gegen github.com/luxsy-tech/luxbox (Tag = Version). Voraussetzung
// ist die publish-Konfiguration in package.json: Sie laesst electron-builder
// app-update.yml ins Paket legen und beim Bauen latest.yml erzeugen.
const { autoUpdater } = require('electron-updater');

// 'dev'  = Entwicklungsmodus, es gibt kein app-update.yml
// 'pkg'  = deb/rpm, das Paketsystem uebernimmt die Aktualisierung
// 'ok'   = Windows-Installer und AppImage aktualisieren sich selbst
function updateMode() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'pkg';
  return 'ok';
}

let updateDownloaded = null;      // Info zur geladenen Version, solange sie offen ist
let updateCheckRunning = false;   // keine zwei Suchen gleichzeitig
let updatePromptShown = false;    // "bereit"-Dialog hoechstens einmal pro Fund
let pendingInteractive = false;   // die laufende Suche kam aus dem Menue
let manualDownloadActive = false; // manuell bestaetigter Download laeuft noch

function showUpdateDialog(opts) {
  if (win && !win.isDestroyed()) return dialog.showMessageBox(win, opts);
  return dialog.showMessageBox(opts);
}

function showUpdateError(err) {
  showUpdateDialog({
    type: 'error',
    message: t('update.failed'),
    detail: String((err && err.message) || err || 'Unknown error'),
  });
}

// Einmal geladen: nachfragen, ob sofort neu gestartet wird. Auf "Später"
// antwortet autoInstallOnAppQuit beim naechsten Beenden mit der Installation.
function promptUpdateReady() {
  if (updatePromptShown || !updateDownloaded) return;
  updatePromptShown = true;
  manualDownloadActive = false;
  showUpdateDialog({
    type: 'info',
    buttons: [t('update.restart'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
    message: t('update.downloaded'),
    detail: t('update.downloadedDetail', { version: updateDownloaded.version }),
  }).then(({ response }) => {
    if (response === 0) {
      // still installieren und danach neu starten; bei perMachine fragt
      // NSIS vorher einmalig nach Administratorrechten (UAC).
      try { allowQuit = true; } catch {}
      autoUpdater.quitAndInstall(true, true);
    }
  }).catch(() => {});
}

autoUpdater.autoDownload = true;          // Fund im Hintergrund gleich laden
autoUpdater.autoInstallOnAppQuit = true;  // "Später" = beim naechsten Beenden
autoUpdater.allowDowngrade = false;
// Konsole ruhig halten: infos ausblenden, Warnungen und Fehler behalten
autoUpdater.logger = {
  info: () => {}, debug: () => {},
  warn: (...a) => console.warn('[update]', ...a),
  error: (...a) => console.error('[update]', ...a),
};

autoUpdater.on('update-available', (info) => {
  const interactive = pendingInteractive;
  pendingInteractive = false;
  if (interactive) {
    manualDownloadActive = true;
    showUpdateDialog({
      type: 'info',
      message: t('update.found'),
      detail: t('update.foundDetail', { version: (info && info.version) || '' }),
    }).catch(() => {});
  }
});

autoUpdater.on('update-not-available', () => {
  if (!pendingInteractive) return;
  pendingInteractive = false;
  showUpdateDialog({
    type: 'info',
    message: t('update.none'),
    detail: t('update.noneDetail', { version: app.getVersion() }),
  }).catch(() => {});
});

autoUpdater.on('update-downloaded', (info) => {
  updateDownloaded = info;
  promptUpdateReady();
});

autoUpdater.on('error', (err) => {
  console.warn('[update]', (err && err.message) || err);
  // Fehler entweder aus der Suche oder aus einem bestaetigten Download melden;
  // beide Flaggen sind beim ersten Treffer verbraucht, also nie doppelt.
  if (pendingInteractive) {
    pendingInteractive = false;
    manualDownloadActive = false;
    showUpdateError(err);
  } else if (manualDownloadActive) {
    manualDownloadActive = false;
    showUpdateError(err);
  }
});

// menu:checkUpdate (true) meldet auch "kein Update", die stille Suche nicht.
async function checkForUpdates(interactive) {
  const mode = updateMode();
  if (mode !== 'ok') {
    if (interactive) showUpdateDialog({
      type: 'info',
      message: t(mode === 'dev' ? 'update.devMode' : 'update.pkgManager'),
      detail: t(mode === 'dev' ? 'update.devModeDetail' : 'update.pkgManagerDetail', { version: app.getVersion() }),
    });
    return;
  }
  if (updateCheckRunning) return;
  updateCheckRunning = true;
  pendingInteractive = Boolean(interactive);
  if (interactive) updatePromptShown = false; // manuelle Suche darf erneut fragen
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // war der Fehler schon per 'error'-Flag gemeldet, bleibt die Flagge leer
    if (pendingInteractive) {
      pendingInteractive = false;
      manualDownloadActive = false;
      showUpdateError(err);
    } else {
      console.warn('[update]', (err && err.message) || err);
    }
  } finally {
    updateCheckRunning = false;
  }
}

// Aktionen fuer die Menues: aufgerufen vom nativen Menue (unsichtbar, haelt die
// Tastenkuerzel) und von der eigenen Menueleiste im Fenster ueber 'menu:click'.
const activeViewWc = () => (activeId && views.get(activeId)?.webContents) || null;

// Bearbeiten und Zoom wirken auf den Inhalt der aktiven App, nicht auf die Huellflaeche
const contentWc = () => activeViewWc() || (win && !win.isDestroyed() ? win.webContents : null);

function switchToApp(index) {
  if (apps[index]) activate(apps[index].id);
}

function cycleApps(dir) {
  if (!apps.length) return;
  const i = apps.findIndex((a) => a.id === activeId);
  activate(apps[(i + dir + apps.length) % apps.length].id);
}

const menuActions = {
  autostart: () => toggleAutoStart(),
  sync: () => send('ui:open-sync'),
  hibernate: (minutes) => {
    settings.hibernateMinutes = Number(minutes) || 0;
    settings.updatedAt = Date.now();
    saveApps();
  },
  language: (lang) => changeLanguage(lang),
  checkUpdate: () => checkForUpdates(true),
  theme: (name) => changeTheme(name),
  rail: (pos) => changeRail(pos),
  quit: () => app.quit(),
  reload: () => activeViewWc()?.reload(),
  nextApp: () => cycleApps(1),
  prevApp: () => cycleApps(-1),
  app: (index) => switchToApp(Number(index)),
  manageExtensions: () => send('ui:open-extensions'),
  storeChrome: () => openStore('chrome'),
  storeEdge: () => openStore('edge'),
  installStorePage: () => installCurrentStorePage(),
  edit: (role, where) => {
    // Bearbeiten wirkt auf die aktive App - ausser das Kontextmenue der Huellflaeche
    // (where: 'shell') fragt nach Aktionen fuer ein Eingabefeld im Fenster selbst
    const wc = where === 'shell' ? (win && !win.isDestroyed() ? win.webContents : null) : contentWc();
    if (wc && typeof wc[role] === 'function') wc[role]();
  },
  zoom: (what) => {
    const wc = contentWc();
    if (!wc) return;
    if (what === 'reset') wc.setZoomLevel(0);
    else wc.setZoomLevel(wc.getZoomLevel() + (what === 'in' ? 0.5 : -0.5));
  },
  fullscreen: () => { if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()); },
  devTools: () => (activeViewWc() || (win && !win.isDestroyed() ? win.webContents : null))
    ?.openDevTools({ mode: 'detach' }),
  split: (id) => setSplit(id),
  splitOff: () => clearSplit(),
  lockSet: () => send('ui:open-pin'),
  lockNow: async () => {
    // Nur-Hello-Sperre nur, wenn Windows Hello auch wirklich entsperren kann
    if (!lockCfg.hash && lockCfg.hello === true) {
      const status = await helloStatus();
      if (status !== 'Available') {
        dialog.showMessageBox(win, { type: 'warning', message: t('lock.helloUnavailable'), detail: t('lock.helloSetup') });
        return;
      }
    }
    lockNow();
  },
  lockClear: (verified) => {
    // Sperre entfernen nur nach bestätigter Identität
    if (verified !== true && (lockCfg.hash || lockCfg.hello === true)) {
      send('ui:auth', { mode: 'lockClear' });
      return;
    }
    clearLock();
  },
  lockAuto: (minutes) => {
    lockCfg.autoLockMinutes = Number(minutes) || 0;
    saveLock();
  },
  keys: () => send('ui:open-keys'),
  info: () => send('ui:open-info', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    apps: apps.length,
    license: 'GPL-3.0-only',
    userData: app.getPath('userData'),
  }),
  mixer: () => send('ui:open-mixer'),
  tour: () => send('ui:tour'),
  helloToggle: async (verified) => {
    if (lockCfg.hello !== true) {
      const status = await helloStatus();
      if (status !== 'Available') {
        dialog.showMessageBox(win, { type: 'warning', message: t('lock.helloUnavailable'), detail: t('lock.helloSetup') });
        return;
      }
    } else if (verified !== true) {
      // Abschalten kann den letzten Freigabeweg nehmen: nur nach Bestätigung
      send('ui:auth', { mode: 'helloOff' });
      return;
    }
    lockCfg.hello = lockCfg.hello !== true;
    saveLock();
  },
  perms: (id) => send('ui:open-perms', { id, perms: (findApp(id) && findApp(id).perms) || {} }),
  appProtectOn: (id) => setAppProtect(id, true),
  appProtectOff: (id) => setAppProtect(id, false),
  appLockNow: (id) => lockAppNow(id),
  iconSet: async (id) => {
    const entry = findApp(id);
    if (!entry) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('dialog.iconTitle'),
      properties: ['openFile'],
      filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp'] }],
    });
    if (canceled || !filePaths[0]) return;
    try {
      const buf = fs.readFileSync(filePaths[0]);
      if (buf.length > 512 * 1024) throw new Error(t('dialog.iconTooBig'));
      const ext = path.extname(filePaths[0]).slice(1).toLowerCase();
      const mime = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp',
      }[ext] || 'image/png';
      const data = `data:${mime};base64,${buf.toString('base64')}`;
      entry.favicon = data;
      entry.customIcon = true;
      writeFaviconCache(id, data);
      saveApps();
      pushState(id, true);
    } catch (err) {
      dialog.showMessageBox(win, { type: 'error', message: t('dialog.iconFailed'), detail: err.message });
    }
  },
  iconReset: (id) => {
    const entry = findApp(id);
    if (!entry) return;
    entry.customIcon = false;
    entry.favicon = null;
    entry.faviconSrc = null;
    dropFaviconCache(id);
    saveApps();
    pushState(id, true);
    fallbackIcon(id);
  },
  exportConfig: async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('dialog.exportTitle'),
      defaultPath: `luxbox-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return;
    try {
      const snapshot = sync.buildSnapshot(localSyncState(), {
        deviceId: syncCfg.deviceId || crypto.randomUUID(),
        deviceName: os.hostname(),
      });
      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      dialog.showMessageBox(win, { type: 'error', message: t('dialog.exportFailed'), detail: err.message });
    }
  },
  importConfig: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: t('dialog.importTitle'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8').replace(/^\uFEFF/, ''));
      const remote = sync.validateSnapshot(raw, normalizeUrl);
      if (!remote) throw new Error(t('dialog.importInvalid'));
      await applyMerged(sync.merge(localSyncState(), [remote]));
      dialog.showMessageBox(win, { type: 'info', message: t('dialog.importOk') });
    } catch (err) {
      dialog.showMessageBox(win, { type: 'error', message: t('dialog.importFailed'), detail: err.message });
    }
  },
};

// Das native Menue bleibt erhalten, ist aber ausgeblendet: Es stellt die
// Tastenkuerzel bereit (Strg+R, Strg+Tab, F12 ...), waehrend die sichtbare
// Menueleiste im Fenster den Farbschemas folgt (siehe renderer.js).
function buildMenu() {
  const switchTo = (index) => {
    if (apps[index]) activate(apps[index].id);
  };
  const cycle = (dir) => {
    if (!apps.length) return;
    const i = apps.findIndex((a) => a.id === activeId);
    activate(apps[(i + dir + apps.length) % apps.length].id);
  };
  const activeWc = () => (activeId && views.get(activeId)?.webContents) || null;

  const template = [
    {
      label: t('menu.settings'),
      submenu: [
        {
          label: t('menu.autostart'),
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          accelerator: 'Ctrl+Shift+A',
          click: (menuItem) => {
            const isNowEnabled = toggleAutoStart();
            menuItem.checked = isNowEnabled;
          },
        },
		{ label: t('menu.sync'), click: () => send('ui:open-sync') },
		{
          label: t('menu.hibernate'),
          submenu: [[0, t('menu.hibernateNever')], [5, t('menu.hibernateMinutes', { n: 5 })], [15, t('menu.hibernateMinutes', { n: 15 })], [30, t('menu.hibernateMinutes', { n: 30 })], [60, t('menu.hibernateMinutes', { n: 60 })]].map(
            ([minutes, label]) => ({
              label,
              type: 'radio',
              checked: settings.hibernateMinutes === minutes,
              click: () => { settings.hibernateMinutes = minutes; settings.updatedAt = Date.now(); saveApps(); },
            }),
          ),
        },
        {
          label: t('menu.language'),
          submenu: [
            { label: 'Deutsch', type: 'radio', checked: i18n.getLocale() === 'de', click: () => changeLanguage('de') },
            { label: 'English', type: 'radio', checked: i18n.getLocale() === 'en', click: () => changeLanguage('en') },
            { label: 'Español', type: 'radio', checked: i18n.getLocale() === 'es', click: () => changeLanguage('es') },
          ],
        },
        {
          label: t('menu.design'),
          submenu: [
            { label: t('menu.theme'), enabled: false },
            { label: t('menu.themeLila'), type: 'radio', checked: theme === 'lila', click: () => changeTheme('lila') },
            { label: t('menu.themeOriginal'), type: 'radio', checked: theme === 'original', click: () => changeTheme('original') },
            { label: t('menu.themeBlau'), type: 'radio', checked: theme === 'blau', click: () => changeTheme('blau') },
            { label: t('menu.themeMatrix'), type: 'radio', checked: theme === 'matrix', click: () => changeTheme('matrix') },
            { type: 'separator' },
            { label: t('menu.rail'), enabled: false },
            { label: t('menu.railLeft'), type: 'radio', checked: rail === 'left', click: () => changeRail('left') },
            { label: t('menu.railRight'), type: 'radio', checked: rail === 'right', click: () => changeRail('right') },
            { label: t('menu.railTop'), type: 'radio', checked: rail === 'top', click: () => changeRail('top') },
            { label: t('menu.railBottom'), type: 'radio', checked: rail === 'bottom', click: () => changeRail('bottom') },
          ],
        },
        { type: 'separator' },
        { label: t('menu.checkUpdate'), click: () => checkForUpdates(true) },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.apps'),
      submenu: [
        { label: t('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
        { type: 'separator' },
        { label: t('menu.nextApp'), accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: t('menu.prevApp'), accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: t('menu.appN', { n: i + 1 }),
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => switchTo(i),
        })),
        { type: 'separator' },
        { label: t('menu.extensions'), enabled: false },
        { label: t('menu.manage'), click: () => send('ui:open-extensions') },
        { type: 'separator' },
        { label: t('ext.openChrome'), click: () => openStore('chrome') },
        { label: t('ext.openEdge'), click: () => openStore('edge') },
        { label: t('menu.installStorePage'), accelerator: 'CmdOrCtrl+Shift+E', click: () => installCurrentStorePage() },
      ],
    },
    { label: t('menu.edit'), role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: t('menu.devTools'), accelerator: 'F12', click: () => activeWc()?.openDevTools({ mode: 'detach' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Startargumente fuer die Renderer der Fenster. Splash und Hauptfenster MUESSEN
// dieselben Werte tragen (siehe Kommentar in createSplash).
function rendererArgs() {
  return [`--luxbox-locale=${i18n.getLocale()}`, `--luxbox-theme=${theme}`, `--luxbox-rail=${rail}`];
}

function createSplash() {
  splashStart = Date.now();
  splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#17122b',
    icon: appIcon,
    webPreferences: {
      // Gleicher Sandbox-Modus wie das Hauptfenster: beide Fenster teilen sich
      // (process-per-site) einen Renderer-Prozess. Waehre das Splash-Fenster
      // gesandboxt, koennte das Hauptfenster diesen Modus erben und der Preload
      // (window.api) wuerde nicht starten - die App-Liste bliebe dann leer.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Aus dem gleichen Grund muessen beide Fenster dieselben Startargumente
      // tragen: teilen sie den Prozess, gilt die Kommandozeile des zuerst
      // erzeugten Fensters. Ohne sie gingen Sprache, Farbschema und
      // Leistenposition beim Start verloren (Fenster bliebe dann links).
      additionalArguments: rendererArgs(),
    },
  });
  splash.loadFile('boot.html');
  // Falls das Hauptfenster nicht erscheint, schliessen wir den Splash trotzdem.
  setTimeout(closeSplash, 8000);
  splash.on('closed', () => { splash = null; });
}

function closeSplash() {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents
    .executeJavaScript("document.body.classList.add('out'); true")
    .catch(() => {});
  setTimeout(() => {
    if (splash && !splash.isDestroyed()) splash.close();
  }, 400);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    title: 'Luxbox',
    show: false,   // bleibt versteckt, bis ready-to-show die Boot-Animation abloest
    icon: appIcon,   // Fenster- und Taskleisten-Icon unter Windows und Linux
    backgroundColor: THEME_BG[theme],
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: rendererArgs(),
      contextIsolation: true,
      nodeIntegration: false,
      // Der Preload lädt electron-chrome-extensions per require. Im Fenster läuft nur lokaler Code.
      sandbox: false,
    },
  });
  // Preload-Fehler sichtbar machen: frueher ist das Skript still gestorben,
  // dann blieb die App-Liste leer. Protokoll: _diag.log im App-Ordner.
  win.webContents.on('preload-error', (_e, p, err) => {
    const line = `${new Date().toISOString()} [main] preload-error: ${p} -> ${(err && err.stack) || err}\n`;
    console.warn(line);
    try { fs.appendFileSync(path.join(__dirname, '_diag.log'), line); } catch {}
  });
  // Eigene Menueleiste im Fenster zeigt die Menues farbig an (renderer.js);
  // das native Menue bleibt als unsichtbare Basis fuer Tastenkuerzel erhalten.
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript('typeof window.api').then((kind) => {
      if (kind !== 'object') {
        const line = `${new Date().toISOString()} [main] window.api fehlt im Renderer (preload nicht gelaufen)\n`;
        console.warn(line);
        try { fs.appendFileSync(path.join(__dirname, '_diag.log'), line); } catch {}
      }
    }).catch(() => {});
  });
  // Boot-Animation: Hauptfenster erst zeigen, wenn es gemalt ist, danach Splash ausblenden.
  win.once('ready-to-show', () => {
    win.show();
    const elapsed = Date.now() - splashStart;
    setTimeout(closeSplash, Math.max(0, BOOT_MIN_MS - elapsed));
  });
  // Das Schliessen-Kreuz oben rechts (und Alt+F4) bringt die App nur in die
  // Taskleiste: Sie laeuft mit allen Apps weiter. Komplett beendet wird sie
  // ausschliesslich ueber "Beenden" im Menue Einstellungen.
  win.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    win.minimize();
  });
  win.on('resize', layout);
  // Wenn das Fenster (wieder) aktiv wird, gehoert der Tastaturfokus der App,
  // nicht der Huelle - sonst reagiert die aktive App nicht mehr auf Tasten
  win.on('focus', () => {
    if (!locked && attachedView && !attachedView.webContents.isDestroyed()) {
      attachedView.webContents.focus();
    }
  });
  win.on('closed', () => { win = null; });
}

function toggleAutoStart() {
  const settings = app.getLoginItemSettings();
  const nextState = !settings.openAtLogin;

  app.setLoginItemSettings({
    openAtLogin: nextState,
    path: app.getPath('exe'),
  });

  console.log(nextState ? 'Auto-Start aktiviert' : 'Auto-Start deaktiviert');
  return nextState;
}


migrateOldData();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Start über eine Jumplist-Sprungmarke: die gewuenschte App oeffnen
    const id = activationArg(argv);
    if (id && findApp(id)) activate(id);
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  loadApps();
  loadLock();
  // Geschuetzte Apps starten gesperrt - aber nur, wenn es einen Freigabeweg gibt
  const canUnlock = Boolean(lockCfg.hash) || lockCfg.hello === true;
  for (const a of apps) if (canUnlock && a.protect === true) lockedApps.add(a.id);
  // Damit Windows-Meldungen sauber zur App zurueckfuehren
  try { app.setAppUserModelId('local.luxbox'); } catch { /* aeltere Versionen haben andere Namen */ }
  // Beim Herunterfahren des Systems duerfen die Fenster wirklich schliessen
  powerMonitor.on('shutdown', () => { allowQuit = true; });
  if (appIcon && process.platform === 'darwin' && app.dock) app.dock.setIcon(appIcon); // im Entwicklungsmodus
  // Globaler Hotkey (Strg+Alt+L) blendet das Fenster ein/aus
  try { globalShortcut.register('CommandOrControl+Alt+L', toggleWindow); } catch { /* Hotkey belegt */ }
  setInterval(() => { sweepHibernation(); sweepLock(); sweepAppLocks(); updateAwakeBlocker(); }, 60 * 1000);
  setInterval(() => scheduleSync(0), 5 * 60 * 1000); // Auffangnetz, falls der Ordner-Watcher nichts meldet

  // Auto-Update: einmal still nach neuen Releases suchen - nichts gefunden
  // kostet keine Meldung, ein Fund meldet sich, sobald das Paket geladen ist.
  // 60 Sekunden Wartezeit, damit Netzwerk und Config-Sync zuerst Platz haben.
  setTimeout(() => checkForUpdates(false), 60 * 1000);

  // Aktuellen Auto-Start-Zustand über Electrons eingebaute Funktion prüfen
  const isAutoStartEnabled = app.getLoginItemSettings().openAtLogin;
  console.log(isAutoStartEnabled ? 'Auto-Start ist aktiviert' : 'Auto-Start ist deaktiviert');

  loadLocale();
  loadTheme();
  loadRail();
  buildMenu();
  createSplash();
  createWindow();

  // Füge diesen Code hinzu, um den WebContents-Event zu verarbeiten
  win.webContents.once('did-finish-load', () => {
    // Sprungmarke/Jumplist kann eine bestimmte App anfordern (--activate=<id>)
    const wanted = activationArg(process.argv);
    const startId = wanted && findApp(wanted) ? wanted : (apps[0] && apps[0].id);
    if (startId) activate(startId);
    buildJumpList();
    setupWatcher();
    scheduleSync(1000);
    // Beim ersten Start die Kurz-Einfuehrung zeigen
    if (!flagsRead().onboarding) send('ui:tour');
  });
});

  app.on('window-all-closed', () => app.quit());
}

/* ---------- IPC ---------- */

ipcMain.handle('apps:list', () => publicState());

ipcMain.handle('toggle-autostart', () => {
  return toggleAutoStart();
});

ipcMain.handle('apps:add', (_e, data) => {
  const entry = {
    id: crypto.randomUUID(), muted: false, ...sanitize(data), updatedAt: Date.now(),
  };
  apps.push(entry);
  syncProtectState(entry, false);
  saveApps();
  activate(entry.id);
  fallbackIcon(entry.id);
  return publicState();
});

ipcMain.handle('apps:update', (_e, id, data) => {
  const entry = findApp(id);
  if (!entry) return publicState();
  const next = sanitize(data);
  const wasProtect = entry.protect === true;
  const urlChanged = next.url !== entry.url;
  const sessionChanged = partitionOf({ ...entry, ...next }) !== partitionOf(entry);
  if (sessionChanged) destroyView(id);   // wird mit der neuen Sitzung neu erzeugt
  Object.assign(entry, next);
  entry.updatedAt = Date.now();
  syncProtectState(entry, wasProtect);
  saveApps();
  if (sessionChanged && activeId === id) activate(id);
  if (urlChanged && !sessionChanged) {
    entry.favicon = null;
    entry.faviconSrc = null;
    dropFaviconCache(id);
    views.get(id)?.webContents.loadURL(entry.url).catch(() => {});
    fallbackIcon(id);
  }
  return publicState();
});

ipcMain.handle('apps:remove', (_e, id) => removeApp(id));

ipcMain.handle('apps:activate', (_e, id) => activate(id));

ipcMain.handle('apps:reload', (_e, id) => {
  views.get(id)?.webContents.reload();
});

ipcMain.handle('apps:reorder', (_e, ids) => {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length === apps.length) {
    apps = ordered;
    orderAt = Date.now();
    saveApps();
  }
  return publicState();
});

ipcMain.handle('ui:overlay', (_e, open) => {
  overlayOpen = open === true;
  if (overlayOpen) detach();
  else attach(activeId);
});

/* ---------- Eigene Menueleiste im Fenster ---------- */

ipcMain.handle('menu:click', (_e, id, value, where) => {
  const fn = menuActions[id];
  if (fn) fn(value, where);
});

// Zustand fuer die Haken und Punkte der Menueleiste
ipcMain.handle('menu:state', () => ({
  autostart: app.getLoginItemSettings().openAtLogin,
  hibernate: settings.hibernateMinutes,
  locale: i18n.getLocale(),
  theme,
  rail,
  hasPin: Boolean(lockCfg.hash),
  lockAuto: lockCfg.autoLockMinutes,
  hello: lockCfg.hello === true,
  canLock: Boolean(lockCfg.hash) || lockCfg.hello === true,
}));

// Bild der App-Ansicht: es liegt als eingefrorenes Bild unter dem Aufklappmenue,
// waehrend die native Ansicht kurz abgehaengt ist. Ohne anhaengende Ansicht gibt
// es nichts, das verschwinden wuerde - dann wird kein Hintergrund benoetigt.
ipcMain.handle('ui:capture', async () => {
  const view = attachedView;
  if (!win || win.isDestroyed() || !view) return null;
  const bounds = view.getBounds();
  try {
    const img = await view.webContents.capturePage();
    return { shot: img.toDataURL(), bounds };
  } catch {
    return { shot: null, bounds };   // dann zeigt der Renderer das Logo als Platzhalter
  }
});

// Taskleisten-Badge: gezeichnetes Symbol aus dem Renderer aufs Fenster-Icon legen
ipcMain.handle('ui:badge', (_e, dataUrl, desc) => {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  try {
    win.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, desc || '');
  } catch { /* egal */ }
});

// Dateien auf ein App-Symbol gelegt: in die Ablage legen, App oeffnen und
// einfuegen (Strg+V) - so landen sie in den meisten Web-Apps im Chat/Editor
ipcMain.handle('apps:drop', (_e, id, files) => {
  const paths = Array.isArray(files) ? files.filter((p) => typeof p === 'string' && fs.existsSync(p)) : [];
  if (!paths.length || !findApp(id)) return;
  clipboard.write({ files: paths });
  activate(id);
  const wc = views.get(id)?.webContents;
  if (wc && !wc.isDestroyed()) {
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: ['control'] });
    }, 500);
  }
});

/* ---------- IPC: App-Sperre ---------- */

ipcMain.handle('lock:state', () => lockState());

ipcMain.handle('lock:set', (_e, pin) => {
  const value = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(value)) return { ok: false, error: 'short' };
  const salt = crypto.randomBytes(8).toString('hex');
  lockCfg = {
    enabled: true,
    hash: hashPin(value, salt),
    salt,
    autoLockMinutes: lockCfg.autoLockMinutes,
    hello: lockCfg.hello === true,
  };
  saveLock();
  return { ok: true, state: lockState() };
});

ipcMain.handle('lock:clear', () => clearLock());

ipcMain.handle('lock:check', (_e, pin) => {
  // Ohne PIN gibt es den PIN-Weg nicht - dann entsperrt nur Windows Hello
  if (!lockCfg.hash) return false;
  if (hashPin(String(pin || ''), lockCfg.salt) === lockCfg.hash) {
    unlock();
    return true;
  }
  return false;
});

ipcMain.handle('lock:now', () => { lockNow(); return lockState(); });

ipcMain.handle('lock:auto', (_e, minutes) => {
  lockCfg.autoLockMinutes = Number(minutes) || 0;
  saveLock();
  return lockState();
});

/* ---------- IPC: Windows Hello ---------- */

ipcMain.handle('lock:hello-state', async () => ({
  enabled: lockCfg.hello === true,
  available: (await helloStatus()) === 'Available',
}));

ipcMain.handle('lock:hello-toggle', async () => {
  if (lockCfg.hello !== true) {
    const status = await helloStatus();
    if (status !== 'Available') {
      // Ohne eingerichtetes Windows Hello wuerde die Sperre ohne Ausweg bleiben
      dialog.showMessageBox(win, { type: 'warning', message: t('lock.helloUnavailable'), detail: t('lock.helloSetup') });
      return { enabled: false, available: false, refused: true };
    }
  }
  lockCfg.hello = lockCfg.hello !== true;
  saveLock();
  return { enabled: lockCfg.hello, available: (await helloStatus()) === 'Available' };
});

ipcMain.handle('lock:hello-unlock', async () => {
  if (!locked || lockCfg.hello !== true) return { ok: false };
  const status = await helloStatus();
  if (status !== 'Available') return { ok: false, reason: status };
  const ok = await helloVerify();
  if (ok) unlock();
  return { ok, reason: ok ? 'Verified' : 'Canceled' };
});

/* ---------- IPC: Freigabe geschuetzter Apps ---------- */

ipcMain.handle('app:unlock', (_e, id, pin) => {
  if (!isLockedApp(id)) return true;
  // Ohne PIN und ohne Windows Hello gibt es keinen Freigabeweg:
  // dann darf die App nie gesperrt bleiben (Notventil)
  if (!lockCfg.hash && lockCfg.hello !== true) {
    unlockApp(id);
    return true;
  }
  if (lockCfg.hash && hashPin(String(pin || ''), lockCfg.salt) === lockCfg.hash) {
    unlockApp(id);
    return true;
  }
  return false;
});

ipcMain.handle('app:hello-unlock', async (_e, id) => {
  if (!isLockedApp(id)) return { ok: true };
  if (lockCfg.hello !== true) {
    if (!lockCfg.hash) {
      unlockApp(id);
      return { ok: true };
    }
    return { ok: false };
  }
  const status = await helloStatus();
  if (status !== 'Available') return { ok: false, reason: status };
  const ok = await helloVerify();
  if (ok) unlockApp(id);
  return { ok, reason: ok ? 'Verified' : 'Canceled' };
});

/* ---------- IPC: Berechtigungen, Audio-Mixer, Tour ---------- */

ipcMain.handle('perms:get', (_e, id) => ({ perms: (findApp(id) && findApp(id).perms) || {} }));

ipcMain.handle('perms:set', (_e, id, perms) => {
  const entry = findApp(id);
  if (!entry) return;
  entry.perms = sanitizePerms(perms);
  entry.updatedAt = Date.now();
  saveApps();
});

ipcMain.handle('mixer:list', () => apps.map((a) => {
  let audible = false;
  try {
    const view = views.get(a.id);
    if (view && !view.webContents.isDestroyed()) audible = view.webContents.isCurrentlyAudible();
  } catch { /* egal */ }
  return { id: a.id, name: a.name, muted: a.muted === true, audible };
}));

ipcMain.handle('mixer:mute', (_e, id, muted) => {
  const entry = findApp(id);
  if (!entry) return;
  entry.muted = muted === true;
  entry.updatedAt = Date.now();
  views.get(id)?.webContents.setAudioMuted(entry.muted);
  saveApps();
  send('apps:changed', publicState());
});

ipcMain.handle('mixer:all', (_e, muted) => {
  for (const entry of apps) {
    entry.muted = muted === true;
    entry.updatedAt = Date.now();
    views.get(entry.id)?.webContents.setAudioMuted(entry.muted);
  }
  saveApps();
  send('apps:changed', publicState());
});

ipcMain.handle('tour:done', () => flagsWrite({ onboarding: true }));

/* ---------- IPC: Identitaetsbestaetigung (Sperren entfernen) ---------- */

// Reine Pruefung ohne Nebenwirkungen
ipcMain.handle('auth:verify', (_e, pin) => {
  if (!lockCfg.hash) return lockCfg.hello !== true;
  return hashPin(String(pin || ''), lockCfg.salt) === lockCfg.hash;
});

ipcMain.handle('auth:hello', async () => {
  if (lockCfg.hello !== true) return false;
  const status = await helloStatus();
  if (status !== 'Available') return false;
  return helloVerify();
});

// Nach erfolgreicher Bestaetigung: Schutz einer App wirklich entfernen
ipcMain.handle('app:unprotect', (_e, id) => {
  setAppProtect(id, false, true);
});

// Konfigurationsordner aus dem Info-Dialog oeffnen
ipcMain.handle('app:open-userdata', () => shell.openPath(app.getPath('userData')));

ipcMain.handle('apps:context-menu', (_e, id) => {
  const entry = findApp(id);
  if (!entry || !win) return;
  const wc = () => views.get(id)?.webContents;

  Menu.buildFromTemplate([
    { label: t('menu.reload'), click: () => wc()?.reload() },
    { label: t('ctx.hibernateNow'), enabled: id !== activeId && views.has(id), click: () => hibernate(id) },
    { label: t('ctx.home'), click: () => wc()?.loadURL(entry.url).catch(() => {}) },
    {
      label: t('menu.appProtect'),
      type: 'checkbox',
      checked: entry.protect === true,
      click: (item) => setAppProtect(id, item.checked),
    },
    { label: t('menu.appLockNow'), enabled: entry.protect === true && !isLockedApp(id), click: () => lockAppNow(id) },
    { label: t('menu.split'), enabled: Boolean(activeId) && id !== activeId, click: () => setSplit(id) },
    { label: t('menu.splitOff'), enabled: Boolean(splitId), click: () => clearSplit() },
    { label: t('menu.perms'), click: () => send('ui:open-perms', { id, perms: entry.perms || {} }) },
    { label: t('menu.iconSet'), click: () => menuActions.iconSet(id) },
    { label: t('menu.iconReset'), enabled: entry.customIcon === true, click: () => menuActions.iconReset(id) },
    {
      label: t('ctx.mute'),
      type: 'checkbox',
      checked: entry.muted === true,
      click: (item) => {
        entry.muted = item.checked;
        entry.updatedAt = Date.now();
        wc()?.setAudioMuted(entry.muted);
        saveApps();
        send('apps:changed', publicState());
      },
    },
    { label: t('ctx.edit'), click: () => send('app:edit-request', id) },
    { label: t('menu.devTools'), click: () => wc()?.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    {
      label: t('ctx.remove'),
      click: async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: [t('dialog.remove'), t('dlg.cancel')],
          defaultId: 1,
          cancelId: 1,
          message: t('dialog.removeMessage', { name: entry.name }),
          detail: t('dialog.removeDetail'),
        });
        if (response !== 0) return;
        await removeApp(id);
        send('apps:changed', publicState());
      },
    },
  ]).popup({ window: win });
});

/* ---------- Erweiterungen verwalten ---------- */

async function registerExtension(info) {
  info.updatedAt = Date.now();
  if (info.id) delete deletedExt[info.id];
  extensions.push(info);
  saveApps();
  // in alle bereits aktiven App-Sitzungen laden und Seiten neu laden
  for (const [id, view] of views) {
    if (view.webContents.isDestroyed()) continue;
    const partition = partitionOf(findApp(id));
    registerTab(view.webContents, view.webContents.session, partition);
    await loadExtensionsInto(view.webContents.session, partition);
    view.webContents.reload();
  }
  send('ext:changed', extView());
}

async function installById(parsed) {
  if (extensions.some((e) => e.id === parsed.id)) {
    return { extensions: extView(), error: t('err.extInstalled') };
  }
  try {
    await registerExtension(await installFromStore(parsed));
    return { extensions: extView() };
  } catch (err) {
    return { extensions: extView(), error: t('err.extInstallFailed', { error: err.message }) };
  }
}

const STORE_URLS = {
  chrome: 'https://chromewebstore.google.com/',
  edge: 'https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home',
};

function openStore(kind) {
  const url = STORE_URLS[kind] || STORE_URLS.chrome;
  if (storeWin && !storeWin.isDestroyed()) {
    storeWin.loadURL(url).catch(() => {});
    storeWin.focus();
    return;
  }
  storeWin = new BrowserWindow({
    width: 1200,
    height: 800,
    parent: win,
    title: t('dialog.storeWinTitle'),
    webPreferences: { partition: 'persist:store-browser', sandbox: true, contextIsolation: true },
  });
  storeWin.webContents.setUserAgent(chromeUserAgent());
  storeWin.loadURL(url).catch(() => {});
  storeWin.on('closed', () => { storeWin = null; });
}

async function installCurrentStorePage() {
  const parent = storeWin && !storeWin.isDestroyed() ? storeWin : win;
  const url = storeWin && !storeWin.isDestroyed() ? storeWin.webContents.getURL() : '';
  const parsed = parseStoreInput(url);
  if (!parsed) {
    dialog.showMessageBox(parent, {
      type: 'info',
      message: t('dialog.noStorePage'),
      detail: t('dialog.noStorePageDetail'),
    });
    return;
  }
  const res = await installById(parsed);
  dialog.showMessageBox(parent, res.error
    ? { type: 'error', message: t('dialog.installFailed'), detail: res.error }
    : { type: 'info', message: t('dialog.installOk'), detail: t('dialog.installOkDetail') });
}

/* ---------- IPC: Erweiterungen ---------- */

ipcMain.handle('ext:list', () => extView());

ipcMain.handle('ext:install', (_e, input, fallbackStore) => {
  const parsed = parseStoreInput(input, fallbackStore);
  if (!parsed) return { extensions: extView(), error: t('err.noStoreInput') };
  return installById(parsed);
});

ipcMain.handle('ext:open-store', (_e, kind) => openStore(kind));

ipcMain.handle('ext:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t('dialog.pickExtFolder'),
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { extensions: extView() };
  const dir = filePaths[0];
  if (extensions.some((e) => e.path === dir)) return { extensions: extView(), error: t('err.extAlreadyLoaded') };
  let info;
  try {
    info = readManifest(dir);
  } catch {
    return { extensions: extView(), error: t('err.noManifest') };
  }
  await registerExtension({ path: dir, ...info });
  return { extensions: extView() };
});

function removeExtension(dir, deletedAt = Date.now()) {
  const gone = extensions.find((e) => e.path === dir);
  if (gone && gone.id) deletedExt[gone.id] = deletedAt;
  extensions = extensions.filter((e) => e.path !== dir);
  saveApps();
  const done = new Set();
  for (const [id, view] of views) {
    if (view.webContents.isDestroyed()) continue;
    const partition = partitionOf(findApp(id));
    const loaded = loadedExt.get(partition);
    const extId = loaded?.get(dir);
    if (extId && !done.has(partition)) {
      try { extLoader(view.webContents.session).removeExtension(extId); } catch { /* egal */ }
      loaded.delete(dir);
      done.add(partition);
    }
    if (done.has(partition)) view.webContents.reload();
  }
  removeInstalled(dir);   // löscht nur Ordner, die der Store-Installer angelegt hat
  send('ext:changed', extView());
  return extView();
}

ipcMain.handle('ext:remove', (_e, dir) => removeExtension(dir));

/* ---------- Abgleich über einen Ordner ---------- */

let syncing = false;
let syncAgain = false;
let syncTimer = null;
let watcher = null;
let lastWrittenKey = '';
let lastSyncAt = 0;
let syncDevices = [];
let syncError = null;
const failedExt = new Set();

const syncEnabled = () => Boolean(syncCfg.folder && syncCfg.deviceId);

function syncStatus() {
  return {
    enabled: syncEnabled(),
    folder: syncCfg.folder,
    deviceName: os.hostname(),
    lastSync: lastSyncAt,
    devices: syncDevices,
    error: syncError,
  };
}

const pushSyncStatus = () => send('sync:status', syncStatus());

function scheduleSync(delay = 2000) {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), delay);
}

function setupWatcher() {
  if (watcher) { try { watcher.close(); } catch { /* egal */ } }
  watcher = null;
  if (!syncEnabled()) return;
  try {
    watcher = fs.watch(syncCfg.folder, (_event, filename) => {
      if (filename && String(filename).startsWith(sync.FILE_PREFIX) && !String(filename).includes(syncCfg.deviceId)) {
        scheduleSync(1500);
      }
    });
    watcher.on('error', () => {});
  } catch { /* Der 5-Minuten-Takt übernimmt */ }
}

function localSyncState() {
  return { apps, orderAt, settings, extensions, deletedApps, deletedExt };
}

const comparable = (a) => ({
  name: a.name,
  url: a.url,
  group: a.group || '',
  ignoreCerts: a.ignoreCerts === true,
  muted: a.muted === true,
  ownSession: a.ownSession !== false,
  keepAlive: a.keepAlive === true,
  protect: a.protect === true,
  perms: a.perms || {},
  zoom: a.zoom || 0,
});

// Übernimmt Änderungen einer anderen App-Instanz in den laufenden Zustand. Gibt zurück, ob sich etwas geändert hat.
function applyAppFields(cur, incoming) {
  const before = comparable(cur);
  const after = comparable(incoming);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    const stampChanged = cur.updatedAt !== incoming.updatedAt;
    cur.updatedAt = incoming.updatedAt;
    return stampChanged;
  }
  const sessionChanged = before.ownSession !== after.ownSession;
  if (sessionChanged) destroyView(cur.id);   // wird mit der neuen Sitzung neu erzeugt
  Object.assign(cur, after, { updatedAt: incoming.updatedAt });
  if (before.url !== after.url && !sessionChanged) {
    cur.favicon = null;
    cur.faviconSrc = null;
    dropFaviconCache(cur.id);
    views.get(cur.id)?.webContents.loadURL(cur.url).catch(() => {});
    fallbackIcon(cur.id);
  }
  if (before.muted !== after.muted) views.get(cur.id)?.webContents.setAudioMuted(after.muted);
  if (sessionChanged && activeId === cur.id) activate(cur.id);
  return true;
}

async function applyExtensionsFromSync(merged) {
  const wanted = merged.extensions.filter((e) => e.id);
  const wantedIds = new Set(wanted.map((e) => e.id));
  let changed = false;

  // Auf einem anderen Gerät entfernt
  for (const e of [...extensions]) {
    if (e.id && !wantedIds.has(e.id)) { removeExtension(e.path, merged.deletedExt[e.id]); changed = true; }
  }

  // Auf einem anderen Gerät installiert: nur nach Rückfrage, denn das lädt fremden Code
  const have = new Set(extensions.filter((e) => e.id).map((e) => e.id));
  const toInstall = wanted.filter((e) => !have.has(e.id) && !skippedExt.includes(e.id) && !failedExt.has(e.id));
  if (!toInstall.length || !win) return changed;

  const list = toInstall.map((e) => `• ${e.name} (${e.store === 'edge' ? 'Edge Add-ons' : 'Chrome Web Store'})`).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('ext.install'), t('dialog.syncSkip')],
    defaultId: 1,
    cancelId: 1,
    message: toInstall.length === 1 ? t('dialog.syncInstallMessage1') : t('dialog.syncInstallMessageN', { count: toInstall.length }),
    detail: t('dialog.syncInstallDetail', { list }),
  });
  if (response !== 0) {
    skippedExt.push(...toInstall.map((e) => e.id));
    saveApps();
    return changed;
  }
  for (const e of toInstall) {
    const res = await installById({ id: e.id, store: e.store });
    if (res.error) failedExt.add(e.id);
    else changed = true;
  }
  return changed;
}

async function applyMerged(merged) {
  let changed = false;

  const keep = new Set(merged.apps.map((a) => a.id));
  for (const a of [...apps]) {
    if (!keep.has(a.id)) {
      await removeApp(a.id, merged.deletedApps[a.id]);
      changed = true;
    }
  }

  for (const incoming of merged.apps) {
    const cur = findApp(incoming.id);
    if (!cur) {
      apps.push({ ...incoming });
      fallbackIcon(incoming.id);
      changed = true;
    } else if (applyAppFields(cur, incoming)) {
      changed = true;
    }
  }

  const position = new Map(merged.apps.map((a, i) => [a.id, i]));
  const before = apps.map((a) => a.id).join();
  apps.sort((a, b) => (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9));
  if (apps.map((a) => a.id).join() !== before) changed = true;
  if (orderAt !== merged.orderAt) { orderAt = merged.orderAt; changed = true; }

  if (settings.hibernateMinutes !== merged.settings.hibernateMinutes
      || settings.updatedAt !== merged.settings.updatedAt) {
    settings = { ...merged.settings };
    changed = true;
  }

  if (JSON.stringify(deletedApps) !== JSON.stringify(merged.deletedApps)
      || JSON.stringify(deletedExt) !== JSON.stringify(merged.deletedExt)) {
    deletedApps = merged.deletedApps;
    deletedExt = merged.deletedExt;
    changed = true;
  }

  if (await applyExtensionsFromSync(merged)) changed = true;

  if (changed) {
    saveApps();
    send('apps:changed', publicState());
    if (!activeId && apps.length) activate(apps[0].id);
  }
}

function writeOwnSnapshot() {
  if (!storeWritable) return;   // keinen (leeren) Stand in den Sync-Ordner schreiben
  const snapshot = sync.buildSnapshot(localSyncState(), {
    deviceId: syncCfg.deviceId,
    deviceName: os.hostname(),
  });
  const key = sync.contentKey(snapshot);
  if (key === lastWrittenKey && fs.existsSync(sync.fileFor(syncCfg.folder, syncCfg.deviceId))) return;
  sync.writeSnapshot(syncCfg.folder, snapshot);
  lastWrittenKey = key;
}

async function runSync() {
  if (!syncEnabled()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    if (!fs.existsSync(syncCfg.folder)) throw new Error(t('err.syncFolderMissing'));
    const remotes = sync.readRemotes(syncCfg.folder, syncCfg.deviceId, normalizeUrl);
    await applyMerged(sync.merge(localSyncState(), remotes));
    writeOwnSnapshot();
    syncDevices = remotes.map((r) => ({ name: r.deviceName, writtenAt: r.writtenAt }));
    syncError = null;
    lastSyncAt = Date.now();
  } catch (err) {
    syncError = err.code === 'EACCES' || err.code === 'EPERM'
      ? 'Keine Schreibrechte im Sync-Ordner.'
      : `Abgleich fehlgeschlagen: ${err.message}`;
  } finally {
    syncing = false;
    pushSyncStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}

ipcMain.handle('sync:status', () => syncStatus());

ipcMain.handle('sync:choose', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t('dialog.pickSyncFolder'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return syncStatus();
  syncCfg = { folder: filePaths[0], deviceId: syncCfg.deviceId || crypto.randomUUID() };
  const now = Date.now();
  for (const a of apps) if (!a.updatedAt) a.updatedAt = now;
  for (const e of extensions) if (e.id && !e.updatedAt) e.updatedAt = now;
  lastWrittenKey = '';
  saveApps();
  setupWatcher();
  await runSync();
  return syncStatus();
});

ipcMain.handle('sync:now', async () => {
  await runSync();
  return syncStatus();
});

ipcMain.handle('sync:disable', () => {
  syncCfg = { folder: null, deviceId: syncCfg.deviceId };
  setupWatcher();
  syncDevices = [];
  syncError = null;
  saveApps();
  return syncStatus();
});
