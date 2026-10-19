# SignalArc Cheers — Implementation Plan (v3)

> Last updated: October 18, 2026. All decisions in this document supersede earlier versions.

## Summary

SignalArc Cheers is a community USDC gifting app on Arc Mainnet. Contributors pool USDC for a
single recipient, share a gift link with optional greeting messages, and the recipient claims the
pooled amount during a defined window. If unclaimed, contributors withdraw their own contributions
individually. Target domain: `cheers.signalarc.fun`.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vite + React + TypeScript | Arc Studio sandbox |
| Styling | Tailwind CSS + shadcn/ui | |
| Animations | Framer Motion + canvas-confetti | |
| Wallet connection | RainbowKit + wagmi v2 + viem | Users bring their own wallets |
| Chain reads | viem public client | Read-only; no private key in browser |
| Contract | Solidity 0.8.28 + OpenZeppelin 5.1.0 | SafeERC20, ReentrancyGuard |
| Toolchain | Foundry (forge build / forge test) | evm_version = paris |
| Backend | Supabase Edge Functions (Deno, npm: imports) | Secrets via Deno.env |
| Database | Supabase PostgreSQL + RLS | |
| Auth (metadata writes) | EIP-712 wallet signatures + server nonce | See §5 |
| Source control | GitHub | |
| Hosting | Vercel | |
| Network | **Arc Mainnet only** (chain ID 5042) | No testnet deployment |

### Removed from stack
- Circle User-Controlled Wallets
- `@circle-fin/user-controlled-wallets` / `@circle-fin/w3s-pw-web-sdk`
- Circle API keys, entity secrets, device tokens, Circle sessions
- All Circle wallet-related blockers (B-1, B-2, B-3 from prior plan)
- Gas sponsorship of any kind

---

## 2. Network facts (Arc Mainnet)

Source: `src/onchain-facts.ts` (Arc Studio generated module — always import, never hardcode)

| Fact | Value |
|---|---|
| Chain ID | 5042 |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| USDC address | `0x3600000000000000000000000000000000000000` |
| USDC decimals (ERC-20 view) | 6 |
| Gas token | USDC (18-decimal native view; same underlying asset) |

USDC on Arc is one asset exposed via two views. Never sum or display native balance and ERC-20
balance as separate amounts. All contract and UI amounts use the 6-decimal ERC-20 view.
Fee estimates are fetched dynamically via viem `estimateGas` — no fixed cost is promised.

---

## 3. Deployment workflow

### Arc Studio platform deployer — capability boundary

Arc Studio's `deploy_contract` tool is **testnet-only**. It cannot deploy to Arc Mainnet.

### Mainnet self-deploy workflow (Phase 3 — requires your explicit approval)

```bash
# 1. Build in Arc Studio sandbox (produces the artifact)
forge build

# 2. Export artifact from sandbox
#    contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json

# 3. On your own machine (never commit PRIVATE_KEY)
forge create contracts/CheersGiftRegistry.sol:CheersGiftRegistry \
  --rpc-url https://rpc.mainnet.arc.io \
  --constructor-args 0x3600000000000000000000000000000000000000 \
  --private-key $PRIVATE_KEY \
  --broadcast

# 4. Record the deployed address in AGENTS.md and .env
```

Your deployer wallet must hold USDC on Arc Mainnet for gas. This step will not be executed
without explicit confirmation.

---

## 4. Contract: CheersGiftRegistry

### Financial rules (V1, immutable)

- One immutable recipient per gift; cannot be changed after creation.
- Creator sets a future `giftAt` timestamp; contributions are accepted only while
  `block.timestamp < giftAt`.
- Claim duration is 7, 14, or 30 days (default 30). `claimDeadline = giftAt + claimDuration`.
- Recipient may claim once, for the entire balance, when
  `giftAt <= block.timestamp < claimDeadline`.
