# SignalArc Cheers

Community USDC gifting app on Arc Mainnet.
Pool contributions, share a link, let the recipient claim on the gift date.

---

## Network

- **Chain:** Arc Mainnet, chain ID 5042
- **RPC:** https://rpc.mainnet.arc.io
- **Explorer:** https://explorer.arc.io
- **USDC (ERC-20):** `0x3600000000000000000000000000000000000000`, 6 decimals
- **Native gas:** USDC at 18 decimals (same pool as ERC-20 — do not double-count)

---

## Deployed Contracts

| Contract              | Address | Network     | Notes                          |
|-----------------------|---------|-------------|--------------------------------|
| CheersGiftRegistry    | `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` | Arc Mainnet (5042) | Deploy tx: `0x5599a6f5f27d74b36eeffafdabeb8df24e9bbcdd0829fa97d6231df2076a7d85`, block 26623210. Verified: bytecode 3,257 bytes, `usdc()=0x3600...0000`, `nextGiftId()=1`. |

Deployed. See `arc-studio-plans/DEPLOY-PREFLIGHT.md` for full deployment notes.

---

## Contract

**File:** `contracts/CheersGiftRegistry.sol`
**ABI:** `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.abi.json`
**ABI (frontend):** `src/lib/cheers-abi.ts`

Four functions: `createGift`, `contribute`, `claim`, `refund`.
Invariant: `totalContributed = totalClaimed + totalRefunded + remainingBalance`

Tests: `contracts/test/CheersGiftRegistry.t.sol` — 77/77 pass (unit + fuzz + invariant).
Run: `bun run contracts:test`

---

## Project Phases

| Phase | Description                              | Status      |
|-------|------------------------------------------|-------------|
| 3     | Smart contract + tests                   | Complete    |
| 5a    | Wallet + frontend foundation + UI polish | Complete    |
| 5b    | Transaction flows + bytecode gate + simulate/gas + event verification | Complete |
| 5c    | Supabase metadata integration (API adapter, greeting cards, recovery) | Complete    |
| 6     | Integration verification (pre-deploy)    | Complete — see deployment readiness below; browser/mobile inspection and hook integration tests remain pending until mainnet deployment |
| 7     | Mainnet deployment + production wiring   | In progress — contract deployed, registry wired, backend active |

---

## Wallet Stack

- **Wallet connection:** RainbowKit-style via ConnectKit + wagmi v2 + viem
- **Connectors:** `injected()` (MetaMask, Rabby, any browser wallet), `coinbaseWallet()`
- **No WalletConnect required:** app works with injected wallets only. WalletConnect can be added via `walletConnect({ projectId: '...' })` when a Reown Project ID is available.
- **No Circle Wallets, no Google/email login, no Circle API keys.**
- **Backend auth (future):** EIP-712 wallet signatures with nonce + expiry + domain binding. Connecting a wallet alone is not an authenticated backend session.

---

## Environment Variables

| Variable                          | Required | Notes                                                          |
|-----------------------------------|----------|----------------------------------------------------------------|
| `VITE_REGISTRY_ADDRESS`           | Yes      | `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` — set in `.env`, dev server restarted |
| `VITE_SUPABASE_URL`               | Yes      | Set: `https://pewansbncyzxwuqltigc.supabase.co`               |
| `VITE_SUPABASE_PUBLISHABLE_KEY`   | Yes      | Set: browser-safe publishable key; never a secret/service key  |
| `VITE_WALLETCONNECT_ID`           | No       | Optional; app works without it via injected wallets            |

---

## Live Registry State (confirmed 2026-10-18 via RPC)

