// The QR module pattern as one SVG path (used by QrCode). Invoices go in upper case so QR can use its denser
// alphanumeric mode (style guide §6); `preserveCase` keeps text whose case matters (an otpauth URI).
import qrcode from 'qrcode-generator';

export function qrPath(value: string, preserveCase = false): { size: number; path: string } {
  const qr = qrcode(0, 'M');
  const text = preserveCase ? value : value.toUpperCase();
  qr.addData(text, /^[0-9A-Z $%*+\-./:]*$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
  }
  return { size: count + 8, path: d };
}
