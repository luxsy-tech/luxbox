# Luxbox

Luxbox ist ein Rambox-ähnlicher Browser: mehrere Web-Apps (WhatsApp, Slack, Teams, interne Tools …) in einem Fenster, jede mit eigener Sitzung.

## Starten

```bash
npm install
npm install electron-chrome-extensions adm-zip
npm start
```

## Installer bauen

Jedes System baut seinen Installer am besten selbst (ein Windows-Installer unter Linux braucht Wine, ein macOS-Image geht nur auf einem Mac). Das Ergebnis landet in `./dist`.

```bash
npm install
npm run dist:win           # Windows: Luxbox-Setup-<Version>.exe
npm run dist:win:machine   # Windows: Installer, der immer für alle Benutzer installiert
npm run dist:mac           # macOS: .dmg für Intel und Apple Silicon
npm run dist:linux         # Linux: .AppImage, .deb und .rpm
npm run build              # alle Ziele des aktuellen Systems
```

### Für alle Benutzer installieren

| System | Vorgehen |
|---|---|
| **Windows** | Den Installer starten. Er fragt, ob für **alle Benutzer** oder nur für den aktuellen Benutzer installiert wird. Bei „alle Benutzer“ verlangt er Administratorrechte und installiert nach `C:\Program Files\Luxbox`. `dist:win:machine` baut eine Variante, die immer für alle Benutzer installiert. |
| **macOS** | `.dmg` öffnen und Luxbox in den Ordner **Programme** ziehen. Er gilt für alle Benutzer des Macs. |
| **Linux** | `.deb` mit `sudo apt install ./Luxbox-*.deb`, `.rpm` mit `sudo dnf install ./Luxbox-*.rpm`. Beides installiert systemweit (`/opt/Luxbox`) samt Startmenü-Eintrag. Die `.AppImage` ist dagegen eine einzelne Datei ohne Installation. |

Unbeaufsichtigte Installation unter Windows, zum Beispiel per Softwareverteilung:

```
Luxbox-Setup-4.3.0.exe /S /allusers
Luxbox-Setup-4.3.0.exe /S /currentuser
```

Mit `/D=C:\Pfad` (immer als letzter Parameter) wählst du ein anderes Zielverzeichnis.

### Daten der Benutzer

Das Programm liegt für alle Benutzer an einem Ort, die Daten bleiben aber **pro Benutzer** getrennt: Apps, Einstellungen, Logins und Erweiterungen liegen im jeweiligen Benutzerprofil. Beim Deinstallieren werden sie bewusst nicht gelöscht.

### Hinweise

- Die Installer sind nicht signiert. Windows (SmartScreen) und macOS (Gatekeeper) zeigen deshalb eine Warnung. Zum Signieren brauchst du ein Zertifikat (Windows) beziehungsweise eine Apple-Developer-ID (macOS).
- Passe in der `package.json` die Platzhalter `author`, `homepage` und `linux.maintainer` an. Für `.deb` und `.rpm` sind sie nötig.
- Die Lizenz ist dort auf `GPL-3.0-only` gesetzt, weil `electron-chrome-extensions` unter GPL-3.0 steht (siehe Lizenz-Hinweis unten). Ändere das nur nach Prüfung.

## Funktionen

- Pro App wählbar: geteilte Sitzung (Standard, Logins und Erweiterungen nur einmal einrichten) oder eigene Sitzung (`persist:app-<id>`) für getrennte Logins, etwa ein zweites WhatsApp-Konto
- Vorlagen für gängige Dienste oder beliebige Adresse
- Apps werden gespeichert (`apps.json` im Electron-userData-Ordner) und beim Start wieder angezeigt
- Apps laden erst beim ersten Öffnen
- Badge mit ungelesenen Nachrichten, erkannt am Seitentitel wie `(3) Posteingang`
- Favicons werden automatisch geladen, lokal gespeichert und sind auch vor dem ersten Laden der App sichtbar; Reihenfolge per Drag & Drop
- Chrome-Erweiterungen laden (🧩 in der Seitenleiste), siehe unten
- Rechtsklick auf eine App: neu laden, Startseite, stumm schalten, bearbeiten, Entwicklertools, entfernen
- Zertifikatswarnungen lassen sich pro App ignorieren (nicht mehr global)
- Links, die neue Fenster öffnen, gehen in den Standardbrowser
- Tastenkürzel: `Strg+1…9` App wechseln, `Strg+Tab` nächste App, `Strg+R` neu laden, `F12` Entwicklertools

## Dateien

| Datei | Aufgabe |
|---|---|
| `main.js` | Hauptprozess: Fenster, Views, Speicherung, Menüs |
| `preload.js` | Sichere Brücke zwischen Seitenleiste und Hauptprozess |
| `index.html`, `renderer.js`, `styles.css` | Seitenleiste und Dialog |

## Hinweis

Die `package-lock.json` passt nicht mehr zur `package.json` (neue Abhängigkeit `electron-builder`). Lösche sie und führe `npm install` einmal neu aus.

## Chrome-Erweiterungen

Installation: 🧩 in der Seitenleiste (oder Menü **Apps → Verwalten**).

