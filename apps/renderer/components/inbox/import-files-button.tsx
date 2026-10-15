'use client';

import { useRef } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/lib/app-context';
import { SUPPORTED_EXTENSIONS_ACCEPT, SUPPORTED_TYPES_TEXT } from '@/lib/labels';

/** Plain import into the inbox, without a chat message; the same as dropping the files on this page. */
export function ImportFilesButton() {
  const { importFiles } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={SUPPORTED_EXTENSIONS_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        data-testid="inbox-file-input"
        aria-label="Dateien importieren"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) void importFiles(files);
        }}
      />
      <Button
        variant="outline"
        title={`Dateien in die Inbox importieren (${SUPPORTED_TYPES_TEXT})`}
        data-testid="inbox-file-pick"
        onClick={() => fileRef.current?.click()}
      >
        <FileUp aria-hidden /> Dateien importieren
      </Button>
    </>
  );
}
