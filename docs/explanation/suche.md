# Wie die Suche funktioniert

Archivist sucht **hybrid**: eine Stichwortsuche (SQLite FTS5) und eine Vektorsuche (Cosine-Ähnlichkeit) laufen parallel, ihre Ergebnislisten werden per Reciprocal Rank Fusion zusammengeführt. Die genauen Regeln stehen in der [Referenz](../reference/funktionen.md#suche).

## Warum zwei Verfahren

Stichwortsuche ist präzise und erklärbar: Steht „Mietvertrag“ im Dokument, wird es gefunden. Sie versagt aber bei anderen Formulierungen. Deshalb werden Suchbegriffe leicht gestemmt und als Präfix gesucht („Entscheidungen“ findet „entscheiden“), Frage- und Füllwörter ignoriert und Treffer mit mehr verschiedenen Suchbegriffen nach vorn sortiert.

Vektorsuche findet Ähnliches, auch ohne gemeinsames Wort – wenn die Vektoren echte Bedeutung tragen. Genau das ist der Haken.

## Lokale Vektoren sind ehrlich lexikalisch

Ohne konfiguriertes Embedding-Modell nutzt Archivist **lokale Feature-Hashing-Vektoren** aus Wörtern und Zeichen-Trigrammen. Sie sind offline, deterministisch und für vertrauliche Dokumente geeignet, aber kein semantisches Modell: Sie erkennen Schreibvarianten, nicht Bedeutung.

Deshalb stimmen sie bei der Rangfolge **nicht mit ab**. Sie ergänzen nur Einträge, die die Stichwortsuche gar nicht gefunden hat. Würden sie mitstimmen, würden lexikalisch ähnliche, aber irrelevante Treffer gute Stichworttreffer verdrängen.

Mit einem konfigurierten Embedding-Modell (`/embeddings`) kommen echte Embeddings hinzu, die mit abstimmen – sofern der Datenschutzmodus es erlaubt. Im Modus `confirm` bleiben Suchindex und Suchanfragen lokal, weil sonst jeder Suchbegriff und jedes Dokument an den Embedding-Endpunkt ginge. Antwortet der Endpunkt nicht innerhalb von 2,5 s, liefert die Suche die lokalen Treffer – eine langsame Cloud soll die Suche nicht blockieren; die Spur dafür ist nur eine Warnung im Protokoll, die der Agent mit `read_logs` und `diagnose` findet. Je Eintrag gehen höchstens `llm.maxInputChars` Zeichen in Summe an den Endpunkt (Abschnitte von vorn, nur vollständige), damit die Freigabe nicht stillschweigend das ganze Dokument meint; die übrigen Abschnitte behalten ihre lokalen Vektoren. Scheitert der Endpunkt beim Indexieren, nimmt Archivist für diese Texte lokale Vektoren und vermerkt das im Protokoll.

Neben jedem echten Vektor speichert Archivist einen lokalen. So bleibt ein Eintrag auch dann semantisch auffindbar, wenn der Endpunkt gerade nicht erreichbar ist oder später wegfällt; ältere Einträge ohne lokalen Vektor bekommen ihn nach dem Update einmal im Hintergrund. Eigene Einträge – Entscheidungen, Notizen, offene Punkte und Ereignisse – bettet Archivist nur im Modus `auto` mit dem Embedding-Modell ein, Dokumente nur in diesem Modus und nur, wenn sie extern analysiert werden dürfen. Beim Wechsel des Embedding-Modells bettet ein Job genau die Einträge neu ein, die danach anders eingebettet wären. Fällt der Endpunkt dabei aus, bricht der Job mit der Zahl der tatsächlich umgestellten Einträge ab und versucht es später erneut, statt lokale Ersatzvektoren als Erfolg zu zählen.

## Warum kein `sqlite-vec`

Eine Vektor-Erweiterung für SQLite wäre naheliegend, ist aber ein weiteres natives Modul mit Packaging-Risiko. Stattdessen liegen Embeddings als BLOB in SQLite und werden beim ersten Suchen pro Modell einmal (ohne Texte) in einen Vektorindex im Speicher geladen, der beim Indexieren und Entfernen mitgeführt wird.

Die Vektoren liegen in `SharedArrayBuffer`-Segmenten, die Worker-Threads ohne Kopie lesen. Pro Suchanfrage wird nur der Anfragevektor übergeben; die Cosine-Ähnlichkeit läuft segmentweise parallel im Worker-Pool. Für ein persönliches Archiv ist diese vollständige Suche schnell genug und braucht keinen Näherungsindex.
