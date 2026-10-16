// QR code as SVG built from React elements (no HTML strings, nothing inline the CSP would refuse). Large, high
// contrast, always dark on white whatever the theme, with a quiet zone of four modules (style guide §6). Invoices
// go in upper case so QR can use its denser alphanumeric mode.
import { useMemo } from 'react';
import { qrPath } from './qr.ts';
import { CopyButton, type CopyLabels } from './values.tsx';

export function QrCode({
  value,
  label,
  preserveCase = false,
  testId = 'qr',
}: {
  value: string;
  label: string;
  preserveCase?: boolean;
  testId?: string;
}) {
  const { size, path } = useMemo(() => qrPath(value, preserveCase), [value, preserveCase]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="h-auto w-full max-w-72 rounded-control bg-white"
      shapeRendering="crispEdges"
      data-testid={testId}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

// The QR pattern of style guide §6: the code, the text below it and a copy button.
export function QrBlock({
  value,
  label,
  copyLabels,
  preserveCase = false,
  textTestId,
}: {
  value: string;
  label: string;
  copyLabels: CopyLabels;
  preserveCase?: boolean;
  textTestId?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <QrCode value={value} label={label} preserveCase={preserveCase} />
      <p className="max-w-full font-mono text-xs break-all" data-testid={textTestId}>
        {value}
      </p>
      <CopyButton value={value} labels={copyLabels} />
    </div>
  );
}
