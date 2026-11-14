# Video-Downloader

Lokale Windows-App mit Firefox-Add-on, die Videos (HLS/m3u8, direkte Links, YouTube) als **Jobs** herunterlädt – mit Warteschlange, Fortschritt, Benennungsvorlagen und nachträglichem Komprimieren per Knopf.

```
addon/    Firefox-Add-on: findet Streams, baut den yt-dlp/ffmpeg-Befehl zum Zusammenklicken, "An Helfer senden"
helper/   Die App: Download-Server (127.0.0.1) + Dashboard-Fenster + Tray-Symbol (Python, pywebview, pystray)
```

## App bauen (Windows)

Voraussetzung: Python 3.10+.

1. `helper\build.bat` doppelklicken.
2. Ergebnis: `helper\dist\m3u8-Helfer\m3u8-Helfer.exe` (den ganzen Ordner verschieben ist okay).

`build.bat` legt außerdem `yt-dlp.exe` und `ffmpeg.exe` in den Unterordner `tools`. Alternativ baut GitHub Actions die App: Reiter **Actions → Windows-App bauen → Run workflow**, danach unter *Artifacts* `m3u8-Helfer-windows` herunterladen.

## Benutzen

1. `m3u8-Helfer.exe` starten. Beim ersten Start erscheint das Dashboard.
2. Add-on laden: Firefox → `about:debugging` → *Dieser Firefox* → *Temporäres Add-on laden* → `addon/manifest.json`.
3. Im Dashboard **Mit Add-on verbinden**: Adresse und Token kopieren, im Add-on im Reiter **Helfer** eintragen, *Speichern und testen*.
4. Video auf der Seite abspielen → im Add-on **An Helfer senden**.

- **Fenster schließen** schiebt die App in den Tray (Symbol unten rechts). **Beenden** nur über das Tray-Menü.
- Tray-Menü: Öffnen, Download-Ordner, *Mit Windows starten*, *yt-dlp aktualisieren*, Beenden.
- **Komprimieren**: In der Warteschlange bei einem fertigen Video auf *Komprimieren…* klicken (Qualität per CRF oder Zielgröße in MB).
- **Benennung**: Dashboard → Einstellungen. Variablen `{site} {page_title} {date} {time} {job}`, dazu yt-dlp-Platzhalter wie `%(title)s`.
- **Dateiprüfung**: Fertige Downloads werden auf Lesbarkeit geprüft. Defekte Dateien (z. B. verschlüsselte Streams) werden als Fehler markiert statt als „Fertig“.

## Sicherheit

Der Server hört nur auf `127.0.0.1`, verlangt ein Token (steht in `%APPDATA%\m3u8-helper\config.json`), prüft Host und Origin und lässt nur erlaubte yt-dlp/ffmpeg-Optionen zu (keine Shell, kein `--exec`). Token nicht weitergeben.

## Entwickeln

```
cd helper
pip install -r requirements.txt
python app.py            # Fenster + Tray
python app.py --browser  # Dashboard im Browser
python helper.py         # nur der Server, mit Konsole
```

## Hinweis

Entwickelt und getestet unter Linux mit echtem yt-dlp und ffmpeg. Die Windows-Teile (Fenster, Tray, Autostart, `.exe`-Build, „Ordner öffnen“, Prozess-Abbruch) sind nicht auf Windows getestet. Nur Inhalte herunterladen, zu denen du die Rechte hast; bei YouTube gelten dessen Nutzungsbedingungen.