- Refund is available to each contributor after `block.timestamp >= claimDeadline` if the gift
  was not claimed. Each contributor withdraws their own aggregated contribution. No expiry.
- Contributions may exceed any optional visual funding target.
- Repeated contributions from the same wallet are allowed and accumulate.
- No cancellation, no admin withdrawals, no application fees, no automatic payouts.
- Reject zero amounts, zero-address recipient, `address(this)` as recipient.

### Accounting fields (per gift, all in 6-decimal ERC-20 USDC units)

| Field | Meaning |
|---|---|
| `totalContributed` | Cumulative USDC received; monotonically increasing |
| `totalClaimed` | USDC paid to recipient; 0 or == `totalContributed` |
| `totalRefunded` | Aggregate contributor refunds issued so far |
| `remainingBalance` | Derived: `totalContributed - totalClaimed - totalRefunded` |

**Invariant**: `totalContributed == totalClaimed + totalRefunded + remainingBalance` at all times.
**Invariant**: contract's USDC ERC-20 balance >= sum of all `remainingBalance` across all gifts.

Unsolicited direct USDC transfers to the contract address are not credited to any gift and
are permanently locked (no rescue function). The frontend must use `contribute()` exclusively.

### State machine

```
OPEN        block.timestamp < giftAt                           (contributions accepted)
CLAIMABLE   giftAt <= block.timestamp < claimDeadline          (recipient claims once)
REFUNDABLE  block.timestamp >= claimDeadline AND totalClaimed==0  (contributors refund)
CLOSED      totalClaimed > 0
```

Claim and refund windows never overlap. At `block.timestamp == claimDeadline`, claim reverts
and refund succeeds.

### Storage

```solidity
struct Gift {
    address recipient;        // immutable; set at createGift
    uint256 giftAt;           // sentinel: 0 = nonexistent gift
    uint256 claimDeadline;    // giftAt + claimDuration
    uint256 totalContributed; // cumulative; monotonically increasing
    uint256 totalClaimed;     // 0 or == totalContributed at claim time
    uint256 totalRefunded;    // aggregate refunds
}

IERC20 public immutable usdc;
uint256 public nextGiftId;  // starts at 1; 0 is the nonexistent-gift sentinel

mapping(uint256 => Gift) public gifts;
mapping(uint256 => mapping(address => uint256)) public contributions;
mapping(uint256 => mapping(address => bool)) public refunded;
```

### Functions

| Function | Key conditions | Events |
|---|---|---|
| `createGift(recipient, giftAt, claimDuration)` | recipient != 0 and != address(this); giftAt > block.timestamp; claimDuration in {7,14,30} days | `GiftCreated` |
| `contribute(giftId, amount)` | gift exists; block.timestamp < giftAt; amount > 0 | `ContributionMade` |
| `claim(giftId)` | gift exists; msg.sender == recipient; totalClaimed==0; giftAt<=now<claimDeadline; totalContributed>0 | `GiftClaimed` |
| `refund(giftId)` | gift exists; now>=claimDeadline; totalClaimed==0; !refunded; contributions>0 | `ContributorRefunded` |

CEI discipline: all state mutations committed before any external USDC call.
`SafeERC20.safeTransferFrom` / `safeTransfer` used throughout.
`ReentrancyGuard` applied as belt-and-suspenders.

---

## 5. Authentication for metadata writes (later phase)

Wallet connection via RainbowKit is **not** backend authentication. Connecting a wallet
proves nothing to the server without a signature.

Pattern for writes (e.g. saving a greeting message after a confirmed contribution):

1. Server issues a single-use nonce tied to the wallet address and an expiry timestamp.
2. SPA requests the user signs an EIP-712 typed message:
   `{ domain: {name:'CheersSignalArc', chainId:5042, verifyingContract: REGISTRY}, nonce, action, expiry }`.
