// Sprachfunktionen (window.i18n kommt aus dem Preload)
const t = (key, vars) => (window.i18n ? window.i18n.t(key, vars) : key);
// Datumsformat folgt der gewaehlten Sprache
const LOCALE_TAGS = { de: 'de-DE', en: 'en-US', es: 'es-ES' };
const dt = (ms) => new Date(ms).toLocaleString(LOCALE_TAGS[(window.i18n && window.i18n.locale) || 'de'] || 'de-DE');

// Farbschema anwenden: data-theme am <html> schaltet die CSS-Variablen in styles.css um
const THEMES = ['lila', 'original', 'blau', 'matrix'];
function applyTheme(name) {
  document.documentElement.dataset.theme = THEMES.includes(name) ? name : 'lila';
}
applyTheme(window.api && window.api.getTheme ? window.api.getTheme() : 'lila');
if (window.api && window.api.onTheme) window.api.onTheme(applyTheme);

// Position der App-Leiste: data-rail am <html> ordnet die Leiste in styles.css an
const RAIL_POSITIONS = ['left', 'right', 'top', 'bottom'];
function applyRail(pos) {
  document.documentElement.dataset.rail = RAIL_POSITIONS.includes(pos) ? pos : 'left';
}
applyRail(window.api && window.api.getRail ? window.api.getRail() : 'left');
if (window.api && window.api.onRail) window.api.onRail(applyRail);

// Statische Texte im Dokument übersetzen (data-i18n, data-i18n-html, data-i18n-attr)
function applyI18n() {
  if (!window.i18n) return;
  document.documentElement.lang = window.i18n.locale;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    });
  });
}
applyI18n();

const PRESETS = [
  { label: t('preset.custom'), name: '', url: '' },
  { label: 'WhatsApp', name: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { label: 'Telegram', name: 'Telegram', url: 'https://web.telegram.org/k/' },
  { label: 'Slack', name: 'Slack', url: 'https://app.slack.com/client' },
  { label: 'Discord', name: 'Discord', url: 'https://discord.com/app' },
  { label: 'Microsoft Teams', name: 'Teams', url: 'https://teams.microsoft.com' },
  { label: 'Gmail', name: 'Gmail', url: 'https://mail.google.com' },
  { label: 'Outlook', name: 'Outlook', url: 'https://outlook.office.com/mail' },
];

const $ = (id) => document.getElementById(id);
const listEl = $('apps');
const dlg = $('dlg');

let apps = [];
let activeId = null;
let activeTabId = null;
let activePartition = null;
let extensionCount = 0;
let editingId = null;
let editingProtect = false;
let dragId = null;

/* ---------- Rendering ---------- */

// Buttons werden wiederverwendet, solange sich ihr Zustand nicht geaendert hat:
// sonst wuerde jeder Statuswechsel alle Symbole neu aufbauen (inkl. Favicon-Bild)
const buttons = new Map();      // appId -> Button-Element
const buttonSigs = new Map();   // appId -> Zustand des Buttons

const buttonSig = (a) => JSON.stringify([
  a.name, a.favicon || '', a.badge, Boolean(a.loading), Boolean(a.muted), Boolean(a.hibernated), Boolean(a.locked), a.id === activeId,
]);

function buildButton(a) {
  const btn = document.createElement('button');
  btn.className = 'app';
  btn.dataset.id = a.id;
  btn.title = a.name;
  btn.setAttribute('aria-label', a.name);
  btn.draggable = true;
  if (a.id === activeId) btn.classList.add('active');
  if (a.loading) btn.classList.add('loading');
  if (a.muted) btn.classList.add('muted');

  if (a.favicon) {
    const img = document.createElement('img');
    img.src = a.favicon;
    img.alt = '';
    img.onerror = () => { img.remove(); btn.prepend(document.createTextNode(initial(a.name))); };
    btn.append(img);
  } else {
    btn.append(document.createTextNode(initial(a.name)));
  }

  if (a.badge > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = a.badge > 99 ? '99+' : String(a.badge);
    btn.append(badge);
  }

  btn.addEventListener('click', () => window.api.activate(a.id));
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); window.api.contextMenu(a.id); });

  btn.addEventListener('dragstart', () => { dragId = a.id; btn.classList.add('dragging'); });
  btn.addEventListener('dragend', () => { dragId = null; btn.classList.remove('dragging'); });
  btn.addEventListener('dragover', (e) => e.preventDefault());
  btn.addEventListener('drop', (e) => { e.preventDefault(); moveApp(dragId, a.id); });
  if (a.hibernated) {
    btn.classList.add('hibernated');
    btn.title = t('app.hibernated', { name: a.name });
  }
  if (a.locked) {
    const lock = document.createElement('span');
    lock.className = 'lock-badge';
    lock.textContent = '🔒';
    btn.append(lock);
  }
  buttons.set(a.id, btn);
  buttonSigs.set(a.id, buttonSig(a));
  return btn;
}

function render() {
  const nodes = [];
  const seen = new Set();
  const doneGroups = new Set();
  for (const a of apps) {
    if (a.group) {
      // Gruppen-Apps stecken in ihrem Ordner-Symbol
      if (!doneGroups.has(a.group)) {
        doneGroups.add(a.group);
        nodes.push(buildGroupButton(a.group));
      }
      continue;
    }
    seen.add(a.id);
    let btn = buttons.get(a.id);
    if (!btn || buttonSigs.get(a.id) !== buttonSig(a)) btn = buildButton(a);
    nodes.push(btn);
  }
  for (const id of [...buttons.keys()]) {
    if (seen.has(id)) continue;
    buttons.delete(id);
    buttonSigs.delete(id);
  }
  listEl.replaceChildren(...nodes);
  $('empty').hidden = apps.length > 0;
  updateTaskbarBadge();
}

// Nur das betroffene Symbol neu aufbauen, nicht die ganze Leiste
function patchApp(a) {
  const old = buttons.get(a.id);
  if (old) old.replaceWith(buildButton(a));
  else render();
  updateTaskbarBadge();
}

/* ---------- Taskleisten-Badge (Windows) ---------- */

