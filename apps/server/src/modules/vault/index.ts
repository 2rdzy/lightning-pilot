// vault module: start-up checks of the vault key and encryption of node credentials.
export { keyIdOf, loadVaultKey, Vault, VaultError, type CredentialKind, type SecretPurpose } from './vault.ts';
export { resetVault, finishVaultChange } from './lifecycle.ts';
