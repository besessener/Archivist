import { Notice } from '@/components/common/states';

interface SyncFolderNoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Cloud service that synchronises the archive folder. */
  provider: string | null;
  /** Cloud service that synchronises the data folder (inbox, quarantine, trash). */
  dataProvider?: string | null;
}

/** Warns that the archive or data folder lies in a folder a cloud service synchronises: the documents then also sit, unencrypted, with that provider. */
export function SyncFolderNotice({ provider, dataProvider = null, className, ...rest }: SyncFolderNoticeProps) {
  if (!provider && !dataProvider) return null;
  const onlyData = !provider && dataProvider;
  const title = onlyData ? `Der Datenordner liegt in einem ${dataProvider}-Ordner` : `Der Archivordner liegt in einem ${provider}-Ordner`;
  const names = [provider, dataProvider].filter((name, index, all) => name && all.indexOf(name) === index).join(' und ');
  return (
    <Notice tone="warning" title={title} className={className} {...rest}>
      {names} gleicht {provider && dataProvider ? 'diese Ordner' : 'diesen Ordner'} mit der Cloud ab: Deine Dokumente liegen dann unverschlüsselt auch bei
      diesem Anbieter, obwohl Archivist sonst alles auf diesem Computer hält.
      {provider && dataProvider && ' Das gilt für den Archivordner und den Datenordner.'}
      {onlyData && ' Im Datenordner liegen Eingang, Quarantäne, Papierkorb, Datenbank, Einstellungen und Backups.'}
      {provider && !dataProvider && ' Datenbank, Einstellungen und Backups liegen im Datenordner deines Benutzerprofils.'} Wähle einen Ordner außerhalb der
      Synchronisierung, wenn das nicht gewollt ist.
    </Notice>
  );
}