3. SPA sends `{ signature, message, txHash }` to the Edge Function.
4. Edge Function recovers the signer address from the signature; verifies it matches the
   `contributor` field in the on-chain `ContributionMade` event at `txHash`; verifies nonce
   is unused and not expired; marks nonce consumed; writes to Supabase.
5. Database secrets (Supabase service role key) stay server-side only.

---

## 6. On-chain / Off-chain data boundary

| Data | Location |
|---|---|
| USDC balances, contributions, claim/refund state, deadlines, recipient | Contract (on-chain) |
| Gift display name, description, optional funding target (visual) | Supabase |
| Contributor display names | Supabase |
| Greeting messages (≤280 chars) | Supabase |
| Nonces for signature auth | Supabase (server-side only) |

Gift identity in Supabase: `(chain_id, registry_addr, gift_id)`.
Event deduplication key: `(chain_id, registry_addr, tx_hash, log_index)`.

---

## 7. Database schema (Supabase)

```sql
create table gifts (
  id             uuid primary key default gen_random_uuid(),
  chain_id       bigint not null default 5042,
  registry_addr  text not null,
  gift_id        bigint not null,
  creator_addr   text not null,       -- signer-verified (EIP-712), lowercase hex
  recipient_addr text not null,
  display_name   text,
  description    text check (char_length(description) <= 500),
  funding_target numeric(20,6),       -- display only; nullable
  gift_at        timestamptz not null,
  claim_deadline timestamptz not null,
  created_at     timestamptz default now(),
  unique(chain_id, registry_addr, gift_id)
);

create table contributions_meta (
  id             uuid primary key default gen_random_uuid(),
  gift_ref       uuid references gifts(id) on delete cascade,
  wallet_addr    text not null,
  display_name   text,
  created_at     timestamptz default now(),
  unique(gift_ref, wallet_addr)
);

create table greetings (
  id               uuid primary key default gen_random_uuid(),
  gift_ref         uuid references gifts(id) on delete cascade,
  contributor_addr text not null,
  chain_id         bigint not null,
  registry_addr    text not null,
  tx_hash          text not null,
  log_index        int not null,
  block_number     bigint not null,
  amount_usdc      numeric(20,6) not null,
  message          text check (char_length(message) <= 280),
  recovered_at     timestamptz,
  created_at       timestamptz default now(),
  unique(chain_id, registry_addr, tx_hash, log_index)
);

create table auth_nonces (
  id             uuid primary key default gen_random_uuid(),
  wallet_addr    text not null,
  nonce          text not null unique,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz default now()
);

-- RLS
-- gifts: anon SELECT (all columns except internal ids fine)
-- contributions_meta: anon SELECT
-- greetings: anon SELECT
-- auth_nonces: NO anon access; service role only
-- All inserts/updates: service role (Edge Functions) only
```

---

## 8. Phased implementation plan

### Phase 3 — Smart contract + local tests (COMPLETE)
Complete 4-function contract; 77/77 Foundry tests pass (unit + fuzz + invariant, mock USDC).
No deployment. No real USDC. ABI exported to `src/lib/cheers-abi.ts`.

### Phase 5a — Frontend wallet connection + UI foundation (COMPLETE)
ConnectKit + wagmi + viem wired to Arc Mainnet (chain ID 5042).
Dark Web3 design system. Landing page, create-gift page, gift-detail page.
Read-only contract state. Contract-pending notice when VITE_REGISTRY_ADDRESS absent.

### Phase 5b — Transaction flows (COMPLETE)
createGift, contribute (approve + contribute two-step), claim, refund all wired.
Bytecode gate on all writes. Simulation + gas estimate before wallet prompt.
Event verification before confirming success (GiftCreated, ContributionMade, GiftClaimed, ContributorRefunded).
Pending tx recovery across reloads. 167/167 vitest tests pass (as of Phase 6).