| Item | Value |
|---|---|
| `nextGiftId()` | 2 (Gift #1 exists) |
| `usdc()` | `0x3600000000000000000000000000000000000000` |
| Gift #1 title (API) | "Cheers First Mainnet Gift" |
| Gift #1 status | CLAIMABLE (giftAt: 2026-10-18T16:00 UTC, deadline: 2026-10-25T16:00 UTC) |
| Gift #1 total contributed | $0.00 (no contributions yet) |

## Frontend Structure

```
src/
  App.tsx                     # Hash router: #/ landing, #/create, #/gift/:id
  config.ts                   # wagmi config — Arc Mainnet only
  lib/
    cheers-abi.ts             # Typed contract ABI (as const) — regenerated from forge build
    cheers-contract.ts        # Address, phase enum, formatters, amount parser,
                              # CLAIM_DURATIONS, decodeContractError, simulateAndEstimate,
                              # verifyContributedEvent, verifyClaimedEvent, verifyRefundedEvent
    cheers-api.ts             # Backend fetch wrapper: health, GET gift, challenge, execute,
                              # canonicalJSON, computePayloadHash, buildTypedData,
                              # validateChallenge, metaSaveGift, metaSaveContribution,
                              # draft localStorage (draftKey, saveDraft, loadDraft, clearDraft)
  hooks/
    useLiveTime.ts            # 1s tick, phase-boundary crossing callback
    usePendingTx.ts           # localStorage-persisted tx hash per
                              #   (chain+registry+account+giftId+action)
    useContractBytecode.ts    # Verifies registry address has bytecode on Arc
    useGiftMetadata.ts        # Fetch GiftMeta + ContributionMeta pages from backend (single gift)
    useGiftListing.ts         # Registry listing: nextGiftId + getGift (multicall) + API metadata
                              #   Max 50 most-recent gifts. Creator addresses from GiftCreated events.
  components/
    WalletButton.tsx          # Custom ConnectKit button with ERC-20 balance
    WrongNetwork.tsx          # Banner + inline variant for wrong chain
    PhaseBadge.tsx            # Coloured status pill
    ContractPendingNotice.tsx # "On-chain gifting is coming soon." banner
    TxButton.tsx              # Reusable button: idle/awaiting-wallet/pending/
                              #   confirmed/rejected/failed + explorer link
    ContributePanel.tsx       # Two-step approve+contribute + greeting sign+save
    MetadataForm.tsx          # Title / description / target fields for gift creation
    GreetingForm.tsx          # Display name + message fields for contributions
    MetadataRecovery.tsx      # GiftMetaRecovery + ContribGreetingRecovery components
                              # (retry metadata save without new transaction)
    GiftsListing.tsx          # Live gift cards with filter tabs: all / mine / for-me
                              #   No demo content. Title fallback: "Gift #N"
  pages/
    LandingPage.tsx           # Hero + live registry listing (GiftsListing) + filter tabs
                              #   + Open by ID input. No DEMO_CARDS.
    CreateGiftPage.tsx        # Form → review → createGift → metadata sign+save → share URL
    GiftDetailPage.tsx        # Read+write: contribute, claim, refund + greeting cards
                              #   Auto-retries metadata after 4s if absent (post-creation race)
  test/
    cheers.test.ts            # 54 unit tests (amount parsing, phase boundaries, etc.)
    cheers-tx.test.ts         # 45 tests (tx sequencing, bytecode, event verification)
    cheers-api.test.ts        # 50 tests (API adapter, canonical JSON, EIP-712, recovery)
    cheers-event.test.ts      # 18 tests (event extraction, logIndex from matched log)
```

## Test Commands

```bash
bun run test          # vitest run (167 tests across 4 files, pure logic, no RPC)
bun run contracts:test # forge test (77 tests, Solidity)
```

## Transaction Architecture

- All write calls use `useWriteContract` + `useWaitForTransactionReceipt` from wagmi.
- Pending tx hashes are persisted to localStorage keyed by `(registry, account, giftId, action)`.
  On reload, state syncs to 'pending' without re-submitting.
- **Bytecode gate**: `useContractBytecode` fires a `getCode` RPC check before any write is enabled.
  Status: idle/checking/ok/empty/error. All 5 write surfaces (createGift, approve, contribute,
  claim, refund) are disabled when status is not 'ok'.
- **Simulation**: `simulateAndEstimate` (in cheers-contract.ts) runs `simulateContract` +
  `estimateContractGas` + `getGasPrice` before the wallet prompt is shown.
  Gas fee shown as "~$X.XXXX USDC (estimate only)". Simulation failure blocks submission.
- **Event verification**: all receipts are verified against their matching contract event
  before showing success. `GiftCreated` → createGift, `ContributionMade` → contribute,
  `GiftClaimed` → claim, `ContributorRefunded` → refund.
  An approval receipt cannot be mistaken for a contribution receipt.
- createGift: extracts giftId from `GiftCreated` event (creator, recipient order corrected).
- contribute: two-step (approve if needed → contributor confirms separately). Approval
  confirmed ≠ contribution submitted — user must click explicitly.
- Gas note: on Arc, gas and ERC-20 USDC share one balance; shown with USDC balance.
- Phase boundaries (giftAt, claimDeadline) trigger a contract refetch via useLiveTime callback.
- All state is re-read on wallet address or chain change.

## ABI

- `src/lib/cheers-abi.ts` — regenerated from `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json`.
  Contains all 4 events: `ContributionMade`, `ContributorRefunded`, `GiftClaimed`, `GiftCreated`.
  Do not edit by hand — regenerate after any contract change with `forge build`.

---

## Design System

**Approved direction: dark Web3 theme (set in Phase 5a UI refinement)**

- **Background:** `#0d0e12` near-black, subtle dark gradient
- **Cards:** `--surface-card` `#16181f` charcoal; `--surface-raised` `#1e2029` one step lighter
- **Primary accent:** amber `#D97706` (hover `#F59E0B`) — CTAs, hero amounts, active indicators
- **Secondary:** violet `#7C3AED` — feature icon accent; restrained, never dominant
- **Text:** `--ink` `#f0f0f0` primary · `--ink-2` `#b8bfd0` secondary · `--muted` `#7a8299`
- **Semantic:** success `#22c55e`, danger `#f87171`
- **Fonts:** Space Grotesk (display/hero), DM Sans (body/UI), JetBrains Mono (addresses, hashes, numbers)
- **Tokens:** CSS custom properties in `src/index.css`
- **Card class:** `.glass-card` (charcoal bg + subtle dark border/shadow), `.glass-inner` (one step darker inset)
- **Accent strip:** `.spectral-strip` (amber→violet gradient) — 3px top strip on hero cards only
- **ConnectKit modal:** matching dark bg `#16181f`, amber primary button, dark overlay `rgba(0,0,0,0.72)`
- **Reduced motion:** `@media (prefers-reduced-motion)` suppresses all transitions/animations

---

## Supabase Backend Integration

**API base:** `https://pewansbncyzxwuqltigc.supabase.co/functions/v1/cheers-api`
**Auth:** `apikey: VITE_SUPABASE_PUBLISHABLE_KEY` header. Browser-safe. Not a bearer JWT.
**Origin allowlist (currently enabled):** `https://cheers.signalarc.fun`, `https://ib3q9euuvar7u3zygcmbg.preview.studio.arc.io`, `http://localhost:5173`

### Public reads
- `GET ?route=health` — service, chainId, registryReady (false until contract registered)
- `GET ?route=gift&registry=<addr>&giftId=<str>&offset=0` — paginated gift + contributions

### Metadata write flow (EIP-712, no session required)
1. POST `op=challenge` with wallet, action, payload → returns nonce + typedData
2. Validate: domain name, version, chainId 5042, verifyingContract=registry, wallet, action, origin, expiry
3. Sign with wagmi `signTypedDataAsync` — signature authorizes metadata ONLY, not USDC
4. POST `op=execute` with nonce, action, exact normalized payload from challenge, signature

**expiresAt** in challenge response is a decimal string — must be converted to BigInt before signing.
**Use the normalized payload returned by the challenge** in the execute call, not the original.
On nonce expiry (401) or receipt unavailable (409): request NEW challenge for the SAME txHash — never send a new transaction.

### Recovery
- If metadata save fails after confirmed on-chain tx: `GiftMetaRecovery` / `ContribGreetingRecovery` components retry sign+save without any new transaction.
- Drafts scoped to `(chainId, registry, account, giftId, action)` via `draftKey()` in `cheers-api.ts`.
- Missing metadata (404) does not mean the gift is nonexistent — contract data always shown.

---

## Deployment Readiness

### Pre-deploy gate — all requirements before `forge create`

| Requirement | Status |
|---|---|
| Smart contract 77/77 Foundry tests pass | ✅ |
| Frontend 167/167 vitest tests pass (4 files: cheers, cheers-tx, cheers-api, cheers-event) | ✅ |
| `bun run check` (lint + typecheck) — 0 errors | ✅ |
| Production build succeeds (19s, confirmed 2026-10-18) | ✅ |
| Supabase backend deployed, health endpoint live | ✅ |
| Preview origin CORS authorized by backend | ✅ |
| Contract ABI regenerated from `forge build` (all 4 events correct) | ✅ |
| Log index read from verified event result's `logIndex` field (emitter + topic + giftId + contributor + amount all checked; no array-position fallback) | ✅ fixed Phase 6 final |
| 503 `registry_not_enabled` message explains activation pending, no new payment | ✅ fixed Phase 6 |
| `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set in `.env` | ✅ |
| `VITE_REGISTRY_ADDRESS` set, bytecode confirmed, `registryReady: true` | ✅ live |

### Phase 7 status

- `VITE_REGISTRY_ADDRESS` — **set** (`0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0`), dev server restarted. ✅
- Backend registry — **active** (`registryReady: true` confirmed live). ✅
- Contract bytecode — **verified** (3,257 bytes at registry address on mainnet). ✅
- Optional WalletConnect Project ID (`VITE_WALLETCONNECT_ID`) — not yet set; injected wallets work without it.

### What remains untested (requires a live wallet session)

- End-to-end metadata write (challenge → EIP-712 sign → execute) with a real connected wallet.
- Gas estimation accuracy for `createGift`, `contribute`, `claim`, `refund` against the live contract.
- `verifyContributedEvent` / `verifyClaimedEvent` / `verifyRefundedEvent` against real mainnet receipts.
- WalletConnect QR-code flow (needs a Reown Project ID).
- Browser/mobile inspection at physical widths with a real wallet connected.

### Pending (requires live environment — NOT marked complete)

- **Browser/mobile inspection at physical widths**: inspected via sandbox dev server only; not through a real mobile browser at 390px and 1440px. Wallet connection, signature prompts, and gesture handling on iOS/Android are untested.
- **Hook/component rendering tests**: all tests are pure logic (no DOM, no wagmi hooks). Full hook+component tests (React Testing Library + wagmi mock) deferred until post-mainnet when end-to-end flows can be validated.
- **Browser fetch ≠ curl**: health and CORS confirmed via curl with `-H "Origin: ..."`. Real browser preflight behavior (automatic Origin header, credential handling) needs confirmation via an actual connected session. The Origin is on the allowlist and preflight returned 204 — no blockage expected, but it is not yet browser-confirmed.

---

## Known Remaining Configuration

1. `VITE_REGISTRY_ADDRESS` — **set** ✅
2. Optional WalletConnect Project ID (`VITE_WALLETCONNECT_ID`) — free at https://cloud.reown.com; injected wallets work without it.
3. Backend registry activation — **active** (`registryReady: true`) ✅

---

## Mainnet Deployment (Phase 7) — COMPLETE

Contract deployed on 2026-10-18. All post-deploy steps done.
Deploy method used: `forge create --interactive --broadcast` from a local terminal (EIP-1559, type-2 receipt; Arc Studio platform deployer is testnet-only).
Full deployment notes and failure-mode guide: `arc-studio-plans/DEPLOY-PREFLIGHT.md`

**Next step:** deploy frontend to Vercel at `cheers.signalarc.fun`.
