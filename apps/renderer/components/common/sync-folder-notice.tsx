import { Notice } from '@/components/common/states';

/** Warns that the archive folder lies in a folder a cloud service synchronises: the documents then also sit, unencrypted, with that provider. */
export function SyncFolderNotice({ provider, className, ...rest }: { provider: string | null; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  if (!provider) return null;
  return (
    <Notice tone="warning" title={`Der Archivordner liegt in einem ${provider}-Ordner`} className={className} {...rest}>
      {provider} gleicht diesen Ordner mit der Cloud ab: Deine Dokumente liegen dann unverschlüsselt auch bei diesem Anbieter, obwohl Archivist sonst alles auf
      diesem Computer hält. Wähle einen Ordner außerhalb der Synchronisierung, wenn das nicht gewollt ist. Datenbank, Einstellungen und Backups liegen im
      Datenordner deines Benutzerprofils.
    </Notice>
  );
}
