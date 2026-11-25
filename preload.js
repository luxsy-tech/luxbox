const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Fehler in diesem Skript duerfen die Oberflaeche nicht unbenutzbar machen:
// 1) window.api wird zuerst exponiert (die App bleibt bedienbar),
// 2) alles andere laeuft in eigenen try/catch-Bloecken,
// 3) Fehler landen in _diag.log im App-Ordner.
const diag = (msg) => {
  try {
    require('fs').appendFileSync(
      require('path').join(__dirname, '_diag.log'),
      new Date().toISOString() + ' [preload] ' + msg + '\n'
    );
  } catch {}
};

const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Farbschema aus den Startargumenten (--luxbox-theme=...), Wechsel laeuft ueber 'ui:theme'
let themeName = 'lila';
const themeArg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--luxbox-theme='));
if (themeArg) themeName = themeArg.slice('--luxbox-theme='.length);
on('ui:theme', (name) => { if (typeof name === 'string') themeName = name; });

// Position der App-Leiste aus den Startargumenten (--luxbox-rail=...), Wechsel laeuft ueber 'ui:rail'
let railPos = 'left';
const railArg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--luxbox-rail='));
if (railArg) railPos = railArg.slice('--luxbox-rail='.length);
on('ui:rail', (pos) => { if (typeof pos === 'string') railPos = pos; });

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('apps:list'),
  add: (data) => ipcRenderer.invoke('apps:add', data),
  update: (id, data) => ipcRenderer.invoke('apps:update', id, data),
  remove: (id) => ipcRenderer.invoke('apps:remove', id),
  activate: (id) => ipcRenderer.invoke('apps:activate', id),
  reload: (id) => ipcRenderer.invoke('apps:reload', id),
  reorder: (ids) => ipcRenderer.invoke('apps:reorder', ids),
  contextMenu: (id) => ipcRenderer.invoke('apps:context-menu', id),
  listExtensions: () => ipcRenderer.invoke('ext:list'),
  addExtension: () => ipcRenderer.invoke('ext:add'),
  removeExtension: (dir) => ipcRenderer.invoke('ext:remove', dir),
  installExtension: (input, store) => ipcRenderer.invoke('ext:install', input, store),
  openStore: (kind) => ipcRenderer.invoke('ext:open-store', kind),
  onExtensionsChanged: (cb) => on('ext:changed', cb),
  onOpenExtensions: (cb) => on('ui:open-extensions', cb),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncChoose: () => ipcRenderer.invoke('sync:choose'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncDisable: () => ipcRenderer.invoke('sync:disable'),
  onSyncStatus: (cb) => on('sync:status', cb),
  onOpenSync: (cb) => on('ui:open-sync', cb),
  onExtensionsLoaded: (cb) => on('ext:loaded', cb),
  setOverlay: (open) => ipcRenderer.invoke('ui:overlay', open),
  captureWindow: () => ipcRenderer.invoke('ui:capture'),
  menuClick: (id, value, where) => ipcRenderer.invoke('menu:click', id, value, where),
  menuState: () => ipcRenderer.invoke('menu:state'),
  onContextMenu: (cb) => on('ui:context-menu', cb),
  // Suchleiste (Strg+F): findInPage der aktiven App-Ansicht steuern
  findPage: (term, opts) => ipcRenderer.invoke('find:page', term, opts),
  findStop: () => ipcRenderer.invoke('find:stop'),
  onOpenFind: (cb) => on('ui:open-find', cb),
  onFindResult: (cb) => on('ui:find-result', cb),
  onFindClose: (cb) => on('ui:find-close', cb),
  setBadge: (dataUrl, desc) => ipcRenderer.invoke('ui:badge', dataUrl, desc),
  dropToApp: (id, files) => ipcRenderer.invoke('apps:drop', id, files),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  lockState: () => ipcRenderer.invoke('lock:state'),
  lockSet: (pin) => ipcRenderer.invoke('lock:set', pin),
  lockClear: () => ipcRenderer.invoke('lock:clear'),
  lockCheck: (pin) => ipcRenderer.invoke('lock:check', pin),
  lockNow: () => ipcRenderer.invoke('lock:now'),
  lockAuto: (minutes) => ipcRenderer.invoke('lock:auto', minutes),
  onLocked: (cb) => on('ui:locked', cb),
  onOpenKeys: (cb) => on('ui:open-keys', cb),
  onOpenPin: (cb) => on('ui:open-pin', cb),
  permsGet: (id) => ipcRenderer.invoke('perms:get', id),
  permsSet: (id, perms) => ipcRenderer.invoke('perms:set', id, perms),
  mixerList: () => ipcRenderer.invoke('mixer:list'),
  setMute: (id, muted) => ipcRenderer.invoke('mixer:mute', id, muted),
  muteAll: (muted) => ipcRenderer.invoke('mixer:all', muted),
  helloState: () => ipcRenderer.invoke('lock:hello-state'),
  helloToggle: () => ipcRenderer.invoke('lock:hello-toggle'),
  helloUnlock: () => ipcRenderer.invoke('lock:hello-unlock'),
  tourDone: () => ipcRenderer.invoke('tour:done'),
  authVerify: (pin) => ipcRenderer.invoke('auth:verify', pin),
  authHello: () => ipcRenderer.invoke('auth:hello'),
  appUnprotect: (id) => ipcRenderer.invoke('app:unprotect', id),
  onAuth: (cb) => on('ui:auth', cb),
  onOpenInfo: (cb) => on('ui:open-info', cb),
  openUserData: () => ipcRenderer.invoke('app:open-userdata'),
  appUnlock: (id, pin) => ipcRenderer.invoke('app:unlock', id, pin),
  appHelloUnlock: (id) => ipcRenderer.invoke('app:hello-unlock', id),
  onAppLock: (cb) => on('app:lock', cb),
  onTour: (cb) => on('ui:tour', cb),
  onOpenMixer: (cb) => on('ui:open-mixer', cb),
  onOpenPerms: (cb) => on('ui:open-perms', cb),

  onState: (cb) => on('app:state', cb),
  onActive: (cb) => on('app:active', cb),
  onChanged: (cb) => on('apps:changed', cb),
  onEditRequest: (cb) => on('app:edit-request', cb),
  getTheme: () => themeName,
  onTheme: (cb) => on('ui:theme', cb),
  getRail: () => railPos,
  onRail: (cb) => on('ui:rail', cb),
});

// Sprache (optional): scheitert das Laden, zeigt der Renderer seine statischen Texte
try {
  const i18n = require('./i18n.js');
  const langArg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--luxbox-locale='));
  if (langArg) i18n.setLocale(langArg.slice('--luxbox-locale='.length));  if (i18n.isReady()) {
    contextBridge.exposeInMainWorld('i18n', {
      locale: i18n.getLocale(),
      t: (key, vars) => i18n.t(key, vars),
    });
  } else {
    diag('Sprachdateien nicht lesbar, Oberflaeche zeigt die Standardsprache');
  }
} catch (err) {
  diag('i18n fehlgeschlagen: ' + ((err && err.stack) || err));
}

// Fuegt das Element <browser-action-list> ein (Symbole und Popups der Erweiterungen)
try {
  let lastError = null;
  for (const mod of ['electron-chrome-extensions/browser-action', 'electron-chrome-extensions/dist/browser-action']) {
    try {
      require(mod).injectBrowserAction();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) diag('browser-action nicht geladen: ' + lastError.message);
} catch (err) {
  diag('browser-action fehlgeschlagen: ' + ((err && err.stack) || err));
}