// Unread-Summe aller Apps als gezeichnetes Abzeichen aufs Taskleisten-Icon
function updateTaskbarBadge() {
  if (!window.api.setBadge) return;
  const total = apps.reduce((s, a) => s + (a.badge || 0), 0);
  if (!total) { window.api.setBadge(null, ''); return; }
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  ctx.fillStyle = cs.getPropertyValue('--badge').trim() || '#f2a541';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cs.getPropertyValue('--badge-text').trim() || '#241503';
  ctx.font = `700 ${total > 99 ? 32 : 40}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total > 99 ? '99+' : String(total), size / 2, size / 2 + 2);
  window.api.setBadge(c.toDataURL(), String(total));
}

/* ---------- Gruppen-Ordner in der Leiste ---------- */

let groupFlyout = null;

function groupIcon() {
  const span = document.createElement('span');
  span.className = 'group-icon';
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  return span;
}

function buildGroupButton(group) {
  const members = apps.filter((a) => a.group === group);
  const btn = document.createElement('button');
  btn.className = 'app group';
  btn.title = group;
  btn.setAttribute('aria-label', group);
  btn.append(groupIcon());
  const count = members.reduce((s, a) => s + (a.badge || 0), 0);
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = count > 99 ? '99+' : String(count);
    btn.append(badge);
  }
  // Schloss, wenn mindestens eine App im Ordner gesperrt ist
  if (members.some((a) => a.locked)) {
    const lock = document.createElement('span');
    lock.className = 'lock-badge';
    lock.textContent = '🔒';
    btn.append(lock);
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGroupFlyout(btn, group);
  });
  return btn;
}

function closeGroupFlyout() {
  if (!groupFlyout) return;
  groupFlyout.remove();
  groupFlyout = null;
  closeOverlay();
}

// Alle Aufklapp-Ebenen schliessen, bevor ein Dialog oeffnet: sonst wuerde das
// Schliessen die App-Ansicht wieder anhaengen und den Dialog verdecken
function closeAllPopups() {
  closeMenu();
  closeGroupFlyout();
}

async function toggleGroupFlyout(btn, group) {
  if (groupFlyout) { closeGroupFlyout(); return; }
  closeMenu();
  if (!(await openOverlay())) return;
  const panel = document.createElement('div');
  panel.className = 'menu-panel group-panel';
  for (const a of apps.filter((x) => x.group === group)) {
    const row = document.createElement('button');
    row.className = 'group-row';
    if (a.id === activeId) row.classList.add('active');
    const icon = document.createElement('span');
    icon.className = 'group-row-icon';
    if (a.favicon) {
      const img = document.createElement('img');
      img.src = a.favicon;
      img.alt = '';
      icon.append(img);
    } else {
      icon.textContent = initial(a.name);
    }
    const name = document.createElement('span');
    name.textContent = a.name;
    row.append(icon, name);
    if (a.badge > 0) {
      const mark = document.createElement('span');
      mark.className = 'group-row-badge';
      mark.textContent = a.badge > 99 ? '99+' : String(a.badge);
      row.append(mark);
    }
    if (a.locked) {
      const lock = document.createElement('span');
      lock.className = 'lock-badge';
      lock.textContent = '🔒';
      row.append(lock);
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeGroupFlyout();
      window.api.activate(a.id);
    });
    // Rechtsklick wie auf einem App-Symbol: eigenes Menue mit Bearbeiten & Co.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.api.contextMenu(a.id);
    });
    panel.append(row);
  }
  document.body.append(panel);
  // Seitlich vom Ordner oeffnen, je nach Leistenposition
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const side = document.documentElement.dataset.rail || 'left';
  let left = r.right + 8;
  let top = r.top;
  if (side === 'right') left = r.left - w - 8;
  if (side === 'top') { left = r.left; top = r.bottom + 8; }
  if (side === 'bottom') { left = r.left; top = r.top - h - 8; }
  panel.style.left = `${Math.max(4, Math.min(left, window.innerWidth - w - 8))}px`;
  panel.style.top = `${Math.max(4, Math.min(top, window.innerHeight - h - 8))}px`;
  groupFlyout = panel;
}

/* ---------- Dateien auf App-Symbole ziehen ---------- */

const appButtonOf = (e) => (e.target && e.target.closest ? e.target.closest('.app') : null);

listEl.addEventListener('dragover', (e) => {
  const btn = appButtonOf(e);
  if (!btn || !btn.dataset.id || !e.dataTransfer) return;
  if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  btn.classList.add('dragover');
});
listEl.addEventListener('dragleave', (e) => {
  const btn = appButtonOf(e);
  if (btn) btn.classList.remove('dragover');
});
listEl.addEventListener('drop', (e) => {
  const btn = appButtonOf(e);
  if (!btn) return;
  e.preventDefault();
  btn.classList.remove('dragover');
  if (!btn.dataset.id || !window.api.getPathForFile) return;
  const files = Array.from(e.dataTransfer.files || [])
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean);
  if (files.length) window.api.dropToApp(btn.dataset.id, files);
});

const initial = (name) => (name.trim()[0] || '?').toUpperCase();

let actionsEl = $('actions');

// Zeigt die Erweiterungs-Symbole der aktiven App unten links
function updateActions() {
  if (!extensionCount || !activeId || activeTabId == null || !activePartition) {
    actionsEl.hidden = true;
    return;
  }
  actionsEl.setAttribute('partition', activePartition);
  actionsEl.setAttribute('tab', String(activeTabId));
  actionsEl.hidden = false;
}

// Erzeugt die Symbolleiste neu, damit sie die Erweiterungen der Sitzung frisch abfragt
function refreshActions() {
  const fresh = document.createElement('browser-action-list');
  fresh.id = 'actions';
  fresh.setAttribute('alignment', 'top right');
  fresh.hidden = true;
  actionsEl.replaceWith(fresh);
  actionsEl = fresh;
  updateActions();
}

function applyState(state) {
  apps = state.apps;
  activeId = state.activeId;
  activeTabId = state.activeTabId ?? activeTabId;
  extensionCount = state.extensionCount ?? extensionCount;
  activePartition = apps.find((a) => a.id === activeId)?.partition ?? null;
  render();
  updateActions();
}

async function moveApp(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const ids = apps.map((a) => a.id);
  ids.splice(ids.indexOf(fromId), 1);
  ids.splice(ids.indexOf(toId), 0, fromId);
  applyState(await window.api.reorder(ids));
}

/* ---------- Dialog ---------- */

function openDialog(app) {
  closeAllPopups();
  editingId = app ? app.id : null;
  editingProtect = app ? app.protect === true : false;
  $('dlgTitle').textContent = app ? t('dlg.titleEdit') : t('dlg.titleAdd');
  $('presetField').hidden = Boolean(app);
  $('name').value = app ? app.name : '';
  $('url').value = app ? app.url : '';
  $('ignore').checked = app ? app.ignoreCerts === true : false;
  $('own').checked = app ? app.ownSession !== false : false;
  $('keep').checked = app ? app.keepAlive === true : false;
  $('preset').value = '0';
  // Gruppen-Vorschlaege aus den vorhandenen Apps anbieten
  const dl = $('groupList');
  dl.replaceChildren();
  for (const g of [...new Set(apps.map((a) => a.group).filter(Boolean))]) {
    const opt = document.createElement('option');
    opt.value = g;
    dl.append(opt);
  }
  $('group').value = app ? (app.group || '') : '';
  $('protect').checked = app ? app.protect === true : false;
  $('lockAfter').value = String(app && Number.isFinite(Number(app.lockAfter)) ? app.lockAfter : 0);
  $('lockAfter').disabled = !$('protect').checked;
  $('error').textContent = '';
  window.api.setOverlay(true);   // native Ansicht ausblenden, sonst verdeckt sie den Dialog
  dlg.showModal();
  $('name').focus();
}

dlg.addEventListener('close', () => window.api.setOverlay(false));

PRESETS.forEach((p, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = p.label;
  $('preset').append(opt);
});

$('preset').addEventListener('change', () => {
  const p = PRESETS[Number($('preset').value)];
  $('name').value = p.name;
  $('url').value = p.url;
});

$('add').addEventListener('click', () => openDialog(null));
$('cancel').addEventListener('click', () => dlg.close());
$('protect').addEventListener('change', () => {
  $('lockAfter').disabled = !$('protect').checked;
});

async function performSave() {
  const data = {
    name: $('name').value, url: $('url').value, group: $('group').value, ignoreCerts: $('ignore').checked, ownSession: $('own').checked, keepAlive: $('keep').checked,
    protect: $('protect').checked,
    lockAfter: Number($('lockAfter').value),
  };
  try {
    const state = editingId
      ? await window.api.update(editingId, data)
      : await window.api.add(data);
    applyState(state);
    dlg.close();
  } catch (err) {
    $('error').textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

$('save').addEventListener('click', () => {
  // Schutz entfernen? Dann erst die Identität bestätigen lassen
  if (editingId && editingProtect && !$('protect').checked) {
    openAuthDialog(t('auth.reasonUnprotect'), performSave);
    return;
  }
  performSave();
});

dlg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') $('save').click();
});

/* ---------- Events aus dem Hauptprozess ---------- */

window.api.onState((s) => {
  const a = apps.find((x) => x.id === s.id);
  if (!a) return;
  Object.assign(a, s);
  patchApp(a);
});
window.api.onActive((p) => {
  activeId = p ? p.id : null;
  activeTabId = p ? p.tabId : null;
  activePartition = p ? p.partition : null;
  hideAppLock();
  render();
  updateActions();
});
window.api.onChanged(applyState);
window.api.onEditRequest((id) => {
  const a = apps.find((x) => x.id === id);
  if (a) openDialog(a);
});

window.api.list().then(applyState);

/* ---------- Erweiterungen ---------- */

const extDlg = $('extDlg');

function renderExtensions(list) {
  extensionCount = list.length;
  updateActions();
  const ul = $('extList');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = t('ext.none');
    ul.append(li);
    return;
  }
  for (const ext of list) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('strong');
    name.textContent = ext.version ? `${ext.name} ${ext.version}` : ext.name;
    const where = document.createElement('span');
    where.textContent = ext.store ? `${ext.store === 'edge' ? 'Edge Add-ons' : 'Chrome Web Store'} · ${ext.id}` : ext.path;
    const status = document.createElement('span');
    status.className = ext.error ? 'status bad' : 'status';
    status.textContent = ext.error
      ? t('ext.notLoaded', { error: ext.error })
      : (ext.loaded ? t('ext.active') : t('ext.pending'));
    meta.append(name, where, status);
    const del = document.createElement('button');
    del.textContent = t('ext.remove');
    del.addEventListener('click', async () => renderExtensions(await window.api.removeExtension(ext.path)));
    li.append(meta, del);
    ul.append(li);
  }
}

async function openExtDialog() {
  closeAllPopups();
  $('extError').textContent = '';
  renderExtensions(await window.api.listExtensions());
  if (!extDlg.open) {
    window.api.setOverlay(true);
    extDlg.showModal();
  }
}

$('extBtn').addEventListener('click', openExtDialog);
window.api.onOpenExtensions(openExtDialog);
window.api.onExtensionsLoaded(({ partition }) => { if (partition === activePartition) refreshActions(); });
window.api.onExtensionsChanged(renderExtensions);

$('extClose').addEventListener('click', () => extDlg.close());
extDlg.addEventListener('close', () => window.api.setOverlay(false));

$('extFolder').addEventListener('click', async () => {
  const res = await window.api.addExtension();
  $('extError').textContent = res.error || '';
  renderExtensions(res.extensions);
});

async function installFromInput() {
  const input = $('storeInput').value.trim();
  if (!input) return;
  const btn = $('storeInstall');
  btn.disabled = true;
  btn.textContent = t('ext.loading');
  $('extError').textContent = '';
  try {
    const res = await window.api.installExtension(input, $('storeKind').value);
    $('extError').textContent = res.error || '';
    if (!res.error) $('storeInput').value = '';
    renderExtensions(res.extensions);
  } finally {
    btn.disabled = false;
    btn.textContent = t('ext.install');
  }
}
$('storeInstall').addEventListener('click', installFromInput);
$('storeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') installFromInput(); });
$('openChrome').addEventListener('click', () => window.api.openStore('chrome'));
$('openEdge').addEventListener('click', () => window.api.openStore('edge'));

/* ---------- Config-Sync ---------- */

const syncDlg = $('syncDlg');

function line(parent, text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  parent.append(div);
  return div;
}

function renderSync(st) {
  const box = $('syncStatus');
  box.replaceChildren();
  $('syncError').textContent = st.error || '';
  $('syncOff').hidden = !st.enabled;
  $('syncNow').hidden = !st.enabled;

  if (!st.enabled) {
    line(box, t('sync.notConfigured'), 'muted');
    return;
  }
  line(box, t('sync.folderLine', { folder: st.folder }));
  line(box, t('sync.thisDevice', { name: st.deviceName }));
  line(box, st.lastSync ? t('sync.last', { time: dt(st.lastSync) }) : t('sync.never'), 'muted');
  if (st.devices.length) {
    line(box, t('sync.otherDevices'), 'muted');
    const ul = document.createElement('ul');
    for (const d of st.devices) {
      const li = document.createElement('li');
      li.textContent = d.writtenAt ? t('sync.deviceEntry', { name: d.name, time: dt(d.writtenAt) }) : d.name;
      ul.append(li);
    }
    box.append(ul);
  } else {
    line(box, t('sync.noOthers'), 'muted');
  }
}

async function openSyncDialog() {
  closeAllPopups();
  renderSync(await window.api.syncStatus());
  if (!syncDlg.open) {
    window.api.setOverlay(true);
    syncDlg.showModal();
  }
}

$('syncBtn').addEventListener('click', openSyncDialog);
window.api.onOpenSync(openSyncDialog);
window.api.onSyncStatus((st) => { if (syncDlg.open) renderSync(st); });
syncDlg.addEventListener('close', () => window.api.setOverlay(false));
$('syncClose').addEventListener('click', () => syncDlg.close());
$('syncChoose').addEventListener('click', async () => renderSync(await window.api.syncChoose()));
$('syncNow').addEventListener('click', async () => renderSync(await window.api.syncNow()));
$('syncOff').addEventListener('click', async () => renderSync(await window.api.syncDisable()));

/* ---------- Menueleiste ---------- */
// Eigene Menueleiste in den Farben des Farbschemas. Das native Menue bleibt
// unsichtbar und haelt nur die Tastenkuerzel (siehe main.js / buildMenu).

const MENUS = [
  {
    labelKey: 'menu.settings',
    items: [
      { id: 'autostart', labelKey: 'menu.autostart', check: 'autostart' },
      { id: 'sync', labelKey: 'menu.sync' },
      {
        labelKey: 'menu.hibernate',
        items: [
          { id: 'hibernate', labelKey: 'menu.hibernateNever', radio: 'hibernate', value: 0 },
          { id: 'hibernate', labelKey: 'menu.hibernateMinutes', vars: { n: 5 }, radio: 'hibernate', value: 5 },
          { id: 'hibernate', labelKey: 'menu.hibernateMinutes', vars: { n: 15 }, radio: 'hibernate', value: 15 },
          { id: 'hibernate', labelKey: 'menu.hibernateMinutes', vars: { n: 30 }, radio: 'hibernate', value: 30 },
          { id: 'hibernate', labelKey: 'menu.hibernateMinutes', vars: { n: 60 }, radio: 'hibernate', value: 60 },
        ],
      },
      {
        labelKey: 'menu.language',
        items: [
          { id: 'language', text: 'Deutsch', radio: 'locale', value: 'de' },
          { id: 'language', text: 'English', radio: 'locale', value: 'en' },
          { id: 'language', text: 'Español', radio: 'locale', value: 'es' },
        ],
      },
      {
        labelKey: 'menu.design',
        items: [
          { header: true, labelKey: 'menu.theme' },
          { id: 'theme', labelKey: 'menu.themeLila', radio: 'theme', value: 'lila' },
          { id: 'theme', labelKey: 'menu.themeOriginal', radio: 'theme', value: 'original' },
          { id: 'theme', labelKey: 'menu.themeBlau', radio: 'theme', value: 'blau' },
          { id: 'theme', labelKey: 'menu.themeMatrix', radio: 'theme', value: 'matrix' },
          { sep: true },
          { header: true, labelKey: 'menu.rail' },
          { id: 'rail', labelKey: 'menu.railLeft', radio: 'rail', value: 'left' },
          { id: 'rail', labelKey: 'menu.railRight', radio: 'rail', value: 'right' },
          { id: 'rail', labelKey: 'menu.railTop', radio: 'rail', value: 'top' },
          { id: 'rail', labelKey: 'menu.railBottom', radio: 'rail', value: 'bottom' },
        ],
      },
      { sep: true },
      {
        labelKey: 'menu.lock',
        items: [
          { id: 'lockSet', labelKey: 'menu.lockSet' },
          { id: 'lockNow', labelKey: 'menu.lockNow', enableIf: 'canLock' },
          {
            labelKey: 'menu.lockAuto',
            items: [
              { id: 'lockAuto', labelKey: 'menu.lockAutoNever', radio: 'lockAuto', value: 0 },
              { id: 'lockAuto', labelKey: 'menu.oneMinute', radio: 'lockAuto', value: 1 },
              { id: 'lockAuto', labelKey: 'menu.hibernateMinutes', vars: { n: 5 }, radio: 'lockAuto', value: 5 },
              { id: 'lockAuto', labelKey: 'menu.hibernateMinutes', vars: { n: 15 }, radio: 'lockAuto', value: 15 },
            ],
          },
          { id: 'helloToggle', labelKey: 'menu.hello', check: 'hello' },
          { id: 'lockClear', labelKey: 'menu.lockClear', enableIf: 'hasPin' },
        ],
      },
      { sep: true },
      { id: 'mixer', labelKey: 'menu.mixer' },
      { id: 'keys', labelKey: 'menu.keys' },
      { id: 'tour', labelKey: 'menu.tour' },
      { id: 'info', labelKey: 'menu.info' },
      { id: 'exportConfig', labelKey: 'menu.exportConfig' },
      { id: 'importConfig', labelKey: 'menu.importConfig' },
      { sep: true },
      { id: 'quit', labelKey: 'menu.quit' },
    ],
  },
  {
    labelKey: 'menu.apps',
    items: [
      { id: 'reload', labelKey: 'menu.reload' },
      { sep: true },
      { id: 'nextApp', labelKey: 'menu.nextApp' },
      { id: 'prevApp', labelKey: 'menu.prevApp' },
      { sep: true },
      ...Array.from({ length: 9 }, (_, i) => ({ id: 'app', labelKey: 'menu.appN', vars: { n: i + 1 }, value: i })),
      { sep: true },
      {
        labelKey: 'menu.extensions',
        items: [
          { id: 'manageExtensions', labelKey: 'menu.manage' },
          { sep: true },
          { id: 'storeChrome', labelKey: 'ext.openChrome' },
          { id: 'storeEdge', labelKey: 'ext.openEdge' },
          { id: 'installStorePage', labelKey: 'menu.installStorePage' },
        ],
      },
    ],
  },
  {
    labelKey: 'menu.edit',
    items: [
      { id: 'edit', labelKey: 'menu.undo', value: 'undo' },
      { id: 'edit', labelKey: 'menu.redo', value: 'redo' },
      { sep: true },
      { id: 'edit', labelKey: 'menu.cut', value: 'cut' },
      { id: 'edit', labelKey: 'menu.copy', value: 'copy' },
      { id: 'edit', labelKey: 'menu.paste', value: 'paste' },
      { id: 'edit', labelKey: 'menu.delete', value: 'delete' },
      { id: 'edit', labelKey: 'menu.selectAll', value: 'selectAll' },
    ],
  },
  {
    labelKey: 'menu.view',
    items: [
      { id: 'zoom', labelKey: 'menu.zoomReset', value: 'reset' },
      { id: 'zoom', labelKey: 'menu.zoomIn', value: 'in' },
      { id: 'zoom', labelKey: 'menu.zoomOut', value: 'out' },
      { sep: true },
      { id: 'fullscreen', labelKey: 'menu.fullscreen' },
      { sep: true },
      { id: 'devTools', labelKey: 'menu.devTools' },
    ],
  },
];

const menubar = $('menubar');
const backdrop = $('backdrop');
let openMenu = -1;
let menuState = {};
let menuOverlay = false;
let menuSeq = 0;

// Entfernt offene Untermenues; `except` bleibt stehen (das Menue, in dem die Maus ist)
function closeFlyouts(except) {
  menubar.querySelectorAll('.menu-flyout').forEach((el) => { if (el !== except) el.remove(); });
}

// Untermenue seitlich neben dem Eintrag aufklappen (liegt als eigenes Panel in
// der Menueleiste, damit es von keinem scrollenden Panel abgeschnitten wird)
function openFlyout(row, items) {
  closeFlyouts(row.closest('.menu-flyout'));
  const fly = document.createElement('div');
  fly.className = 'menu-panel menu-flyout';
  buildItems(items, fly);
  menubar.append(fly);
  const mrect = menubar.getBoundingClientRect();
  const rrect = row.getBoundingClientRect();
  fly.style.top = `${rrect.top - mrect.top - 6}px`;
  const left = rrect.right - mrect.left + 2;
  fly.style.left = (left + fly.offsetWidth > window.innerWidth - 8)
    ? `${Math.max(4, rrect.left - mrect.left - fly.offsetWidth - 2)}px`
    : `${left}px`;
}

function buildItems(items, panel) {
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      panel.append(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = item.header ? 'menu-item menu-header' : 'menu-item';
    row.setAttribute('role', item.header ? 'presentation' : 'menuitem');
    const mark = document.createElement('span');
    mark.className = 'menu-mark';
    if (item.check) mark.textContent = menuState[item.check] ? '✓' : '';
    else if (item.radio) mark.textContent = menuState[item.radio] === item.value ? '●' : '';
    const label = document.createElement('span');
    label.textContent = item.text || t(item.labelKey, item.vars);
    row.append(mark, label);
    if (item.items) {
      const arrow = document.createElement('span');
      arrow.className = 'menu-arrow';
      arrow.textContent = '›';
      row.append(arrow);
      row.addEventListener('mouseenter', () => openFlyout(row, item.items));
      row.addEventListener('click', (e) => { e.stopPropagation(); openFlyout(row, item.items); });
    } else if (item.enabled === false || (item.enableIf && !menuState[item.enableIf])) {
      row.classList.add('menu-disabled');
    } else if (!item.header) {
      row.addEventListener('mouseenter', () => closeFlyouts(row.closest('.menu-flyout')));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        window.api.menuClick(item.id, item.value, item.where);
        closeMenu();
      });
    }
    panel.append(row);
  }
}

function buildPanel(index) {
  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.setAttribute('role', 'menu');
  buildItems(MENUS[index].items, panel);
  return panel;
}

function renderMenubar() {
  menubar.replaceChildren();
  MENUS.forEach((menu, i) => {
    const tab = document.createElement('button');
    tab.className = 'menu-tab';
    tab.type = 'button';
    tab.textContent = t(menu.labelKey);
    tab.setAttribute('role', 'menuitem');
    tab.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(i); });
    tab.addEventListener('mouseenter', () => { if (openMenu !== -1 && openMenu !== i) showMenu(i); });
    menubar.append(tab);
  });
}

function renderPanels() {
  menubar.querySelectorAll('.menu-panel').forEach((p) => p.remove());
  const tabs = menubar.querySelectorAll('.menu-tab');
  tabs.forEach((tab, i) => tab.classList.toggle('open', i === openMenu));
  if (openMenu === -1) return;
  const panel = buildPanel(openMenu);
  panel.style.left = `${tabs[openMenu].offsetLeft}px`;
  menubar.append(panel);
}

// Legt das eingefrorene Bild der App unter das Menue und haengt die native
// Ansicht ab (sonst wuerde sie das Menue verdecken). Liefert false, wenn in der
// Zwischenzeit schon wieder geschlossen wurde.
async function openOverlay() {
  const seq = ++menuSeq;
  const cap = window.api.captureWindow ? await window.api.captureWindow() : null;
  if (seq !== menuSeq) return false;
  if (cap && cap.bounds) {
    const b = cap.bounds;
    backdrop.style.left = `${b.x}px`;
    backdrop.style.top = `${b.y}px`;
    backdrop.style.width = `${b.width}px`;
    backdrop.style.height = `${b.height}px`;
    backdrop.classList.toggle('fallback', !cap.shot);
    backdrop.style.backgroundImage = cap.shot ? `url(${cap.shot})` : 'url("icon.svg")';
    backdrop.hidden = false;
  }
  menuOverlay = true;
  await window.api.setOverlay(true);
  return seq === menuSeq;
}

function closeOverlay() {
  backdrop.hidden = true;
  backdrop.style.backgroundImage = '';
  backdrop.classList.remove('fallback');
  if (menuOverlay) {
    menuOverlay = false;
    window.api.setOverlay(false);
  }
}

async function showMenu(i) {
  if (openMenu === -1) {
    if (!(await openOverlay())) return;
    const seq = menuSeq;
    menuState = (await window.api.menuState()) || {};
    if (seq !== menuSeq) return;
  }
  openMenu = i;
  renderPanels();
}

function closeMenu() {
  menuSeq += 1;
  const wasOpen = openMenu !== -1 || menuOverlay;
  openMenu = -1;
  if (wasOpen) renderPanels();
  closeOverlay();
}

/* ---------- Kontextmenue (Rechtsklick) ---------- */

// Was in einem Eingabefeld der Huellflaeche gerade moeglich ist
function shellEditFlags() {
  const el = document.activeElement;
  const editable = Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
  const selected = editable && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd;
  const selection = String(window.getSelection && window.getSelection());
  return {
    canUndo: editable,
    canRedo: editable,
    canCut: Boolean(selected),
    canCopy: Boolean(selected) || Boolean(selection),
    canPaste: editable,
    canDelete: Boolean(selected),
    canSelectAll: true,
  };
}

function contextItems(flags, where) {
  const edit = (role, labelKey, flag) => ({
    id: 'edit', labelKey, value: role, where, enabled: Boolean(flags[flag]),
  });
  return [
    edit('undo', 'menu.undo', 'canUndo'),
    edit('redo', 'menu.redo', 'canRedo'),
    { sep: true },
    edit('cut', 'menu.cut', 'canCut'),
    edit('copy', 'menu.copy', 'canCopy'),
    edit('paste', 'menu.paste', 'canPaste'),
    edit('delete', 'menu.delete', 'canDelete'),
    edit('selectAll', 'menu.selectAll', 'canSelectAll'),
    ...(where === 'view' ? [{ sep: true }, { id: 'reload', labelKey: 'menu.reload' }] : []),
    { sep: true },
    { id: 'devTools', labelKey: 'menu.devTools' },
  ];
}

async function openContextMenu(x, y, flags = {}, where = 'shell') {
  closeMenu();
  closeGroupFlyout();
  if (!(await openOverlay())) return;
  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.setAttribute('role', 'menu');
  buildItems(contextItems(flags, where), panel);
  panel.style.position = 'fixed';
  menubar.append(panel);   // renderPanels() raeumt beim Schliessen alles ab
  panel.style.left = `${x + panel.offsetWidth > window.innerWidth - 8 ? Math.max(4, window.innerWidth - panel.offsetWidth - 8) : x}px`;
  panel.style.top = `${y + panel.offsetHeight > window.innerHeight - 8 ? Math.max(4, window.innerHeight - panel.offsetHeight - 8) : y}px`;
}

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.app')) return;   // App-Symbole haben ihr eigenes Menue
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, shellEditFlags(), 'shell');
});
if (window.api.onContextMenu) {
  window.api.onContextMenu(({ x, y, flags, where }) => openContextMenu(x, y, flags, where));
}

function toggleMenu(i) {
  if (openMenu === i) closeMenu();
  else {
    closeGroupFlyout();
    showMenu(i);
  }
}

document.addEventListener('click', () => {
  closeMenu();
  closeGroupFlyout();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('tour').hidden) return closeTour();
  closeMenu();
  closeGroupFlyout();
});
renderMenubar();

/* ---------- Tastenkuerzel, PIN und Sperre ---------- */

const KEYS_ROWS = [
  ['keys.c.apps', 'keys.v.apps'],
  ['keys.c.switch', 'keys.v.switch'],
  ['keys.c.reload', 'menu.reload'],
  ['keys.c.store', 'menu.installStorePage'],
  ['keys.c.autostart', 'menu.autostart'],
  ['keys.c.devtools', 'menu.devTools'],
  ['keys.c.toggle', 'keys.v.toggle'],
  ['keys.c.minimize', 'keys.v.minimize'],
  ['keys.c.escape', 'keys.v.escape'],
];

const keysDlg = $('keysDlg');

function openKeysDialog() {
  closeAllPopups();
  const table = $('keysTable');
  table.replaceChildren();
  for (const [combo, action] of KEYS_ROWS) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = t(combo);
    const c2 = document.createElement('td');
    c2.textContent = t(action);
    tr.append(c1, c2);
    table.append(tr);
  }
  if (!keysDlg.open) {
    window.api.setOverlay(true);
    keysDlg.showModal();
  }
}

keysDlg.addEventListener('close', () => window.api.setOverlay(false));
$('keysClose').addEventListener('click', () => keysDlg.close());
if (window.api.onOpenKeys) window.api.onOpenKeys(openKeysDialog);

const pinDlg = $('pinDlg');

function openPinDialog() {
  closeAllPopups();
  $('pinInput').value = '';
  $('pinError').textContent = '';
  if (!pinDlg.open) {
    window.api.setOverlay(true);
    pinDlg.showModal();
    $('pinInput').focus();
  }
}

pinDlg.addEventListener('close', () => window.api.setOverlay(false));
$('pinCancel').addEventListener('click', () => pinDlg.close());
$('pinSave').addEventListener('click', async () => {
  const res = await window.api.lockSet($('pinInput').value);
  if (res && res.ok) pinDlg.close();
  else $('pinError').textContent = t('pin.short');
});
$('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pinSave').click(); });
if (window.api.onOpenPin) window.api.onOpenPin(openPinDialog);

const lockEl = $('lock');

function setLocked(on) {
  lockEl.hidden = !on;
  if (on) {
    $('lockPin').value = '';
    $('lockError').textContent = '';
    refreshHelloButton();
    // Ohne PIN bleibt nur der Windows-Hello-Weg
    window.api.lockState().then((s) => {
      const hasPin = Boolean(s && s.hasPin);
      $('lockPin').hidden = !hasPin;
      $('lockUnlock').hidden = !hasPin;
      $('lockPrompt').hidden = !hasPin;
      const target = hasPin ? $('lockPin') : $('lockHello');
      if (!target.hidden) setTimeout(() => target.focus(), 50);
    }).catch(() => {});
  }
}

async function tryUnlock() {
  const ok = await window.api.lockCheck($('lockPin').value);
  if (ok) setLocked(false);
  else {
    $('lockError').textContent = t('lock.wrong');
    $('lockPin').value = '';
    $('lockPin').focus();
  }
}

$('lockUnlock').addEventListener('click', tryUnlock);
$('lockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
if (window.api.onLocked) window.api.onLocked(setLocked);

/* ---------- Berechtigungen pro App ---------- */

const PERM_ROWS = [
  ['notifications', 'perm.notifications'],
  ['media', 'perm.camera'],
  ['microphone', 'perm.microphone'],
  ['clipboard-sanitized-write', 'perm.clipboard'],
  ['fullscreen', 'perm.fullscreen'],
];

const permDlg = $('permDlg');
let permAppId = null;

function openPermsDialog(payload) {
  closeAllPopups();
  permAppId = payload && payload.id ? payload.id : null;
  const perms = (payload && payload.perms) || {};
  const rows = $('permRows');
  rows.replaceChildren();
  for (const [key, labelKey] of PERM_ROWS) {
    const row = document.createElement('label');
    row.className = 'perm-row';
    const span = document.createElement('span');
    span.textContent = t(labelKey);
    const sel = document.createElement('select');
    sel.dataset.perm = key;
    for (const [value, textKey] of [['ask', 'perm.ask'], ['allow', 'perm.allow'], ['deny', 'perm.deny']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = t(textKey);
      sel.append(opt);
    }
    sel.value = perms[key] || 'allow';
    row.append(span, sel);
    rows.append(row);
  }
  if (!permDlg.open) {
    window.api.setOverlay(true);
    permDlg.showModal();
  }
}

permDlg.addEventListener('close', () => window.api.setOverlay(false));
$('permCancel').addEventListener('click', () => permDlg.close());
$('permSave').addEventListener('click', async () => {
  const perms = {};
  for (const sel of $('permRows').querySelectorAll('select')) perms[sel.dataset.perm] = sel.value;
  if (permAppId) await window.api.permsSet(permAppId, perms);
  permDlg.close();
});
if (window.api.onOpenPerms) window.api.onOpenPerms(openPermsDialog);

/* ---------- Audio-Mixer ---------- */

const mixDlg = $('mixDlg');
let mixTimer = null;
const mixRows = new Map();   // appId -> { state, sw }

function buildMixerRows(list) {
  const ul = $('mixList');
  ul.replaceChildren();
  mixRows.clear();
  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'mix-row';
    const name = document.createElement('span');
    name.className = 'mix-name';
    name.textContent = item.name;
    const state = document.createElement('span');
    state.className = item.audible ? 'mix-state playing' : 'mix-state';
    state.textContent = item.audible ? t('mix.playing') : t('mix.quiet');
    const muteLabel = document.createElement('span');
    muteLabel.className = 'mix-mute';
    muteLabel.textContent = t('mix.mute');
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.checked = item.muted;
    sw.addEventListener('change', () => window.api.setMute(item.id, sw.checked));
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = t('mix.open');
    open.addEventListener('click', () => {
      mixDlg.close();               // Dialog schliessen, damit die App sichtbar wird
      window.api.activate(item.id);
    });
    li.append(name, state, muteLabel, sw, open);
    ul.append(li);
    mixRows.set(item.id, { state, sw });
  }
}

// Nur die Anzeige aktualisieren: bleiben die Zeilen bestehen, kommen Klicks
// sicher an (ein Neuaufbau mitten im Klick wuerde ihn verschlucken)
async function refreshMixer() {
  const list = await window.api.mixerList();
  if (list.length !== mixRows.size) return buildMixerRows(list);
  for (const item of list) {
    const row = mixRows.get(item.id);
    if (!row) return buildMixerRows(list);
    row.state.className = item.audible ? 'mix-state playing' : 'mix-state';
    row.state.textContent = item.audible ? t('mix.playing') : t('mix.quiet');
    if (row.sw.checked !== item.muted) row.sw.checked = item.muted;
  }
}

async function openMixer() {
  closeAllPopups();
  if (!mixDlg.open) {
    window.api.setOverlay(true);
    mixDlg.showModal();
  }
  buildMixerRows(await window.api.mixerList());
  clearInterval(mixTimer);
  mixTimer = setInterval(refreshMixer, 2000);
}

mixDlg.addEventListener('close', () => {
  clearInterval(mixTimer);
  mixTimer = null;
  window.api.setOverlay(false);
});
$('mixClose').addEventListener('click', () => mixDlg.close());
$('mixAll').addEventListener('click', async () => {
  await window.api.muteAll(true);
  await refreshMixer();
});
if (window.api.onOpenMixer) window.api.onOpenMixer(openMixer);

/* ---------- Kurz-Einfuehrung (Tour) ---------- */

const TOUR_STEPS = [
  ['tour.t1', 'tour.d1'],
  ['tour.t2', 'tour.d2'],
  ['tour.t3', 'tour.d3'],
  ['tour.t4', 'tour.d4'],
  ['tour.t5', 'tour.d5'],
];
let tourStep = 0;

function renderTour() {
  const [titleKey, textKey] = TOUR_STEPS[tourStep];
  $('tourTitle').textContent = t(titleKey);
  $('tourText').textContent = t(textKey);
  const dots = $('tourDots');
  dots.replaceChildren();
  TOUR_STEPS.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = i === tourStep ? 'tour-dot active' : 'tour-dot';
    dots.append(dot);
  });
  $('tourNext').textContent = tourStep === TOUR_STEPS.length - 1 ? t('tour.done') : t('tour.next');
}

function showTour() {
  tourStep = 0;
  renderTour();
  $('tour').hidden = false;
  // Die native App-Ansicht liegt ueber der Huelle: ohne Abhaengen wuerde sie
  // die Tour verdecken und die Leiste scheinbar blockieren (wie bei Dialogen)
  window.api.setOverlay(true);
}

function closeTour() {
  $('tour').hidden = true;
  window.api.setOverlay(false);
  window.api.tourDone();
}

$('tourNext').addEventListener('click', () => {
  if (tourStep >= TOUR_STEPS.length - 1) return closeTour();
  tourStep += 1;
  renderTour();
});
$('tourSkip').addEventListener('click', closeTour);
if (window.api.onTour) window.api.onTour(showTour);

/* ---------- Windows Hello im Sperrbildschirm ---------- */

const lockHelloBtn = $('lockHello');

async function refreshHelloButton() {
  if (!window.api.helloState) return;
  try {
    const s = await window.api.helloState();
    lockHelloBtn.hidden = !(s && s.enabled);
  } catch {
    lockHelloBtn.hidden = true;
  }
}

lockHelloBtn.addEventListener('click', async () => {
  lockHelloBtn.disabled = true;
  $('lockError').textContent = '';
  const res = await window.api.helloUnlock();
  lockHelloBtn.disabled = false;
  if (res && res.ok) return setLocked(false);
  const reason = res && res.reason;
  $('lockError').textContent = (reason === 'DeviceNotPresent' || reason === 'NotConfiguredForUser' || reason === 'DisabledByPolicy')
    ? t('lock.helloSetup')
    : t('lock.helloFail');
});

/* ---------- Eigene Sperre pro App (Schloss auf dem Symbol) ---------- */

const appLockEl = $('appLock');
let appLockId = null;

function showAppLock(id) {
  const a = apps.find((x) => x.id === id);
  appLockId = id;
  $('appLockName').textContent = a ? a.name : '';
  $('appLockPin').value = '';
  $('appLockError').textContent = '';
  appLockEl.hidden = false;
  window.api.lockState().then((s) => {
    const hasPin = Boolean(s && s.hasPin);
    $('appLockPin').hidden = !hasPin;
    $('appLockUnlock').hidden = !hasPin;
    $('appLockPrompt').hidden = !hasPin;
    const target = hasPin ? $('appLockPin') : $('appLockHello');
    if (!target.hidden) setTimeout(() => target.focus(), 50);
  }).catch(() => {});
  refreshAppHelloButton();
}

function hideAppLock() {
  appLockEl.hidden = true;
  appLockId = null;
}

async function refreshAppHelloButton() {
  if (!window.api.helloState) return;
  try {
    const s = await window.api.helloState();
    $('appLockHello').hidden = !(s && s.enabled);
  } catch {
    $('appLockHello').hidden = true;
  }
}

async function tryAppUnlock() {
  const ok = await window.api.appUnlock(appLockId, $('appLockPin').value);
  if (ok) hideAppLock();
  else {
    $('appLockError').textContent = t('lock.wrong');
    $('appLockPin').value = '';
    $('appLockPin').focus();
  }
}

$('appLockUnlock').addEventListener('click', tryAppUnlock);
$('appLockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAppUnlock(); });
$('appLockOther').addEventListener('click', () => {
  // Ausweg: Freigabe abbrechen und zu einer anderen, freien App wechseln
  const skip = appLockId;
  hideAppLock();
  const other = apps.find((a) => a.id !== skip && !a.locked);
  if (other) window.api.activate(other.id);
});
$('appLockHello').addEventListener('click', async () => {
  const btn = $('appLockHello');
  btn.disabled = true;
  $('appLockError').textContent = '';
  const res = await window.api.appHelloUnlock(appLockId);
  btn.disabled = false;
  if (res && res.ok) return hideAppLock();
  const reason = res && res.reason;
  $('appLockError').textContent = (reason === 'DeviceNotPresent' || reason === 'NotConfiguredForUser' || reason === 'DisabledByPolicy')
    ? t('lock.helloSetup')
    : t('lock.helloFail');
});
if (window.api.onAppLock) window.api.onAppLock(({ id }) => showAppLock(id));

/* ---------- Info-Dialog ---------- */

const infoDlg = $('infoDlg');

function openInfoDialog(payload) {
  closeAllPopups();
  $('infoVersion').textContent = `${t('info.version')} ${payload.version}`;
  const table = $('infoTable');
  table.replaceChildren();
  const rows = [
    [t('info.electron'), `${payload.electron} (Chromium ${payload.chrome})`],
    [t('info.platform'), payload.platform],
    [t('info.apps'), String(payload.apps)],
    [t('info.license'), payload.license],
    [t('info.folder'), payload.userData],
  ];
  for (const [key, value] of rows) {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    tdKey.textContent = key;
    const tdValue = document.createElement('td');
    tdValue.textContent = value;
    tr.append(tdKey, tdValue);
    table.append(tr);
  }
  if (!infoDlg.open) {
    window.api.setOverlay(true);
    infoDlg.showModal();
  }
}

infoDlg.addEventListener('close', () => window.api.setOverlay(false));
$('infoClose').addEventListener('click', () => infoDlg.close());
$('infoFolder').addEventListener('click', () => window.api.openUserData());
if (window.api.onOpenInfo) window.api.onOpenInfo(openInfoDialog);

/* ---------- Identitätsbestätigung (Sperren entfernen) ---------- */

const authDlg = $('authDlg');
let authCallback = null;

async function openAuthDialog(reason, onOk) {
  closeAllPopups();
  authCallback = onOk;
  $('authReason').textContent = reason;
  $('authPin').value = '';
  $('authError').textContent = '';
  $('authHello').hidden = true;   // wird spaeter nachgelegt
  const s = await window.api.lockState().catch(() => ({}));
  const hasPin = Boolean(s && s.hasPin);
  $('authPin').hidden = !hasPin;
  $('authOk').hidden = !hasPin;
  if (!authDlg.open) {
    window.api.setOverlay(true);
    authDlg.showModal();
    const target = hasPin ? $('authPin') : $('authHello');
    if (!target.hidden) setTimeout(() => target.focus(), 50);
  }
  // Windows-Hello-Verfuegbarkeit braucht eine Windows-Runde: nicht den
  // Dialog davor aufhalten
  window.api.helloState().then((hello) => {
    if (authCallback !== onOk) return;
    $('authHello').hidden = !(hello && hello.enabled);
    if (!hasPin && !$('authHello').hidden) setTimeout(() => $('authHello').focus(), 50);
  }).catch(() => {});
}

function finishAuth(ok) {
  const cb = authCallback;
  authCallback = null;
  authDlg.close();
  if (ok && cb) cb();
}

authDlg.addEventListener('close', () => {
  // Falls darunter noch ein Dialog offen ist, bleibt die App-Ansicht abgehaengt
  const stillOpen = [...document.querySelectorAll('dialog')].some((d) => d.open);
  if (!stillOpen) window.api.setOverlay(false);
});
$('authCancel').addEventListener('click', () => finishAuth(false));
$('authOk').addEventListener('click', async () => {
  const ok = await window.api.authVerify($('authPin').value);
  if (ok) finishAuth(true);
  else {
    $('authError').textContent = t('lock.wrong');
    $('authPin').value = '';
    $('authPin').focus();
  }
});
$('authPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authOk').click(); });
$('authHello').addEventListener('click', async () => {
  $('authError').textContent = '';
  const ok = await window.api.authHello();
  if (ok) finishAuth(true);
  else $('authError').textContent = t('lock.helloFail');
});

// Sperren-Aktionen aus den Menues verlangen zuerst die Bestätigung
if (window.api.onAuth) {
  window.api.onAuth(({ mode, id }) => {
    const reasons = {
      lockClear: t('auth.reasonLockClear'),
      helloOff: t('auth.reasonHelloOff'),
      unprotect: t('auth.reasonUnprotect'),
    };
    openAuthDialog(reasons[mode] || t('auth.title'), () => {
      if (mode === 'lockClear') window.api.menuClick('lockClear', true);
      else if (mode === 'helloOff') window.api.menuClick('helloToggle', true);
      else if (mode === 'unprotect') window.api.appUnprotect(id);
    });
  });
}
