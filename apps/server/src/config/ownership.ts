import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// Bind-mounted files may retain a host UID. Accept that only on a genuinely read-only mount.
export function isReadOnlyMount(path: string, mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')): boolean {
  let longest = -1;
  let readOnly = false;
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (!mount || (path !== mount && !path.startsWith(mount === '/' ? '/' : mount + sep))) continue;
    if (mount.length > longest) {
      longest = mount.length;
      readOnly = fields[5]?.split(',').includes('ro') ?? false;
    }
  }
  return readOnly;
}

export function assertProtectedFile(path: string, owner = 0, allowReadOnly = true): void {
  let current = resolve(path);
  if (!lstatSync(current).isFile()) throw new Error(`unsafe file ${path}: expected a regular file`);
  for (;;) {
    const stat = lstatSync(current);
    let mountedReadOnly = false;
    if (allowReadOnly && process.platform === 'linux') mountedReadOnly = isReadOnlyMount(realpathSync(current));
    if (
      stat.isSymbolicLink() ||
      (!mountedReadOnly && ((stat.uid !== owner && stat.uid !== 0) || (stat.mode & 0o022) !== 0))
    ) {
      throw new Error(`unsafe file ${current}: owner ${stat.uid}, mode ${(stat.mode & 0o7777).toString(8)}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
