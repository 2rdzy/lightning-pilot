// 144 random bits plus fixed characters meeting the shared password policy. No server or third-party generator.
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const random = crypto.getRandomValues(new Uint8Array(24));
  return 'Aa1!' + Array.from(random, (byte) => alphabet.charAt(byte & 63)).join('');
}
