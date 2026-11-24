// Einfache Sprachumschaltung (Deutsch/Englisch/Spanisch).
// Wird vom Hauptprozess, vom Preload und von den Modulen sync/webstore genutzt.
const fs = require('fs');
const path = require('path');

// Woerterbuch tolerant laden: BOM ignorieren und kurze Wiederholungen machen,
// weil die Datei beim Start auch mal durch die Nextcloud-Synchronisation
// gesperrt sein kann. Liefert null, wenn sie dauerhaft nicht lesbar ist.
function loadDict(name) {
  const file = path.join(__dirname, 'locales', name + '.json');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      if (attempt === 3) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch {}
    }
  }
  return null;
}

const de = loadDict('de');
const en = loadDict('en');
const es = loadDict('es');
const DICTS = { de: de || {}, en: en || {}, es: es || {} };
let locale = 'de';

// true, wenn alle Sprachdateien gelesen werden konnten
function isReady() {
  return Boolean(de && en && es);
}

// "de" beginnend (de, de-DE, de-AT ...) wird Deutsch, "es" beginnend
// (es, es-ES, es-MX ...) wird Spanisch, alles andere Englisch.
function setLocale(raw) {
  const l = String(raw || '').toLowerCase();
  locale = l.startsWith('de') ? 'de' : l.startsWith('es') ? 'es' : 'en';
  return locale;
}

function getLocale() {
  return locale;
}

// t('dialog.removeMessage', { name: 'WhatsApp' })
// Ohne Woerterbuch wird der Schluessel zurueckgegeben - die Oberflaeche faengt
// das ab und zeigt dann ihre statischen Texte.
function t(key, vars) {
  const dict = DICTS[locale] || de || {};   // Fallback bei Ladeproblem: Deutsch
  let s = dict[key];
  if (s == null && de) s = de[key];
  if (s == null) return key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return s;
}

// Sprache + Woerterbuch fuer den Renderer (ueber den Preload)
function bundle() {
  return { locale, dict: DICTS[locale] || {} };
}

module.exports = { t, setLocale, getLocale, bundle, isReady };