### Phase 5c — Supabase metadata integration (COMPLETE)
API adapter (`cheers-api.ts`): health, GET gift, challenge, execute.
EIP-712 MetadataAction sign-and-save for gift titles and contribution greetings.
Greeting cards on gift-detail page. Recovery UI (no new transaction needed).
CORS and health verified via curl from preview origin. Full browser-session confirmation pending live wallet.
Backend at `https://pewansbncyzxwuqltigc.supabase.co/functions/v1/cheers-api` — deployed and active.

### Phase 6 — Integration verification (COMPLETE, pending items noted)
- 167/167 vitest tests pass (pure logic: amount parsing, timestamp boundaries, event extraction, API adapter, EIP-712, recovery).
- 77/77 Foundry tests pass (unit + fuzz + invariant).
- `bun run check` 0 errors. Production build succeeds.
- Live API: health, CORS preflight, challenge — all confirmed from the preview origin via curl.
- Event log index extraction: full five-field verification (emitter, topic, giftId, contributor, amount). logIndex from canonical receipt field, never array position.
- **Pending (requires a live wallet session):** browser fetch confirmation, mobile layout at physical widths, hook/component rendering tests, end-to-end EIP-712 sign+execute, gas estimation accuracy against deployed contract.

### Phase 7 — Mainnet deployment + production wiring (IN PROGRESS)

**Contract deployed** — 2026-10-18:
- Address: `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0`
- Chain: Arc Mainnet (5042)
- Deploy tx: `0x5599a6f5f27d74b36eeffafdabeb8df24e9bbcdd0829fa97d6231df2076a7d85`
- Block: 26623210
- Source-verified on explorer.
- Live confirmed: `usdc()=0x3600...0000`, `nextGiftId()=1` (no gifts yet).

**`VITE_REGISTRY_ADDRESS=0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0`** set in `.env`, dev server restarted. ✅
**Supabase `registryReady: true`** — confirmed live. ✅
**`bun run check`** — 0 errors. ✅
**Production build** — succeeds. ✅

**Remaining before launch:**
- Deploy frontend to Vercel at `cheers.signalarc.fun`.
- Connect a real wallet and run the first live `createGift` transaction.
- Confirm `useContractBytecode` returns `ok` in the live browser (not just curl).
- Confirm health API from browser (not curl) with connected wallet session.
- Optional: WalletConnect Project ID (https://cloud.reown.com) for mobile QR-code wallets.

---

## 9. Key files

| File | Description |
|---|---|
| `contracts/CheersGiftRegistry.sol` | Complete 4-function contract |
| `contracts/test/CheersGiftRegistry.t.sol` | 77 Foundry tests (unit + fuzz + invariant) |
| `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json` | Compiled artifact |
| `src/lib/cheers-abi.ts` | Typed ABI (regenerated from forge build; all 4 events) |
| `src/lib/cheers-contract.ts` | Address, phase enum, formatters, simulateAndEstimate, event verification |
| `src/lib/cheers-api.ts` | Backend fetch adapter, EIP-712 builder, draft storage |
| `src/hooks/` | useLiveTime, usePendingTx, useContractBytecode, useGiftMetadata |
| `src/components/` | WalletButton, WrongNetwork, PhaseBadge, TxButton, ContributePanel, MetadataForm, GreetingForm, MetadataRecovery |
| `src/pages/` | LandingPage, CreateGiftPage, GiftDetailPage |
| `src/test/` | cheers.test.ts (54), cheers-tx.test.ts (45), cheers-api.test.ts (50), cheers-event.test.ts (18) — 167 total |
| `arc-studio-plans/DEPLOY-PREFLIGHT.md` | Full mainnet deployment instructions |

---

## 10. Remaining blockers

None blocking deployment. All pre-launch items are operational steps, not code defects:

- Deploy frontend to Vercel (`cheers.signalarc.fun`) — see Phase 7.
- Optional WalletConnect Project ID for mobile QR-code wallet support.
- Live browser test with a real connected wallet (contract is live; browser session needed).
