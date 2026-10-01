import { MonitorSmartphone } from 'lucide-react';

export function NoBridge() {
  return (
    <div className="flex h-screen items-center justify-center p-6" data-testid="no-bridge">
      <div className="max-w-md text-center">
        <MonitorSmartphone className="mx-auto mb-4 size-10 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold">Bitte Archivist als Desktop-App öffnen</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Diese Oberfläche funktioniert nur innerhalb der Archivist-Desktop-App, weil sie dort auf Ihre lokalen Dokumente und Einstellungen zugreift. Im
          normalen Browser ist keine Verbindung zur App vorhanden.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">Starten Sie Archivist über das Programmsymbol oder mit <code className="rounded bg-muted px-1.5 py-0.5">npm run dev</code> im Projektordner.</p>
      </div>
    </div>
  );
}
