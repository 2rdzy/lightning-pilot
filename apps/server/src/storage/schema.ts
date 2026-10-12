// Table types for Kysely, matching the SQL migrations in ./migrations.

export interface DB {
  settings: { key: string; value: string };
  owner: { id: number; password_hash: string; created_at: string };
  setup_token: { id: number; token_hash: string; expires_at: string };
  sessions: { id_hash: string; handle: string; created_at: string; last_seen_at: string; expires_at: string };
  nodes: {
    id: string;
    name: string;
    chain: string;
    network: string;
    implementation: string;
    url: string;
    ca_certificate: string;
    server_name: string;
    pubkey: string;
    identity_state: string;
    identity_failed_check: string | null;
    identity_detail: string | null;
    identity_checked_at: string;
    created_at: string;
  };
  credentials: { node_id: string; kind: string; key_id: string; nonce: Uint8Array; ciphertext: Uint8Array };
  spend_confirmations: {
    token_hash: string;
    session_handle: string;
    node_id: string;
    digest: string;
    payload: string;
    expires_at: string;
    used_at: string | null;
  };
  spend_intents: {
    id: string;
    node_id: string;
    chain: string;
    pubkey: string;
    type: string;
    payment_hash: string;
    amount_msat: string;
    max_fee_msat: string;
    fee_msat: string | null;
    state: string;
    idempotency_key: string;
    digest: string;
    error_code: string | null;
    created_at: string;
    updated_at: string;
  };
}
