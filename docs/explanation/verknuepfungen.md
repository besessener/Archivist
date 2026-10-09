# Wie Archivist Wissen verknüpft

Dokumente, Notizen, Entscheidungen, offene Punkte und Ereignisse hängen selten allein. Archivist verbindet sie im Wissensgraph – über gemeinsame Themen, Projekte, Personen und Tags, aber auch direkt: „diese Rechnung stützt jene Entscheidung“, „diese Notiz gehört zu jenem Ereignis“. Die genauen Regeln stehen in der [Referenz](../reference/funktionen.md#verknüpfungen).

## Vorschlagen, nicht entscheiden

Automatisch gefundene Verknüpfungen sind immer nur **Vorschläge**. Ähnlicher Text, derselbe Tag oder dieselbe Nachricht sind gute Hinweise, aber keine Gewissheit. Bestätigen oder ablehnen tust du – einzeln, gebündelt unter Insights oder direkt bei den verwandten Einträgen. Jede Entscheidung ist rückgängig machbar und steht im Änderungsprotokoll.

Feld-Spiegel sind die Ausnahme: Ordnest du einem Dokument das Thema „Steuern“ zu, ist die Beziehung zum Thema schlicht die Abbildung dieses Felds. Sie gilt als bestätigt, aber nicht als „von dir bestätigt“ – das bleibt Beziehungen vorbehalten, über die du tatsächlich entschieden hast.

## Jede Beziehung erklärt sich

Ein Vorschlag ohne Begründung ist schwer zu prüfen. Deshalb trägt jede Beziehung ihre **Herkunft** (System, du, Agent), ihre **Methode** (ähnlicher Inhalt, gleicher Tag + gleiche Person, gemeinsam entstanden, Analyse …) und einen kurzen **Beleg**: die ähnlichste Textstelle, die Chat-Nachricht, aus der beide Einträge stammen, oder „Am 01.09.2026 mit „Anna““.

## Ein Nein gilt

Lehnst du ein Paar ab, schlägt **keine** Methode es wieder vor – egal in welcher Richtung und mit welcher Art von Beziehung. Sonst würde dieselbe Frage nach jedem Indexieren, jeder Analyse und jedem rückwirkenden Lauf zurückkehren. Das Nein überlebt auch das Zusammenführen von Duplikaten. Nur „kein Duplikat“ ist schwächer: Zwei Protokolle können verschieden und trotzdem verwandt sein.

## Erst der Eintrag, dann das Archiv

Verknüpfungen entstehen dort, wo ein Eintrag entsteht oder sich ändert: Er wird gegen den Bestand geprüft, solange du ihn vor dir hast, und die Vorschläge erscheinen bei ihm. Ein Voll-Scan wächst mit dem Archiv, kostet bei jedem Durchlauf dasselbe und liefert Vorschläge ohne Zusammenhang. Der rückwirkende Lauf bleibt als Nachholer für Altbestand und Importe, rührt aber nur an, was noch nicht geprüft ist. Jeder geprüfte Eintrag trägt eine Markierung, die bei einer Änderung oder einer neuen Methode verfällt. Ein neues Dokument macht die alten Einträge nicht ungeprüft: Es wird selbst gegen sie geprüft, und seine Vorschläge zeigen die Verbindung in beide Richtungen.

## Gleich, ähnlich oder verwandt

Identische Dokumente erkennt Archivist an der Prüfsumme der Datei oder des Texts. Ein Entwurf, der nur einen Absatz anders hat, wäre damit unsichtbar. Deshalb gibt es zusätzlich eine Ähnlichkeit über Wortgruppen: Zwei Texte, deren Dreiwort-Gruppen zu etwa 85 % übereinstimmen, gelten als „ähnlicher Inhalt“. Das ist bewusst eine feste, hohe Schwelle: Ähnlicher Inhalt soll Fassungen desselben Texts finden, nicht bloß Dokumente zum selben Thema – dafür sind die Vorschläge unten da. Ein ähnliches Dokument belegt in Antworten keinen eigenen Platz, wird aber nie gelöscht oder verknüpft, ohne dass du entscheidest.

## Warum mehrere Methoden

Jede Methode sieht etwas anderes:

- **Ähnlicher Inhalt** findet Zusammenhänge ohne gemeinsames Thema. Mit lokalen Vektoren ist die Schwelle höher, weil diese nur Wörter vergleichen und sich Texte eines Archivs schon durch gemeinsame Kopfzeilen ähneln (siehe [Wie die Suche funktioniert](suche.md)). Höchstens drei offene Vorschläge je Eintrag halten die Liste prüfbar.
- **Gleicher Tag + gleiche Person** verbindet das Protokoll mit dem Termin und der Entscheidung desselben Tages. Gezählt wird das fachliche Datum, nicht der Tag der Erfassung – sonst wäre alles verwandt, was du an einem Abend nachträgst. Du selbst zählst nicht als gemeinsame Person, sonst hinge fast alles zusammen. An einem vollen Tag wüchse die Zahl der Paare quadratisch; deshalb bleiben je Eintrag höchstens drei offen.
- **Gemeinsam entstanden** hält fest, was eine Nachricht oder ein Dokument gleichzeitig hervorgebracht hat.
- **Die Analyse von Notizen** gibt Notizen Thema, Projekt, Personen und Tags wie Dokumenten. Das LLM wird dafür nur im Modus „automatisch“ gefragt; sonst genügen bekannte Namen und `#Hashtags`.

## Warum höchstens 20 offene Vorschläge

Ein Vorschlag nützt nur, wenn du ihn prüfst. Ein Stapel von Hunderten ungeprüfter Vorschläge wird überblättert, und die guten gehen darin unter. Deshalb legt keine automatische Methode neue an, solange 20 auf dich warten; die Prüfung neuer Einträge wartet, bis du entschieden hast, und geht dann von selbst weiter. Die Mindest-Sicherheit wirkt in dieselbe Richtung: Was darunter liegt, entsteht gar nicht erst, statt die Liste nur unsichtbar zu füllen. Was du selbst anstößt, etwa „Verknüpfungen suchen“ beim Eintrag, zählt nicht dazu: Da schaust du gerade hin.

## Verwandt heißt nicht nur direkt verknüpft

Zwei Einträge mit demselben Projekt und derselben Person gehören oft zusammen, auch ohne direkte Kante. „Verwandte Einträge“ zählt deshalb gemeinsame Knoten mit – gewichtet nach Aussagekraft: ein gemeinsames Projekt sagt mehr als ein gemeinsamer Tag. Knoten mit Hunderten von Einträgen sagen über ein einzelnes Paar wenig und zählen nicht.

## Der Graph in Antworten

Wissensantworten beginnen mit einer Suche. Bestätigte Verknüpfungen der besten Treffer bringen weitere Quellen mit, etwa die Entscheidung, die ein gefundenes Angebot stützt, auch wenn die Frage kein Wort mit ihr teilt. Nur bestätigte Beziehungen zählen: Ein ungeprüfter Vorschlag soll keine Antwort beeinflussen. Unter der Quelle steht, über welche Verknüpfung sie dazukam.
