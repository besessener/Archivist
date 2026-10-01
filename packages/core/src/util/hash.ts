import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex');
