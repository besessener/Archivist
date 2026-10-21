import { pathOf } from './file-paths';

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** „Eingefügtes Bild 2026-10-21 14-03-12.png“: the clipboard calls every picture „image.png“. */
function pastedImageName(at: Date, ext: string): string {
  const day = `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}`;
  const time = `${twoDigits(at.getHours())}-${twoDigits(at.getMinutes())}-${twoDigits(at.getSeconds())}`;
  return `Eingefügtes Bild ${day} ${time}.${ext}`;
}

/** Files pasted into the chat; none when the clipboard also holds text, since Word or Excel add a picture of copied text. */
export function pastedFiles(clipboard: DataTransfer, at: Date): File[] {
  if (clipboard.getData('text/plain').trim()) return [];
  return Array.from(clipboard.files, (file) => {
    const ext = IMAGE_EXTENSIONS[file.type];
    return ext && !pathOf(file) ? new File([file], pastedImageName(at, ext), { type: file.type }) : file;
  });
}
