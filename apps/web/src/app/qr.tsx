// QR code as SVG built from React elements (no HTML strings, nothing inline the CSP would refuse). Large, high
// contrast, always dark on white whatever the theme, with a quiet zone of four modules.
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    // Upper case lets QR use its denser alphanumeric mode for bech32 invoices (style guide §6).
    const upper = value.toUpperCase();
    qr.addData(upper, /^[0-9A-Z $%*+\-./:]*$/.test(upper) ? 'Alphanumeric' : 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
    return { size: count + 8, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="h-auto w-full max-w-72 rounded-control bg-white"
      shapeRendering="crispEdges"
      data-testid="qr"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