- **Aus dem Store:** Store-Link oder ID einfügen und „Installieren“ wählen. Das funktioniert mit dem Chrome Web Store und mit Microsoft Edge Add-ons.
- **Store durchsuchen:** „Chrome Web Store öffnen“ oder „Edge Add-ons öffnen“ zeigt den Store in einem eigenen Fenster. Auf der Seite einer Erweiterung im Menü **Apps → Aktuelle Store-Seite installieren** (`Strg+Umschalt+E`) wählen. Der „Zu Chrome hinzufügen“-Button des Stores selbst funktioniert nicht.
- **Entpackter Ordner:** Ein Ordner mit `manifest.json` lässt sich weiterhin laden.

Installierte Erweiterungen gelten für alle Apps. Ihre Symbole erscheinen unten links in der Seitenleiste. Ein Klick öffnet das Popup, wie bei Chrome.

Grenzen: Die Erweiterungs-APIs stammen aus `electron-chrome-extensions`. Es sind nur die dort aufgeführten `chrome.*`-APIs vorhanden, Hintergrundskripte laufen dauerhaft, Updates der Erweiterungen kommen nicht automatisch (entfernen und neu installieren). Manche Erweiterungen (zum Beispiel Werbeblocker auf `webRequest`-Basis) laufen deshalb nur teilweise.

## Lizenz-Hinweis

`electron-chrome-extensions` steht unter GPL-3.0 (oder einer kostenpflichtigen Lizenz für proprietäre Nutzung). Für die private Nutzung ist das unproblematisch. Wenn du die App weitergibst, muss sie unter GPL-3.0 stehen.

## WhatsApp: „Chrome-Version zu alt“

Der Chrome-Anteil im User-Agent entspricht der Chromium-Version deiner Electron-Installation. Aktualisiere Electron:

```bash
npm install -D electron@latest
```

## Speicher und Geschwindigkeit

- **Ruhezustand:** Inaktive Apps geben nach 15 Minuten ihren Speicher frei und laden beim nächsten Öffnen neu (Menü **Einstellungen → Inaktive Apps in Ruhezustand nach**). Das spart am meisten. Apps mit „Im Hintergrund aktiv halten“ und Apps, die gerade Ton ausgeben, bleiben davon ausgenommen. Rechtsklick auf eine App: „Jetzt in Ruhezustand“.
- **Apps laden erst beim ersten Öffnen**, nicht schon beim Start.
- Geteilte Sitzungen brauchen weniger Prozesse als eigene Sitzungen je App.
- Die Erweiterungs-Bibliothek, der Debugger für Client Hints und die Rechtschreibprüfung sind nur aktiv, wenn sie gebraucht werden.
- Die Seitenleiste aktualisiert nur das betroffene Symbol.

## Umzug von „ops-browser“

Beim ersten Start übernimmt Luxbox Apps, Logins und Einstellungen aus dem alten Datenordner `ops-browser`, falls er existiert.

## Nextcloud-Sync

Luxbox gleicht Apps, Einstellungen und die Liste der Store-Erweiterungen zwischen mehreren Geräten ab. Es braucht dafür weder Zugangsdaten noch eine Nextcloud-Verbindung: Du wählst im Dialog (☁ in der Seitenleiste oder Menü **Einstellungen → Configure-Sync …**) einen Ordner innerhalb deines Nextcloud-Verzeichnisses, und der Nextcloud-Client überträgt die Dateien.

Jedes Gerät schreibt nur seine eigene Datei `luxbox-sync-<Geräte-ID>.json` und liest die der anderen. Dadurch entstehen keine Konflikte („conflicted copy“). Bei Widersprüchen gilt je App der zuletzt geänderte Stand, Löschungen werden mit übertragen.

**Wird abgeglichen:** Name, Adresse und Optionen jeder App (eigene Sitzung, Hintergrund aktiv, stumm, Zertifikate ignorieren), die Reihenfolge, der Ruhezustand und die Store-Erweiterungen (nur Store und ID).

**Wird nie abgeglichen:** Passwörter, Logins, Cookies, Erweiterungsdaten (auch deren Logins), Favicons und per Ordner geladene Erweiterungen. Auf jedem Gerät meldest du dich einmal selbst an.

Hinweise:
- Erweiterungen, die auf einem anderen Gerät installiert wurden, installiert Luxbox erst nach Rückfrage.
- Die Datei enthält die Adressen deiner Apps im Klartext. Lege keine Zugangsdaten in Adressen.
- Der Ordner muss auf dem Gerät lokal vorhanden sein (im Nextcloud-Client nicht als „nur online“ markieren).
- Zwei Apps mit gleichem Namen und gleicher Adresse, die du auf beiden Geräten von Hand angelegt hast, werden nicht doppelt angezeigt, aber auch nicht verknüpft.

## Icon

Das App-Icon (eine Box mit angehobenem Deckel, aus der Licht fällt) liegt in zwei Ordnern:

| Datei | Verwendung |
|---|---|
| `build/icon.ico`, `build/icon.icns`, `build/icon.png` | Installer und Programmdatei für Windows, macOS und Linux (`npm run build`) |
| `assets/icon.png` | Fenster-, Taskleisten- und Dock-Icon beim Start mit `npm start` |
| `build/icon.svg` | Bearbeitbare Vorlage |

Zum Austauschen ersetzt du diese Dateien und führst `npm run build` neu aus. Die PNG sollte 1024 × 1024 Pixel groß sein.
