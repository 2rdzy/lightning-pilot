import { ConfigError } from './config.ts';
export function parseCommand(argv: readonly string[]) {
  let command = 'serve';
  let consumed = 0;
  if (['reset-auth', 'setup-token', 'reset-login-throttles'].includes(argv[0] ?? '')) {
    command = argv[0] ?? '';
    consumed = 1;
  } else if (argv[0] === 'config' && argv[1] === 'check') {
    command = 'config-check';
    consumed = 2;
  } else if (argv[0] === 'vault' && (argv[1] === 'rotate' || argv[1] === 'reset')) {
    command = `vault-${argv[1]}`;
    consumed = 2;
  }
  const args: string[] = [];
  let newKeyFile: string | undefined;
  for (let i = consumed; i < argv.length; i++) {
    if (argv[i] === '--new-key-file' && command.startsWith('vault-')) {
      if (newKeyFile !== undefined) throw new ConfigError('duplicate --new-key-file');
      newKeyFile = argv[++i];
      if (!newKeyFile || newKeyFile.startsWith('--')) throw new ConfigError('--new-key-file needs a path');
    } else args.push(argv[i] ?? '');
  }
  if (command === 'vault-reset' && !newKeyFile) throw new ConfigError('vault reset needs --new-key-file');
  return { command, args, newKeyFile };
}
