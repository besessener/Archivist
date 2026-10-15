import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ASK_USER } from '../../packages/core/src/agent/ask-user';
import { imageNote, previewOf, userParts } from '../../packages/core/src/agent/adapters/common';
import { toAnthropicMessages } from '../../packages/core/src/agent/adapters/anthropic';
import { toResponsesInput } from '../../packages/core/src/agent/adapters/openai';
import { WITHHELD_ATTACHMENT, withholdWithdrawn } from '../../packages/core/src/agent/history-privacy';
import { userTurn } from '../../packages/core/src/agent/history-window';
import type { AgentAttachment, AgentMessage } from '../../packages/core/src/agent/types';
import { MODEL_IMAGE_EDGE, prepareModelImage, type ModelImage } from '../../packages/core/src/parsers/model-image';
import { call } from '../helpers/agent-runner';
import { writeFile } from '../helpers/fixtures';

const photo: AgentAttachment = { documentId: 'doc-1', ref: 'D1', text: 'Angehängt: D1 „foto.png“', image: true };
const note: AgentAttachment = { documentId: 'doc-2', ref: 'D2', text: 'Angehängt: D2 „notiz.txt“', image: false };
const picture: ModelImage = { mediaType: 'image/jpeg', data: 'QUJD' };
const images = new Map([['doc-1', picture]]);
const withAttachments = (content: string, attachments: AgentAttachment[]): AgentMessage => ({ role: 'user', content, attachments });

describe('user parts of a message with attachments', () => {
  it('text, then each attachment, its picture only while the run has it', () => {
    const message = withAttachments('Was ist das?', [photo, note]);
    expect(userParts(message as Extract<AgentMessage, { role: 'user' }>, images)).toEqual([
      { kind: 'text', text: 'Was ist das?' },
      { kind: 'text', text: photo.text },
      { kind: 'image', image: picture },
      { kind: 'text', text: note.text },
    ]);
    expect(userParts(message as Extract<AgentMessage, { role: 'user' }>, undefined).map((p) => p.kind)).toEqual(['text', 'text', 'text']);
  });

  it('a message with only attachments has no empty text part; a plain message stays one text', () => {
    expect(userParts(withAttachments('', [note]) as Extract<AgentMessage, { role: 'user' }>, images)).toEqual([{ kind: 'text', text: note.text }]);
    expect(userParts({ role: 'user', content: '' }, images)).toEqual([{ kind: 'text', text: '' }]);
  });

  it('the transmission note counts the pictures of a request; the preview falls back to the attachments', () => {
    const messages = [withAttachments('', [photo])];
    expect(imageNote({ messages, images })).toEqual({ note: '1 Bild übertragen – Bildinhalte werden nicht maskiert' });
    expect(imageNote({ messages: [withAttachments('', [photo, { ...photo, documentId: 'doc-1' }])], images }).note).toMatch(/^2 Bilder/);
    expect(imageNote({ messages })).toEqual({});
    expect(previewOf(messages)).toBe(photo.text);
  });

  it('OpenAI: input_text and input_image with a data URL; Claude: text and base64 image blocks', () => {
    const messages = [withAttachments('Was ist das?', [photo])];
    expect(toResponsesInput(messages, { model: 'gpt-5', images })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Was ist das?' },
          { type: 'input_text', text: photo.text },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
        ],
      },
    ]);
    expect(toAnthropicMessages(messages, { model: 'claude-opus-5-5', images })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Was ist das?' },
          { type: 'text', text: photo.text },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        ],
      },
    ]);
  });
});

describe('user turn with attachments', () => {
  it('a plain turn carries the attachments; without any the message has no attachments field', () => {
    expect(userTurn([], { masked: 'Hallo', attachments: [note] }).messages).toEqual([{ role: 'user', content: 'Hallo', attachments: [note] }]);
    expect(userTurn([], { masked: 'Hallo', attachments: [] }).messages).toEqual([{ role: 'user', content: 'Hallo' }]);
  });

  it('answering an open question keeps the attachments in a user message after the answer', () => {
    const turn = userTurn([call(ASK_USER, { question: 'Welche Datei?' }, 'q1')], { masked: 'Diese hier', attachments: [note] });
    expect(turn.answersQuestion).toBe(true);
    expect(turn.messages).toEqual([
      { role: 'tool', results: [{ callId: 'q1', name: ASK_USER, content: 'Antwort des Benutzers: Diese hier', isError: false }] },
      { role: 'user', content: '', attachments: [note] },
    ]);
  });
});

describe('replay of withdrawn attachments', () => {
  it('replaces the text of a withdrawn attachment and drops its picture; others stay', () => {
    const history: AgentMessage[] = [withAttachments('Sieh dir das an', [photo, note])];
    const [message] = withholdWithdrawn(history, new Set(['D1']));
    expect(message).toEqual(withAttachments('Sieh dir das an', [{ ...photo, text: `D1: ${WITHHELD_ATTACHMENT}`, image: false }, note]));
    expect(withholdWithdrawn(history, new Set(['D7']))[0]).toBe(history[0]);
  });
});

describe('pictures for a vision model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-model-image-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('shrinks to the longest edge, keeps small ones, re-encodes as JPEG without EXIF and flattens transparency', async () => {
    const large = writeFile(
      dir,
      'gross.png',
      await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .png()
        .toBuffer(),
    );
    const image = await prepareModelImage(large);
    expect(image.mediaType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(image.data, 'base64')).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: MODEL_IMAGE_EDGE, height: Math.round(MODEL_IMAGE_EDGE / 3), hasAlpha: false });
    expect(meta.exif).toBeUndefined();
    const { data } = await sharp(Buffer.from(image.data, 'base64')).raw().toBuffer({ resolveWithObject: true });
    expect(data[0], 'transparent pixels become white').toBeGreaterThan(240);

    const small = writeFile(
      dir,
      'klein.jpg',
      await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .withExif({ IFD0: { Copyright: 'Geheim' } })
        .jpeg()
        .toBuffer(),
    );
    const kept = await sharp(Buffer.from((await prepareModelImage(small)).data, 'base64')).metadata();
    expect(kept).toMatchObject({ width: 40, height: 30 });
    expect(kept.exif).toBeUndefined();
  });
});
