// "Scan from a photo" (catalogue D2): a file input that reads a QR code from a picture. On a phone `capture` opens
// the camera app, so this works without getUserMedia, which the server's Permissions-Policy (camera=()) forbids.
// jsQR decodes in the browser everywhere; BarcodeDetector is missing in Firefox and in Chromium on Linux.
import jsQR from 'jsqr';
import { ScanLine } from 'lucide-react';
import { useId, useState } from 'react';
import { cx } from './cx.ts';

// Large photos are scaled down first: jsQR's time grows with the pixel count, and a QR code that fills part of a
// phone photo is still readable at this size.
const MAX_SIDE = 1600;

// The text of the first QR code in the picture, or undefined when there is none (or the file is not an image).
export async function decodeQrImage(file: Blob): Promise<string | undefined> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return undefined;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height);
  return jsQR(pixels.data, width, height, { inversionAttempts: 'attemptBoth' })?.data || undefined;
}

export function QrImageInput({
  label,
  busyLabel,
  onDecoded,
  onNotFound,
  disabled = false,
}: {
  label: string;
  busyLabel: string;
  onDecoded: (text: string) => void;
  onNotFound: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const off = disabled || busy;
  return (
    <div>
      {/* The input stays in the accessibility tree (sr-only, not display:none) so the label activates it. */}
      <input
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        className="peer sr-only"
        disabled={off}
        data-testid="qr-image-input"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (!file) return;
          setBusy(true);
          void decodeQrImage(file)
            .then((text) => (text === undefined ? onNotFound() : onDecoded(text)))
            .finally(() => {
              setBusy(false);
              // The same picture chosen again must fire another change.
              input.value = '';
            });
        }}
      />
      <label
        htmlFor={id}
        className={cx(
          'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-border',
          'bg-surface px-4 py-2 text-sm font-medium text-text hover:border-muted',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand',
          off && 'cursor-not-allowed opacity-60',
        )}
      >
        <ScanLine size={16} aria-hidden="true" />
        {busy ? busyLabel : label}
      </label>
    </div>
  );
}
