// Installiert Erweiterungen per ID oder Store-Link aus dem Chrome Web Store oder Microsoft Edge Add-ons.
const { app, net } = require('electron');
const { t } = require('./i18n.js');
const path = require('path');
const fs = require('fs');

const ID_RE = /(?<![a-p])[a-p]{32}(?![a-p])/;
const MAX_CRX_BYTES = 80 * 1024 * 1024;

const storeRoot = () => path.join(app.getPath('userData'), 'store-extensions');

function parseStoreInput(input, fallbackStore = 'chrome') {
  const text = String(input || '').trim();
  const id = (ID_RE.exec(text) || [])[0];
  if (!id) return null;
  let store = fallbackStore === 'edge' ? 'edge' : 'chrome';
  if (/microsoftedge\.microsoft\.com|edge\.microsoft\.com/i.test(text)) store = 'edge';
  else if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(text)) store = 'chrome';
  return { id, store };
}

function crxUrl({ id, store }) {
  const x = `id%3D${id}%26installsource%3Dondemand%26uc`;
  return store === 'edge'
    ? `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=${x}`
    : `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=${x}`;
}

function zipOffset(buf) {
  if (buf.subarray(0, 2).toString() === 'PK') return 0;                 // schon ein Zip
  if (buf.subarray(0, 4).toString() !== 'Cr24') throw new Error(t('err.noCrx'));
  const version = buf.readUInt32LE(4);
  if (version === 3) return 12 + buf.readUInt32LE(8);
  if (version === 2) return 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  throw new Error(t('err.crxVersion', { version }));
}

// Löst Namen wie "__MSG_appName__" über _locales auf.
function resolveName(dir, manifest) {
  const raw = String(manifest.name || path.basename(dir));
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw;
  const locales = [manifest.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const loc of locales) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key && messages[key].message) return messages[key].message;
    } catch { /* nächste Sprache */ }
  }
  return raw;
}

function readManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return { name: resolveName(dir, manifest), version: String(manifest.version || '') };
}

async function installFromStore(parsed) {
  const res = await net.fetch(crxUrl(parsed));
  if (!res.ok || res.status === 204) {
    throw new Error(t('err.storeMissing'));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_CRX_BYTES) throw new Error(t('err.crxSize'));

  const dir = path.join(storeRoot(), `${parsed.store}-${parsed.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    let AdmZip;
    try {
      AdmZip = require('adm-zip');   // erst bei Bedarf laden
    } catch {
      throw new Error(t('err.admZip'));
    }
    new AdmZip(buf.subarray(zipOffset(buf))).extractAllTo(dir, true);
    fs.rmSync(path.join(dir, '_metadata'), { recursive: true, force: true }); // Chrome-Metadaten, Electron lehnt sie ab
    return { path: dir, id: parsed.id, store: parsed.store, ...readManifest(dir) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function removeInstalled(dir) {
  if (path.resolve(dir).startsWith(path.resolve(storeRoot()) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { parseStoreInput, installFromStore, removeInstalled, readManifest };
