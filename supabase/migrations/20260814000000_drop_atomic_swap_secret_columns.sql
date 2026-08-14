-- ============================================================================
-- DROP ATOMIC SWAP PREIMAGE SECRET COLUMNS — security cleanup
-- ============================================================================
-- The atomic-swap module (backend/atomic-swap/swap.service.js) previously
-- persisted the HTLC preimage (`secret`) into `atomic_swaps` and
-- `cross_chain_swaps` via storeSwap / storeCrossChainSwap. In an HTLC scheme
-- the preimage must be revealed only at claim time; persisting it server-side
-- lets anyone with DB read access call claimSwap and take the escrowed funds.
--
-- This migration drops the `secret` columns, deleting any historical plaintext
-- preimages stored in them. The code now stores only `hash_lock`; the preimage
-- is handed to the counterparty transiently from the create call and never
-- read back from the database.
--
-- Dropping the columns removes the secret material with them. No preimage is
-- copied, exported, or logged elsewhere. If an operational policy requires
-- preserving historical rows for forensics, that must be done out-of-band
-- BEFORE applying this migration — the plaintext preimages cannot be restored
-- after it runs. Any retained copies must be treated as secret-bearing data.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- DROP PREIMAGE SECRET COLUMNS
-- ────────────────────────────────────────────────────────────────────────────
alter table atomic_swaps
  drop column if exists secret;

alter table cross_chain_swaps
  drop column if exists secret;
