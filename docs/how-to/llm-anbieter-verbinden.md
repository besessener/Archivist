# LLM-Anbieter verbinden

Archivist spricht zwei Schnittstellen: die OpenAI-kompatible **Responses API** (OpenAI, Azure OpenAI, Foundry `…/openai/v1`) und die **Anthropic Messages API** (Claude direkt oder über Microsoft Foundry). Welche verwendet wird, ergibt sich aus der Base URL.

## Verbindung eintragen

1. Öffne **Einstellungen → KI** (beim ersten Start: Einrichtungsdialog).
2. Trag **Base URL**, **API-Key** und **Modell** ein. Der Modellname muss exakt dem Deployment-Namen entsprechen.
3. Optional: **Denktiefe (Reasoning)**, Timeout, maximale Eingabegröße und ein **Embedding-Modell** (leer lassen für die lokale Ähnlichkeitssuche, siehe [Suche](../explanation/suche.md)).
4. Klick auf **Verbindung testen**. Der Test prüft eine Textantwort, eine strukturierte Antwort und einen echten Werkzeugaufruf mit Rückgabe und Streaming. Scheitern nur die strukturierten Antworten, zeigt Archivist das getrennt an.

Beispiele für die Base URL:

| Anbieter | Base URL | Adapter |
| --- | --- | --- |
| Azure OpenAI / Foundry (OpenAI-Modelle) | `https://<resource>.openai.azure.com/openai/v1` | Responses |
| Claude auf Microsoft Foundry | `https://<resource>.services.ai.azure.com/anthropic` | Anthropic |
| Claude API | `https://api.anthropic.com` | Anthropic |

Die Base URL muss mit `https://` beginnen; `http://` ist nur für deinen eigenen Rechner (`localhost`, `127.0.0.1`, `[::1]`) erlaubt, siehe [Datenschutz einstellen](datenschutz-einstellen.md#verschlüsselte-verbindung-sicherstellen).

Erkannt wird der Anthropic-Adapter an `api.anthropic.com` bzw. einer URL, die auf `…/anthropic` endet; alles andere gilt als Responses API.

## Claude auf Foundry mit Werkzeugen nutzen

Claude-Modelle auf Foundry bieten natives Tool-Calling nur am Anthropic-Endpunkt derselben Ressource. Trägst du den OpenAI-Endpunkt ein, schlägt der Verbindungsdialog `https://<resource>.services.ai.azure.com/anthropic` vor – übernimm ihn. Ohne natives Tool-Calling arbeitet der Chat mit der regelbasierten Auswertung statt im [Agentenmodus](../reference/agentenmodus.md).

## Adapter manuell festlegen

Wird der Adapter falsch erkannt, setz ihn unter **Einstellungen → Agent → Erweitert → Schnittstelle (Adapter)** auf `anthropic` oder `openai`. Der Verlauf wird anbieterneutral gespeichert – ein Wechsel braucht keinen Neustart.

## Websuche im Chat abschalten

Die Websuche des Anbieters ist im Chat standardmäßig erlaubt. Abschalten unter **Einstellungen → Agent → Websuche im Chat**. Details und Kosten: [Agentenmodus – Websuche](../reference/agentenmodus.md#websuche-im-chat).

## Ohne externes LLM arbeiten

Stell unter **Einstellungen → Datenschutz** den Modus `local_only` ein. Archivist klassifiziert dann lokal, sucht mit lokalen Vektoren und wertet den Chat regelbasiert aus. Siehe [Datenschutz einstellen](datenschutz-einstellen.md).
