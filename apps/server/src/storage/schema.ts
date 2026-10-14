// Table types for Kysely, matching the SQL migrations in ./migrations.

import type { Generated } from 'kysely';

export interface DB {
  auth_totp: { id: number; key_id: string; nonce: Uint8Array; ciphertext: Uint8Array; last_counter: string };
  recovery_codes: { code_hash: string; used_at: string | null };
  login_throttles: { counter: string; kind: string; failures: number; next_allowed_at: number; last_failed_at: number };
  known_devices: {
    handle: Generated<string>;
    source: Generated<string>;
    id_hash: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  };
  spend_limits: {
    max_fee_rate_mode: Generated<string>;
    max_fee_share_mode: Generated<string>;
    max_routing_fee_mode: Generated<string>;
    chain: string;
    pubkey: string;
    max_per_payment_sat: string | null;
    max_24h_sat: string | null;
    step_up_above_sat: string | null;
    max_fee_rate: string;
    max_fee_share_percent: number;
    max_routing_fee_share_percent: number;
    routing_fee_allowance_sat: string;
  };
  settings: { key: string; value: string };
  owner: { id: number; password_hash: string; created_at: string };
  setup_token: { id: number; token_hash: string; expires_at: string };
  sessions: {
    source: Generated<string>;
    ended_at: Generated<string | null>;
    end_reason: Generated<string | null>;
    step_up_failures: Generated<number>;
    step_up_retry_at: Generated<number>;
    recovery_required: Generated<number>;
    id_hash: string;
    handle: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  };
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
    cost_msat: Generated<string | null>;
    destination: Generated<string | null>;
    session_handle: Generated<string | null>;
    confirmation_hash: Generated<string | null>;
    preimage: Generated<string | null>;
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
