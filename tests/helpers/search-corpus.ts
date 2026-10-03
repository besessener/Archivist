// Golden corpus of the retrieval-quality test (#255): DE/EN records with same-topic distractors and labelled questions.
export interface GoldenRecord {
  key: string;
  title: string;
  content: string;
}

export type QueryKind = 'exact' | 'inflection' | 'question' | 'paraphrase' | 'synonym' | 'cross-lingual' | 'must-not-match';

export interface GoldenQuery {
  kind: QueryKind;
  query: string;
  relevant: string[];
  /** Records that must not appear in the result (precision check). */
  forbidden?: string[];
}

export const GOLDEN_RECORDS: GoldenRecord[] = [
  // --- Haus & Wohnung (DE) ---
  {
    key: 'heizung-wartung',
    title: 'Wartungsvertrag Heizung',
    content: 'Wir schließen mit der Firma Brenner GmbH einen Wartungsvertrag für die Gasheizung ab. Die Heizung wird jährlich im September geprüft.',
  },
  {
    key: 'heizung-ablesung',
    title: 'Heizungsablesung 2025',
    content: 'Zählerstand der Heizung im Keller abgelesen: 14.582 kWh. Ablesung durch die Hausverwaltung am 31. Dezember.',
  },
  {
    key: 'dach-angebot-meier',
    title: 'Angebot Dachdecker Meier',
    content: 'Dachdecker Meier bietet die Sanierung des Daches mit Holzfaserdämmung für 18.400 Euro an. Das Angebot gilt bis Ende Mai.',
  },
  {
    key: 'dach-angebot-schulz',
    title: 'Angebot Dachdecker Schulz',
    content: 'Dachdecker Schulz bietet die Dachsanierung mit Mineralwolle für 16.900 Euro an. Ausführung frühestens im August.',
  },
  {
    key: 'dach-entscheid',
    title: 'Entscheidung Dachsanierung',
    content: 'Wir haben entschieden, die Dachsanierung an Meier zu vergeben, weil die Holzfaserdämmung im Sommer besser vor Hitze schützt.',
  },
  {
    key: 'zaun-entscheid',
    title: 'Entscheidung Zaun',
    content: 'Der Zaun zum Nachbarn wird aus Lärchenholz gebaut, Höhe 1,60 Meter. Kosten teilen wir uns hälftig mit den Nachbarn.',
  },
  {
    key: 'zaun-streit',
    title: 'Zaun Grenzabstand',
    content: 'Der Nachbar Herr Krause bemängelt den Grenzabstand des alten Zauns. Die Gemeinde hat einen Ortstermin am Montag angesetzt.',
  },
  {
    key: 'fenster-angebot',
    title: 'Fenstertausch Angebot',
    content: 'Die Schreinerei Holz & Glas tauscht fünf Fenster gegen dreifach verglaste Fenster aus. Preis pro Fenster 950 Euro inklusive Einbau.',
  },
  {
    key: 'wasser-rohrbruch',
    title: 'Rohrbruch im Bad',
    content: 'Am Samstag gab es einen Wasserschaden durch einen gebrochenen Rohrstutzen unter dem Waschbecken. Der Installateur kam am selben Abend.',
  },
  {
    key: 'versicherung-gebaeude',
    title: 'Gebäudeversicherung Police',
    content:
      'Die Wohngebäudeversicherung bei der Nordsee Versicherung deckt Feuer, Leitungswasser und Sturm. Jahresbeitrag 612 Euro, Selbstbeteiligung 300 Euro.',
  },
  {
    key: 'versicherung-hausrat',
    title: 'Hausratversicherung',
    content: 'Die Hausratversicherung ist bei der Alpha Direkt abgeschlossen, Versicherungssumme 65.000 Euro, Fahrräder sind mitversichert.',
  },
  {
    key: 'miete-erhoehung',
    title: 'Mieterhöhung Schreiben',
    content: 'Der Vermieter kündigt eine Mieterhöhung um 45 Euro ab dem 1. Juli an. Wir haben zwei Monate Zeit zuzustimmen.',
  },
  {
    key: 'nebenkosten-2024',
    title: 'Nebenkostenabrechnung 2024',
    content: 'Die Nebenkostenabrechnung 2024 ergibt eine Nachzahlung von 238 Euro. Hauptposten sind Müllabfuhr, Wasser und Hausmeister.',
  },
  {
    key: 'solar-planung',
    title: 'Photovoltaik Planung',
    content: 'Eine Photovoltaikanlage mit 9 kWp auf dem Süddach soll rund 8.000 Kilowattstunden pro Jahr erzeugen. Speicher optional.',
  },
  {
    key: 'garten-terrasse',
    title: 'Terrasse Gartenbau',
    content: 'Die Terrasse wird mit Betonplatten belegt, Gartenbau Lindner beginnt im Frühjahr. Regenwasser wird in eine Zisterne geleitet.',
  },
  {
    key: 'schornstein',
    title: 'Schornsteinfeger Termin',
    content: 'Der Schornsteinfeger kommt am 12. März zur Messung der Abgaswerte und zur Kontrolle des Kamins.',
  },
  {
    key: 'umzug',
    title: 'Umzug Checkliste',
    content: 'Umzug im Oktober: Umzugswagen reservieren, Nachsendeantrag stellen, Strom und Internet ummelden, Kartons packen.',
  },
  {
    key: 'parkplatz',
    title: 'Tiefgarage Stellplatz',
    content: 'Der Stellplatz 14 in der Tiefgarage kostet 85 Euro im Monat. Der Mietvertrag für den Stellplatz ist kündbar mit drei Monaten Frist.',
  },

  // --- IT & Arbeit (DE) ---
  {
    key: 'aws-migration',
    title: 'Protokoll Jour Fixe März',
    content: 'Unter Verschiedenes ging es um Parkplätze und den Sommerausflug. Entscheidung: Die AWS-Migration startet im April, Ansprechpartner ist Jana.',
  },
  { key: 'aws-rechnung', title: 'AWS Rechnung Februar', content: 'AWS Rechnung für Konto 4711: EC2 1.230 Euro, S3 310 Euro, Support 100 Euro.' },
  {
    key: 'azure-angebot',
    title: 'Azure Angebot',
    content: 'Microsoft Azure bietet Rabatt auf reservierte Instanzen bei dreijähriger Laufzeit. Vergleich mit AWS steht noch aus.',
  },
  {
    key: 'backup-konzept',
    title: 'Backup Konzept Server',
    content: 'Die Datensicherung läuft nachts um 02:00 Uhr auf das NAS, wöchentlich zusätzlich in die Cloud. Wiederherstellung wird quartalsweise getestet.',
  },
  {
    key: 'passwort-richtlinie',
    title: 'Passwortrichtlinie',
    content: 'Passwörter müssen mindestens 14 Zeichen lang sein. Zwei-Faktor-Authentifizierung ist für alle Administratoren Pflicht.',
  },
  {
    key: 'vpn-zugang',
    title: 'VPN Zugang Homeoffice',
    content: 'Der Zugang zum Firmennetz im Homeoffice erfolgt über WireGuard. Schlüssel werden von der IT-Abteilung ausgegeben.',
  },
  {
    key: 'release-plan',
    title: 'Release Plan Version 3',
    content: 'Version 3.0 wird am 15. Juni veröffentlicht. Feature-Freeze ist zwei Wochen vorher, Fehlerbehebungen danach nur nach Freigabe.',
  },
  {
    key: 'bug-login',
    title: 'Fehlerbericht Anmeldung',
    content: 'Nach dem Update schlägt die Anmeldung mit Fehlercode 401 fehl, wenn das Passwort Sonderzeichen enthält. Ursache ist ein Kodierungsfehler.',
  },
  {
    key: 'jobangebot',
    title: 'Jobangebot Softwareentwickler',
    content: 'Die Firma Datenwerk bietet eine Stelle als Softwareentwickler an. Jahresgehalt 72.000 Euro, 30 Urlaubstage, Gleitzeit.',
  },
  {
    key: 'gehaltsgespraech',
    title: 'Gehaltsgespräch Notizen',
    content: 'Im Gehaltsgespräch wurde eine Erhöhung um vier Prozent zum 1. Januar vereinbart. Bonus abhängig von den Quartalszielen.',
  },
  {
    key: 'urlaub-regel',
    title: 'Urlaubsregelung Team',
    content: 'Urlaub wird mindestens vier Wochen im Voraus im Teamkalender eingetragen. Zwischen Weihnachten und Neujahr ist das Büro geschlossen.',
  },
  {
    key: 'dienstreise',
    title: 'Dienstreise Hamburg',
    content: 'Dienstreise nach Hamburg zum Kundentermin: Zug um 7:12 Uhr, Hotel Elbblick für zwei Nächte, Spesen per Beleg abrechnen.',
  },
  {
    key: 'meeting-kunde',
    title: 'Kundenmeeting Weber AG',
    content: 'Die Weber AG wünscht eine Preisreduzierung von fünf Prozent bei Vertragsverlängerung. Wir antworten bis Freitag.',
  },
  {
    key: 'datenschutz',
    title: 'Datenschutz Verzeichnis',
    content: 'Das Verarbeitungsverzeichnis nach DSGVO wurde aktualisiert. Auftragsverarbeitung mit dem Cloudanbieter ist vertraglich geregelt.',
  },
  {
    key: 'schulung',
    title: 'Schulung Erste Hilfe',
    content: 'Die Erste-Hilfe-Schulung für Ersthelfer findet am 3. Mai im Konferenzraum statt, Dauer acht Stunden.',
  },

  // --- Finanzen & Verträge (DE) ---
  {
    key: 'steuer-2024',
    title: 'Steuererklärung 2024',
    content:
      'Die Einkommensteuererklärung 2024 wurde über Elster abgegeben. Erstattung von 1.140 Euro wird erwartet. Belege zu Werbungskosten liegen im Ordner.',
  },
  {
    key: 'steuer-bescheid',
    title: 'Steuerbescheid Finanzamt',
    content: 'Der Steuerbescheid des Finanzamts weicht in einer Position ab: Das Arbeitszimmer wurde nicht anerkannt. Einspruchsfrist ein Monat.',
  },
  {
    key: 'kredit-bauen',
    title: 'Baufinanzierung Darlehen',
    content: 'Das Immobiliendarlehen über 280.000 Euro hat 3,4 Prozent Zinsen bei zehn Jahren Zinsbindung. Monatliche Rate 1.350 Euro.',
  },
  {
    key: 'strom-tarif',
    title: 'Stromtarif Wechsel',
    content: 'Wechsel zum Ökostromtarif von Sonnenwerk: Arbeitspreis 31 Cent pro Kilowattstunde, Grundpreis 12 Euro, Vertragslaufzeit zwölf Monate.',
  },
  {
    key: 'internet-vertrag',
    title: 'Internetvertrag Kündigung',
    content: 'Der Glasfaservertrag kann zum Monatsende gekündigt werden. Kündigungsfrist vier Wochen, Kündigung schriftlich per Einschreiben.',
  },
  {
    key: 'handy-vertrag',
    title: 'Mobilfunkvertrag',
    content: 'Der Mobilfunktarif mit 20 Gigabyte Datenvolumen kostet 19,99 Euro im Monat und verlängert sich automatisch.',
  },
  {
    key: 'rente',
    title: 'Rentenauskunft',
    content: 'Die Renteninformation der Deutschen Rentenversicherung weist eine voraussichtliche Altersrente von 1.620 Euro aus.',
  },
  { key: 'spenden', title: 'Spendenquittung', content: 'Spendenbescheinigung des Tierheims über 150 Euro für das Jahr 2024, steuerlich absetzbar.' },
  {
    key: 'auto-versicherung',
    title: 'Kfz-Versicherung',
    content: 'Die Autoversicherung wird zum 30. November gekündigt, weil der Beitrag um 18 Prozent gestiegen ist. Neuer Anbieter ist Direktschutz.',
  },
  {
    key: 'auto-tuev',
    title: 'TÜV Termin Auto',
    content: 'Hauptuntersuchung für den Kombi fällig im Juli. Die Bremsbeläge hinten müssen vorher erneuert werden.',
  },

  // --- Gesundheit & Familie (DE) ---
  {
    key: 'zahnarzt',
    title: 'Zahnarzt Termin',
    content: 'Zahnarztkontrolle und professionelle Zahnreinigung am Dienstag um 9:30 Uhr in der Praxis Dr. Lehmann.',
  },
  {
    key: 'impfung',
    title: 'Impfpass Auffrischung',
    content: 'Die Tetanus-Impfung muss im nächsten Jahr aufgefrischt werden. Grippeimpfung im Herbst beim Hausarzt.',
  },
  {
    key: 'allergie',
    title: 'Allergietest Ergebnis',
    content: 'Der Allergietest zeigt eine Allergie gegen Birkenpollen und Hausstaubmilben. Empfohlen werden Antihistaminika im Frühjahr.',
  },
  {
    key: 'kita',
    title: 'Kita Anmeldung',
    content: 'Anmeldung für den Kindergartenplatz: Unterlagen bis 15. Februar abgeben. Der Betreuungsvertrag beginnt zum 1. August.',
  },
  {
    key: 'schule-elternabend',
    title: 'Elternabend Grundschule',
    content: 'Beim Elternabend der Klasse 3b wurde der Wandertag auf den 20. Juni gelegt. Elternsprecherin ist Frau Yilmaz.',
  },
  {
    key: 'geburtstag',
    title: 'Geburtstagsfeier Planung',
    content: 'Geburtstagsfeier für Oma am Samstag um 15 Uhr. Kuchen bestellen, Gäste einladen, Tisch im Garten decken.',
  },
  {
    key: 'rezept-linsen',
    title: 'Rezept Linsensuppe',
    content: 'Linsensuppe mit Karotten, Sellerie und Würstchen: Zutaten anbraten, mit Brühe ablöschen und 30 Minuten köcheln lassen.',
  },
  {
    key: 'fahrrad',
    title: 'Fahrrad Reparatur',
    content: 'Das Rad braucht einen neuen Schlauch und eine neue Kette. Die Werkstatt Radhaus hat bis Donnerstag Zeit.',
  },

  // --- Reisen (DE) ---
  {
    key: 'urlaub-italien',
    title: 'Urlaub Italien Buchung',
    content: 'Ferienhaus in der Toskana vom 5. bis 19. August gebucht. Anzahlung von 400 Euro ist überwiesen. Schlüsselübergabe ab 16 Uhr.',
  },
  {
    key: 'flug-lissabon',
    title: 'Flugbuchung Lissabon',
    content: 'Hinflug nach Lissabon am 2. April um 6:45 Uhr, Rückflug am 6. April. Nur Handgepäck, Sitzplätze 14A und 14B.',
  },
  {
    key: 'reisepass',
    title: 'Reisepass verlängern',
    content: 'Der Reisepass läuft im November ab. Neuer Pass muss beim Bürgeramt beantragt werden, Bearbeitungszeit etwa vier Wochen.',
  },
  { key: 'bahncard', title: 'BahnCard Abo', content: 'Die BahnCard 50 verlängert sich automatisch, wenn nicht sechs Wochen vor Ablauf gekündigt wird.' },

  // --- Wiki / Notizen / Entscheidungen (DE) ---
  {
    key: 'entsch-tool',
    title: 'Entscheidung Projektwerkzeug',
    content: 'Wir verwenden künftig Linear statt Jira für die Aufgabenverwaltung, weil es schneller ist und weniger Pflegeaufwand hat.',
  },
  {
    key: 'entsch-sprache',
    title: 'Entscheidung Programmiersprache',
    content: 'Das neue Backend wird in TypeScript geschrieben, damit Frontend und Backend dieselben Typen teilen.',
  },
  {
    key: 'entsch-budget',
    title: 'Entscheidung Budget Marketing',
    content: 'Das Marketingbudget wird für das zweite Quartal auf 25.000 Euro gedeckelt. Mehrausgaben müssen von der Geschäftsführung freigegeben werden.',
  },
  {
    key: 'entsch-urlaubsziel',
    title: 'Entscheidung Urlaubsziel',
    content: 'Wir fahren dieses Jahr in die Toskana und nicht an die Ostsee, weil das Wetter im August verlässlicher ist.',
  },
  {
    key: 'entsch-auto',
    title: 'Entscheidung Elektroauto',
    content: 'Wir kaufen kein Elektroauto, solange keine Wallbox in der Tiefgarage installiert werden darf.',
  },
  { key: 'lernen-spanisch', title: 'Spanisch lernen', content: 'Spanischkurs jeden Mittwochabend an der Volkshochschule. Vokabeln täglich zehn Minuten üben.' },
  {
    key: 'buchliste',
    title: 'Leseliste',
    content: 'Bücher für den Sommer: ein Roman von Judith Hermann, ein Sachbuch über Bienen und der neue Krimi von Jan Costin Wagner.',
  },
  { key: 'garten-tomaten', title: 'Tomaten anbauen', content: 'Tomaten im Gewächshaus ab Mitte Mai auspflanzen, regelmäßig ausgeizen und gleichmäßig gießen.' },

  // --- English: house ---
  {
    key: 'en-lease',
    title: 'Apartment lease renewal',
    content: 'The landlord offers a lease renewal for twelve months with rent increase of 3 percent. Please sign and return by the end of the month.',
  },
  {
    key: 'en-mortgage',
    title: 'Mortgage statement',
    content: 'Your mortgage balance is 214,300 dollars at a fixed interest rate of 4.1 percent. Next payment is due on the first of the month.',
  },
  {
    key: 'en-roof',
    title: 'Roof repair estimate',
    content: 'The contractor estimates the roof repair at 7,800 dollars including new shingles and gutters. Work takes about three days.',
  },
  {
    key: 'en-boiler',
    title: 'Boiler service report',
    content: 'Annual boiler service completed. The heating system pressure was adjusted and the thermostat was replaced.',
  },
  {
    key: 'en-insurance',
    title: 'Home insurance policy',
    content: 'Home insurance covers fire, theft and water damage up to 400,000 dollars. The deductible is 1,000 dollars per claim.',
  },
  { key: 'en-fence', title: 'Fence permit', content: 'The city issued a permit for a wooden fence along the back yard, maximum height six feet.' },

  // --- English: work ---
  {
    key: 'en-offer-letter',
    title: 'Offer letter Senior Engineer',
    content: 'We are pleased to offer you the position of Senior Engineer with an annual salary of 110,000 dollars and 25 vacation days.',
  },
  {
    key: 'en-quarterly-review',
    title: 'Quarterly business review',
    content: 'Revenue grew 12 percent quarter over quarter. Churn dropped to 2.1 percent after the onboarding redesign.',
  },
  {
    key: 'en-security-policy',
    title: 'Security incident policy',
    content: 'Security incidents must be reported to the security team within 24 hours. Affected laptops are isolated from the network immediately.',
  },
  {
    key: 'en-onboarding',
    title: 'New hire onboarding checklist',
    content: 'On the first day new employees receive a laptop, badge and accounts. Mentor sessions are scheduled for the first four weeks.',
  },
  {
    key: 'en-decision-db',
    title: 'Decision: database choice',
    content: 'We decided to use PostgreSQL instead of MongoDB because the data is relational and the team already has experience with it.',
  },
  {
    key: 'en-decision-vendor',
    title: 'Decision: vendor selection',
    content: 'The steering committee selected Northwind as logistics vendor because of lower delivery times and a better service level agreement.',
  },
  {
    key: 'en-expense',
    title: 'Expense report policy',
    content: 'Expense reports must be submitted within thirty days. Receipts are required for every purchase above 25 dollars.',
  },
  {
    key: 'en-offsite',
    title: 'Team offsite agenda',
    content: 'The team offsite in Denver starts Monday with a strategy workshop, followed by dinner and a hiking day on Wednesday.',
  },
  {
    key: 'en-api-docs',
    title: 'API rate limits',
    content: 'The public API allows 100 requests per minute per key. Requests above the limit receive HTTP status 429.',
  },
  {
    key: 'en-postmortem',
    title: 'Postmortem outage',
    content: 'The outage lasted 47 minutes and was caused by an expired certificate on the load balancer. Monitoring now alerts 30 days before expiry.',
  },

  // --- English: finance, health, travel, misc ---
  {
    key: 'en-tax',
    title: 'Tax return 2024',
    content: 'The federal tax return for 2024 was filed electronically. A refund of 890 dollars is expected within three weeks.',
  },
  {
    key: 'en-bank',
    title: 'Bank statement March',
    content: 'Account statement for March: salary deposit 4,200 dollars, rent 1,650 dollars, groceries 480 dollars.',
  },
  {
    key: 'en-car-insurance',
    title: 'Car insurance renewal',
    content: 'The auto insurance premium rises to 1,320 dollars per year. Switching provider could save about 200 dollars.',
  },
  {
    key: 'en-dentist',
    title: 'Dentist appointment',
    content: 'Dental checkup and cleaning on Thursday at 2 pm at Bright Smile Clinic. Bring the insurance card.',
  },
  { key: 'en-vaccine', title: 'Vaccination record', content: 'Flu shot received in October. The next tetanus booster is due in 2027.' },
  {
    key: 'en-flight',
    title: 'Flight confirmation Boston',
    content: 'Flight to Boston departs on May 9 at 8:15 am. Check-in opens 24 hours before departure, one checked bag included.',
  },
  {
    key: 'en-hotel',
    title: 'Hotel reservation Paris',
    content: 'Reservation at Hotel Lumiere in Paris for four nights from June 3. Breakfast included, free cancellation until May 30.',
  },
  {
    key: 'en-passport',
    title: 'Passport renewal',
    content: 'Passport renewal application submitted. Processing takes six to eight weeks, expedited service costs 60 dollars extra.',
  },
  {
    key: 'en-recipe',
    title: 'Recipe pancakes',
    content: 'Pancakes: mix flour, milk and eggs, rest the batter for twenty minutes, fry in butter until golden.',
  },
  {
    key: 'en-book',
    title: 'Reading list',
    content: 'Books to read this year: a history of the Roman Empire, a novel by Ursula Le Guin and a guide to beekeeping.',
  },
  { key: 'en-gym', title: 'Gym membership', content: 'The gym membership costs 39 dollars a month and can be cancelled with thirty days notice.' },
  { key: 'en-warranty', title: 'Laptop warranty', content: 'The laptop warranty covers hardware defects for three years. Battery degradation is excluded.' },
  {
    key: 'en-phone-plan',
    title: 'Phone plan',
    content: 'The unlimited data phone plan costs 55 dollars per month and includes international roaming in Europe.',
  },
  {
    key: 'en-school',
    title: 'School newsletter',
    content: 'The school newsletter announces the science fair on March 14 and a parent teacher conference the week after.',
  },
  { key: 'en-garden', title: 'Garden plan', content: 'Plant tomatoes and peppers in late May. Compost the beds in April and install drip irrigation.' },
  {
    key: 'en-moving',
    title: 'Moving checklist',
    content: 'Moving in September: book the moving truck, forward the mail, transfer electricity and internet, pack boxes by room.',
  },
  { key: 'en-donation', title: 'Donation receipt', content: 'Receipt for a charitable donation of 200 dollars to the food bank, deductible for tax purposes.' },
  { key: 'en-bike', title: 'Bike repair', content: 'The bike needs new brake pads and a new chain. The repair shop will call when it is ready.' },
  {
    key: 'en-birthday',
    title: 'Birthday party planning',
    content: 'Birthday party for Sam on Saturday at 3 pm. Order the cake, send invitations and decorate the backyard.',
  },
  {
    key: 'en-spanish',
    title: 'Learning Spanish',
    content: 'Spanish class every Wednesday evening at the community college. Practice vocabulary for ten minutes daily.',
  },
  {
    key: 'en-solar',
    title: 'Solar panel quote',
    content: 'The solar installer quotes a 7 kW system producing about 9,000 kilowatt hours per year, payback in nine years.',
  },
  { key: 'en-electric-car', title: 'Electric vehicle decision', content: 'We will buy an electric vehicle once the building allows a charger in the garage.' },
  {
    key: 'en-internet',
    title: 'Internet provider contract',
    content: 'The fiber internet contract renews automatically. Cancel in writing at least thirty days before the end of the term.',
  },
  {
    key: 'en-electricity',
    title: 'Electricity tariff',
    content: 'Green electricity tariff at 0.18 dollars per kilowatt hour with a twelve month contract and monthly base fee of 9 dollars.',
  },
];

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // exact keywords from the record
  { kind: 'exact', query: 'Rohrbruch', relevant: ['wasser-rohrbruch'] },
  { kind: 'exact', query: 'Schornsteinfeger', relevant: ['schornstein'] },
  { kind: 'exact', query: 'WireGuard', relevant: ['vpn-zugang'] },
  { kind: 'exact', query: 'Linsensuppe', relevant: ['rezept-linsen'] },
  { kind: 'exact', query: 'Northwind', relevant: ['en-decision-vendor'] },
  { kind: 'exact', query: 'certificate expired load balancer', relevant: ['en-postmortem'] },
  { kind: 'exact', query: 'Dachdecker Meier Angebot', relevant: ['dach-angebot-meier', 'dach-entscheid'] },
  { kind: 'exact', query: 'Brenner GmbH', relevant: ['heizung-wartung'] },

  // inflected / compound forms
  { kind: 'inflection', query: 'Versicherungen', relevant: ['versicherung-gebaeude', 'versicherung-hausrat', 'auto-versicherung'] },
  { kind: 'inflection', query: 'Fenstern', relevant: ['fenster-angebot'] },
  { kind: 'inflection', query: 'Impfungen', relevant: ['impfung'] },
  { kind: 'inflection', query: 'Kündigungsfristen', relevant: ['internet-vertrag', 'parkplatz', 'bahncard'] },
  { kind: 'inflection', query: 'cancelling contracts', relevant: ['en-internet', 'en-gym'] },
  { kind: 'inflection', query: 'flights', relevant: ['en-flight'] },

  // questions with filler words
  { kind: 'question', query: 'Was wurde zur AWS Migration entschieden?', relevant: ['aws-migration'] },
  { kind: 'question', query: 'Wann kommt der Schornsteinfeger?', relevant: ['schornstein'] },
  { kind: 'question', query: 'Wie hoch ist der Jahresbeitrag der Gebäudeversicherung?', relevant: ['versicherung-gebaeude'] },
  { kind: 'question', query: 'Warum haben wir uns für Meier beim Dach entschieden?', relevant: ['dach-entscheid'] },
  { kind: 'question', query: 'Which database did we decide to use?', relevant: ['en-decision-db'] },
  { kind: 'question', query: 'When does the flight to Boston depart?', relevant: ['en-flight'] },
  { kind: 'question', query: 'How long was the outage?', relevant: ['en-postmortem'] },

  // paraphrases: no or few shared words
  { kind: 'paraphrase', query: 'Wasserschaden im Badezimmer', relevant: ['wasser-rohrbruch'] },
  { kind: 'paraphrase', query: 'Sicherungskopien der Daten', relevant: ['backup-konzept'] },
  { kind: 'paraphrase', query: 'Zugang von zu Hause ins Firmennetz', relevant: ['vpn-zugang'] },
  { kind: 'paraphrase', query: 'Fahrzeug TÜV Prüfung', relevant: ['auto-tuev'] },
  { kind: 'paraphrase', query: 'Wie viel Gehalt bietet Datenwerk?', relevant: ['jobangebot'] },
  { kind: 'paraphrase', query: 'money back from the tax office', relevant: ['en-tax'] },
  { kind: 'paraphrase', query: 'cost of fixing the roof', relevant: ['en-roof'] },

  // synonyms
  { kind: 'synonym', query: 'Hausarzt Spritze Tetanus', relevant: ['impfung'] },
  { kind: 'synonym', query: 'Kindertagesstätte Platz', relevant: ['kita'] },
  { kind: 'synonym', query: 'Wohnung Mieterhöhung Vermieter', relevant: ['miete-erhoehung'] },
  { kind: 'synonym', query: 'Pkw Haftpflicht kündigen', relevant: ['auto-versicherung'] },
  { kind: 'synonym', query: 'automobile coverage price increase', relevant: ['en-car-insurance'] },
  { kind: 'synonym', query: 'workout club fee', relevant: ['en-gym'] },

  // cross-lingual (query language differs from the record language)
  { kind: 'cross-lingual', query: 'roof repair', relevant: ['dach-angebot-meier', 'dach-angebot-schulz', 'dach-entscheid', 'en-roof'] },
  { kind: 'cross-lingual', query: 'Dachreparatur Kostenvoranschlag', relevant: ['en-roof'] },
  { kind: 'cross-lingual', query: 'passport expires', relevant: ['reisepass', 'en-passport'] },
  { kind: 'cross-lingual', query: 'Elektroauto Ladestation Garage', relevant: ['en-electric-car', 'entsch-auto'] },
  { kind: 'cross-lingual', query: 'dentist', relevant: ['zahnarzt', 'en-dentist'] },
  { kind: 'cross-lingual', query: 'Steuererstattung', relevant: ['steuer-2024', 'en-tax'] },
  { kind: 'cross-lingual', query: 'Solaranlage Angebot', relevant: ['en-solar', 'solar-planung'] },
  { kind: 'cross-lingual', query: 'Kündigung Fitnessstudio', relevant: ['en-gym'] },

  // must-not-match: nothing in the corpus answers these
  { kind: 'must-not-match', query: 'Quantenphysik Teilchenbeschleuniger', relevant: [], forbidden: ['aws-migration', 'solar-planung', 'en-api-docs'] },
  { kind: 'must-not-match', query: 'Zebrastreifen Schwimmbad Marsmission', relevant: [], forbidden: ['zaun-entscheid', 'urlaub-italien', 'en-offsite'] },
  { kind: 'must-not-match', query: 'submarine volcano telescope', relevant: [], forbidden: ['en-roof', 'en-flight', 'en-postmortem'] },
  { kind: 'must-not-match', query: 'Dachdecker Meier Angebot', relevant: ['dach-angebot-meier'], forbidden: ['zaun-entscheid', 'en-roof', 'schornstein'] },
  { kind: 'must-not-match', query: 'Heizung Ablesung Zählerstand', relevant: ['heizung-ablesung'], forbidden: ['en-boiler', 'solar-planung', 'schornstein'] },
];
