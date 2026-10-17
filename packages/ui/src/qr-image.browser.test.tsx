// "Scan from a photo" in Chromium: pictures drawn here with the same QR encoder the app shows codes with.
import qrcode from 'qrcode-generator';
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { decodeQrImage, QrImageInput } from './index.ts';
import { expectAccessible } from './testing/axe.ts';

const INVOICE = `lnbcrt10n1p4vmc8jsp5mvnn9mq6y736s6khymg5texrrwg08dg7pq48ff7hng40quzpdn5s${'q'.repeat(40)}`;

// A PNG of the QR code for `text`, `scale` pixels per module, with a four-module quiet zone; optionally dark on light
// inverted, and set into a larger grey frame like part of a photo.
async function qrPicture(text: string, { scale = 6, inverted = false, frame = 0 } = {}): Promise<Blob> {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const side = (count + 8) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = side + 2 * frame;
  canvas.height = side + 2 * frame;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#888';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = inverted ? '#000' : '#fff';
  context.fillRect(frame, frame, side, side);
  context.fillStyle = inverted ? '#fff' : '#000';
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col)) context.fillRect(frame + (col + 4) * scale, frame + (row + 4) * scale, scale, scale);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no blob'))), 'image/png'),
  );
}

describe('decodeQrImage', () => {
  it('reads an invoice from a picture, also inverted and inside a larger photo', async () => {
    expect(await decodeQrImage(await qrPicture(INVOICE))).toBe(INVOICE);
    expect(await decodeQrImage(await qrPicture(INVOICE, { inverted: true }))).toBe(INVOICE);
    expect(await decodeQrImage(await qrPicture(INVOICE, { scale: 20, frame: 800 }))).toBe(INVOICE);
  });

  it('answers undefined for a picture without a code and for a file that is not a picture', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const blank = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'));
    expect(await decodeQrImage(blank)).toBeUndefined();
    expect(await decodeQrImage(new Blob(['not an image'], { type: 'text/plain' }))).toBeUndefined();
  });
});

describe('QrImageInput', () => {
  it('hands the decoded text over, reports a picture without a code, and is accessible', async () => {
    const onDecoded = vi.fn(),
      onNotFound = vi.fn();
    const screen = await render(
      <QrImageInput label="Scan from a photo" busyLabel="Reading…" onDecoded={onDecoded} onNotFound={onNotFound} />,
    );
    const input = screen.getByLabelText('Scan from a photo');
    await expect.element(input).toHaveAttribute('accept', 'image/*');
    await expect.element(input).toHaveAttribute('capture', 'environment');
    await userEvent.upload(input, new File([await qrPicture(INVOICE)], 'invoice.png', { type: 'image/png' }));
    await expect.poll(() => onDecoded.mock.calls.length).toBe(1);
    expect(onDecoded).toHaveBeenCalledWith(INVOICE);
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await expect.poll(() => onNotFound.mock.calls.length).toBe(1);
    await expectAccessible(screen.container);
  });
});
