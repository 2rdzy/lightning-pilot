#!/usr/bin/env bash
# Writes regtest-requests.json: invoices made by CLN and LND nodes on both regtest chains, with what each node's own
# decoder says about them, and on-chain addresses of every type from both chains' bitcoind.
#
# It needs the manual two-chain environment /blake2bInfra (docs vault: blake2bInfra/README.md), because the
# repository's tools/regtest runs CLN only in release 0.1 and the LND invoices are part of the acceptance. Start it
# with `/blake2bInfra/infra all up` and check it with `/blake2bInfra/infra all check` first.
# Needs `jq`. It leaves new invoices on cln-a and lnd-a and new addresses in both chains' bitcoind wallets.
#
# Usage: packages/core/src/decode/fixtures/generate-regtest-requests.sh [infra command]
set -euo pipefail

INFRA=${1:-/blake2bInfra/infra}
OUT="$(cd "$(dirname "$0")" && pwd)/regtest-requests.json"
DESCRIPTION_HASHED='A description that only its hash travels with'

cli() { "$INFRA" "$1" cli "$2" "${@:3}"; }

# One CLN invoice: the node's `decode` gives the payee, features and fields we compare with.
cln_invoice() { # chain node amount_msat|any description [deschashonly]
  local chain=$1 node=$2 amount=$3 description=$4 hashonly=${5:-false}
  local label="fixture-$(date +%s%N)"
  local bolt11
  bolt11=$(cli "$chain" "$node" -k invoice amount_msat="$amount" label="$label" description="$description" \
    expiry=7200 deschashonly="$hashonly" | jq -r .bolt11)
  cli "$chain" "$node" decode "$bolt11" | jq -c --arg chain "$chain" --arg node "$node" --arg bolt11 "$bolt11" '{
    chain: $chain, implementation: "cln", node: $node, bolt11: $bolt11,
    amountMsat: (if .amount_msat == null then null else (.amount_msat | tostring) end),
    paymentHash: .payment_hash, payee: .payee, timestamp: .created_at, expiry: .expiry,
    description: .description, descriptionHash: .description_hash,
    minFinalCltvExpiryDelta: .min_final_cltv_expiry, features: .features }'
}

# One LND invoice: `decodepayreq` gives the destination, features (as a map of bit numbers) and fields.
lnd_invoice() { # chain node amount_msat|0 description [hash]
  local chain=$1 node=$2 amount=$3 description=$4 hashonly=${5:-false}
  local args=(addinvoice --expiry 7200)
  [ "$amount" != 0 ] && args+=(--amt_msat "$amount")
  if [ "$hashonly" = true ]; then
    args+=(--description_hash "$(printf '%s' "$description" | sha256sum | cut -d' ' -f1)")
  else
    args+=(--memo "$description")
  fi
  local bolt11
  bolt11=$(cli "$chain" "$node" "${args[@]}" | jq -r .payment_request)
  cli "$chain" "$node" decodepayreq "$bolt11" | jq -c --arg chain "$chain" --arg node "$node" --arg bolt11 "$bolt11" '{
    chain: $chain, implementation: "lnd", node: $node, bolt11: $bolt11,
    amountMsat: (if .num_msat == "0" then null else .num_msat end),
    paymentHash: .payment_hash, payee: .destination, timestamp: (.timestamp | tonumber), expiry: (.expiry | tonumber),
    description: (if .description == "" then null else .description end),
    descriptionHash: (if .description_hash == "" then null else .description_hash end),
    minFinalCltvExpiryDelta: (.cltv_expiry | tonumber),
    featureBits: (.features | keys | map(tonumber) | sort) }'
}

address() { # chain type
  local address
  address=$(cli "$1" btc getnewaddress fixture "$2")
  jq -nc --arg chain "$1" --arg type "$2" --arg address "$address" '{chain: $chain, bitcoinType: $type, address: $address}'
}

{
  for chain in blake2b sha256d; do
    for amount in 1000 12345678 1500000000; do
      cln_invoice "$chain" cln-a "$amount" 'fixture'
      lnd_invoice "$chain" lnd-a "$amount" 'fixture'
    done
    cln_invoice "$chain" cln-a any 'fixture, any amount'
    lnd_invoice "$chain" lnd-a 0 'fixture, any amount'
    cln_invoice "$chain" cln-a 50000 "$DESCRIPTION_HASHED" true
    lnd_invoice "$chain" lnd-a 50000 "$DESCRIPTION_HASHED" true
  done
} | jq -s --arg described "$DESCRIPTION_HASHED" '{invoices: ., descriptionHashed: $described}' >"$OUT.invoices"

for chain in blake2b sha256d; do
  for type in legacy p2sh-segwit bech32 bech32m; do address "$chain" "$type"; done
done | jq -s '{addresses: .}' >"$OUT.addresses"

jq -s --arg made "$(date -u +%Y-%m-%d)" '{
  comment: ("Made on the /blake2bInfra regtest chains on " + $made + " by generate-regtest-requests.sh: invoices from CLN (cln-a) and LND (lnd-a) on both chains with each node'"'"'s own decode, and addresses of every type. Regtest only; the invoices are already past their expiry."),
  descriptionHashed: .[0].descriptionHashed, invoices: .[0].invoices, addresses: .[1].addresses }' \
  "$OUT.invoices" "$OUT.addresses" >"$OUT"
rm -f "$OUT.invoices" "$OUT.addresses"
echo "wrote $OUT"
