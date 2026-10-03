# Fehlerbehebung

| Symptom | Ursache / Lösung |
| --- | --- |
| „Ein natives Modul passt nicht zur Laufzeitumgebung“ | `npm install` erneut ausführen und `npm run native:check` prüfen. |
| LLM-Test: „nicht erreichbar“ | Base URL, Proxy und Firewall prüfen; Logs unter `…/Archivist/logs/`. |
| LLM-Test: „Endpunkt oder Modell nicht gefunden“ | Die Base URL muss auf die API-Wurzel zeigen (z. B. `…/openai/v1`), der Modellname exakt dem Deployment entsprechen. |
| Claude auf Foundry: Chat arbeitet nicht als Agent | Den Anthropic-Endpunkt `https://<resource>.services.ai.azure.com/anthropic` eintragen, siehe [LLM-Anbieter verbinden](llm-anbieter-verbinden.md#claude-auf-foundry-mit-werkzeugen-nutzen). |
| LLM-Anfragen scheitern sofort | Nach einer Zeitüberschreitung oder einem unerreichbaren Endpunkt scheitern Anfragen 60 s lang sofort, statt erneut zu warten. Kurz warten oder **Verbindung testen** – der Test geht immer durch. |
| Keine Desktop-Benachrichtigungen in der Entwicklung | Unter `npm run dev` gilt `electron.exe` als App: `node_modules\electron\dist\electron.exe` an „Start“ anheften. |
| Benachrichtigung über ungültige Einstellungen | `config/settings.json` enthielt ungültige Werte; nur diese Felder wurden auf den Standard gesetzt. Das Original liegt als `settings.json.invalid-<Zeit>` bzw. `settings.json.corrupt-<Zeit>` daneben. |
| Archivprüfung meldet „Archivdatei fehlt“, obwohl die Datei nur umbenannt oder verschoben wurde | **Einstellungen → Archiv → Archivzustand prüfen**, dann **Verschobene Dateien neu verknüpfen**. Archivist findet die Datei an ihrer Prüfsumme wieder. |
| „Die Archivkopie dieses Dokuments fehlt …“ beim Öffnen | Die Archivdatei wurde umbenannt, verschoben oder gelöscht, und es gibt keine Kopie mit derselben Prüfsumme als Ersatz. Archivist öffnet nie stillschweigend eine andere Fassung. Wurde die Datei nur verschoben: **Verschobene Dateien neu verknüpfen** (siehe oben); sonst stell sie aus einem Backup wieder her. |
| Archivprüfung meldet „Archivdatei verändert“ | Die Datei im Archiv hat eine andere Größe oder Prüfsumme als beim Archivieren (überschrieben, beschädigt). Stell sie aus deinem Original oder einem vollständigen Backup wieder her. |
| Archivprüfung meldet „Original fehlt“ | Das Original eines nur indexierten Dokuments ist nicht mehr am bekannten Ort. |
| „Die Datenbank von Archivist ist beschädigt“ beim Start | Archivist bietet das neueste unbeschädigte Backup an, siehe [Backup wiederherstellen](backup-wiederherstellen.md#wenn-archivist-wegen-einer-beschädigten-datenbank-nicht-startet). Deine Dokumente im Archivordner sind nicht betroffen. |
| „Die Datenbank stammt von einer neueren Version“ | Die installierte Version ist älter als die, die die Datenbank zuletzt geöffnet hat. Die aktuelle Version installieren; die Daten wurden nicht verändert. |
| SmartScreen warnt beim Installer | Das Paket ist unsigniert, siehe [Release veröffentlichen – Signieren](release-veroeffentlichen.md#signieren). |
