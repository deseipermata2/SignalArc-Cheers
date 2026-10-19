# SignalArc Cheers — Architecture

---

## Contents

1. [Overview](#overview)
2. [Contract: CheersGiftRegistry](#contract-cheersgiftregistry)
3. [Frontend architecture](#frontend-architecture)
4. [Data boundary: on-chain vs. off-chain](#data-boundary-on-chain-vs-off-chain)
5. [Supabase backend API](#supabase-backend-api)
6. [Metadata write protocol (EIP-712)](#metadata-write-protocol-eip-712)
7. [Transaction lifecycle](#transaction-lifecycle)
8. [Key source files](#key-source-files)
9. [Deployment record](#deployment-record)
10. [Testing](#testing)
11. [Outstanding items](#outstanding-items)

---

## Overview

SignalArc Cheers is a group gifting application on Arc Mainnet. The architecture
separates financial logic (smart contract, on-chain) from display metadata
(Supabase, off-chain):

```
Browser (ConnectKit + wagmi + viem)
       │
       ├── RPC reads ──────────────────────► Arc Mainnet RPC
       │                                     CheersGiftRegistry contract
       │
       ├── Write transactions ─────────────► Arc Mainnet (via user wallet)
       │   (createGift, contribute,           ERC-20 approve, claim, refund
       │    claim, refund)
       │
       └── Metadata reads/writes ──────────► Supabase Edge Function
                                             (titles, descriptions, greetings)
                                             EIP-712 signed, server-verified
```

The contract is the sole authority on balances, recipient identity, deadlines,
and claim/refund eligibility. Supabase stores display metadata only; a failure
or absence of metadata does not affect financial rights.

---

## Contract: CheersGiftRegistry

**Source:** `contracts/CheersGiftRegistry.sol`
**Address:** `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` (Arc Mainnet, chain ID 5042)
**Explorer:** https://explorer.arc.io/address/0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0
**Solidity:** 0.8.28 — OpenZeppelin 5.1.0 (SafeERC20, ReentrancyGuard)
**EVM target:** paris (compatible with Arc Mainnet)

### Storage layout

```solidity
struct Gift {
    address recipient;        // immutable; set at createGift; 0 = nonexistent
    uint256 giftAt;           // contributions close at this timestamp (exclusive)
    uint256 claimDeadline;    // giftAt + claimDuration; claiming closes here (exclusive)
    uint256 totalContributed; // cumulative USDC received; monotonically increasing
    uint256 totalClaimed;     // 0 before claim; == totalContributed after claim
    uint256 totalRefunded;    // running sum of individual contributor refunds
}

IERC20 public immutable usdc;      // 0x3600000000000000000000000000000000000000
uint256 public nextGiftId;         // starts at 1; 0 is the nonexistent-gift sentinel

mapping(uint256 => Gift) public gifts;
mapping(uint256 => mapping(address => uint256)) public contributions;
mapping(uint256 => mapping(address => bool)) public refunded;
```

All amounts are in ERC-20 USDC units (6 decimals).

### Accounting invariant

```
totalContributed == totalClaimed + totalRefunded + remainingBalance
```

This holds after every state-changing operation. The contract's USDC ERC-20
balance must always cover the sum of all `remainingBalance` values across all
gifts. Unsolicited direct USDC transfers to the contract address are not credited
to any gift and are permanently locked (no rescue function).

### Functions and guards

| Function | Key preconditions | Event emitted |
|---|---|---|
| `createGift(recipient, giftAt, claimDuration)` | `recipient != address(0)` and `!= address(this)`; `giftAt > block.timestamp`; `claimDuration` in {7, 14, 30} days | `GiftCreated(giftId, creator, recipient, giftAt, claimDeadline)` |
| `contribute(giftId, amount)` | gift exists; `block.timestamp < giftAt`; `amount > 0` | `ContributionMade(giftId, contributor, amount, totalContributed)` |
| `claim(giftId)` | gift exists; `msg.sender == recipient`; `totalClaimed == 0`; `giftAt <= now < claimDeadline`; `totalContributed > 0` | `GiftClaimed(giftId, recipient, amount)` |
| `refund(giftId)` | gift exists; `now >= claimDeadline`; `totalClaimed == 0`; `!refunded[giftId][msg.sender]`; `contributions[giftId][msg.sender] > 0` | `ContributorRefunded(giftId, contributor, amount)` |

CEI discipline: all state mutations are committed before any external USDC call.
`SafeERC20.safeTransferFrom` / `safeTransfer` used throughout.
`ReentrancyGuard` applied on all state-changing functions.

### Phase state machine

```
OPEN        block.timestamp < giftAt                              contributions accepted
CLAIMABLE   giftAt <= block.timestamp < claimDeadline             recipient claims once
REFUNDABLE  block.timestamp >= claimDeadline AND totalClaimed==0  contributors refund
CLOSED      totalClaimed > 0
```

At `block.timestamp == giftAt`: contributions close; claiming becomes available.
At `block.timestamp == claimDeadline`: claiming reverts; refunding becomes available.
Claim and refund windows do not overlap.

---

## Frontend architecture

**Stack:** Vite + React 18 + TypeScript + Tailwind CSS

**Wallet layer:** ConnectKit + wagmi v2 + viem
- Connectors: `injected()` (MetaMask, Rabby, any EIP-1193 wallet), `coinbaseWallet()`
- Chain: Arc Mainnet only (chain ID 5042)
- No Circle Wallets, no custodial keys, no Google/email login

**Routing:** hash router (`#/`, `#/create`, `#/gift/:id`)

### Source structure

```
src/
  config.ts                   wagmi config — Arc Mainnet, injected + coinbase connectors
  lib/
    cheers-abi.ts             Typed ABI (as const) — regenerated from forge build
    cheers-contract.ts        Registry address, GiftPhase enum, amount formatters,
                              parseContributionAmount, CLAIM_DURATIONS,
                              decodeContractError, arcPublicClient,
                              simulateAndEstimate, verifyContributedEvent,
                              verifyClaimedEvent, verifyRefundedEvent
    cheers-api.ts             Backend fetch adapter: health, GET gift, challenge,
                              execute; canonicalJSON, computePayloadHash,
                              buildTypedData, validateChallenge,
                              metaSaveGift, metaSaveContribution;
                              draft localStorage (draftKey, saveDraft, loadDraft)
  hooks/
    useLiveTime.ts            1-second ticker with phase-boundary crossing callback
    usePendingTx.ts           localStorage-persisted pending tx per
                              (chain, registry, account, giftId, action)
    useContractBytecode.ts    eth_getCode check before any write is enabled
    useGiftMetadata.ts        Paginated backend read: gift metadata + contributions
    useGiftListing.ts         Registry listing: nextGiftId + getGift multicall +
                              GiftCreated events (bounded from deployment block) +
                              API metadata per gift; max 50 most-recent gifts
  components/
    WalletButton.tsx          ConnectKit button showing ERC-20 USDC balance
    WrongNetwork.tsx          Wrong-chain banner (full or inline variant)
    PhaseBadge.tsx            Status pill: Collecting / Ready to claim / Claim expired / Closed
    ContractPendingNotice.tsx "On-chain gifting is coming soon." when registry absent
    TxButton.tsx              5-state button: idle / awaiting-wallet / pending /
                              confirmed / rejected+failed, with Arc explorer link
    ContributePanel.tsx       Two-step approve + contribute, greeting sign+save
    MetadataForm.tsx          Title / description / target fields for gift creation
    GreetingForm.tsx          Display name + message fields for contributions
    MetadataRecovery.tsx      Retry metadata save without new blockchain transaction
    GiftsListing.tsx          Live cards from registry with filter tabs:
                              All / Created by me / For me
  pages/
    LandingPage.tsx           Hero, live GiftsListing, filter tabs, Open by ID
    CreateGiftPage.tsx        Form → review → createGift tx → metadata sign+save → share URL
    GiftDetailPage.tsx        Contract reads + contribute / claim / refund flows +
                              greeting cards + metadata
```

### Transaction safety model

Every write surface applies three sequential gates:

1. **Bytecode gate** (`useContractBytecode`): fires `eth_getCode` against the
   registry address. If the result is empty or an error, all write buttons are
   disabled. Status: `idle | checking | ok | empty | error`.

2. **Simulation** (`simulateAndEstimate` in `cheers-contract.ts`): calls
   `simulateContract` + `estimateContractGas` + `getGasPrice` before the wallet
   prompt. Gas fee is shown as "~$X.XXXX USDC (estimate only)". A simulation
   revert blocks submission and shows the decoded error message.

3. **Event verification** (after receipt): all receipts are verified against
   the matching contract event before success is shown. The verifier checks the
   emitter address, event topic, giftId, and relevant indexed fields.
   `logIndex` is taken from the canonical receipt field, never from the array
   position.

   | Transaction | Verified event |
   |---|---|
   | `createGift` | `GiftCreated(giftId, creator, recipient, giftAt, claimDeadline)` |
   | `contribute` | `ContributionMade(giftId, contributor, amount, totalContributed)` |
   | `claim` | `GiftClaimed(giftId, recipient, amount)` |
   | `refund` | `ContributorRefunded(giftId, contributor, amount)` |

### Pending transaction recovery

Each pending transaction hash is persisted to localStorage under a key scoped to
`(chainId, registry, account, giftId, action)`. On page reload, the app detects
the in-progress transaction and tracks it without re-submitting.

### Live time and phase boundaries

`useLiveTime` ticks every second. Pages pass a `onBoundary` callback that fires
when `block.timestamp` crosses `giftAt` or `claimDeadline`. At a boundary
crossing, the page refetches contract state and updates displayed eligibility.
Contract execution is the authority — the UI does not change eligibility by
timer alone.

---

## Data boundary: on-chain vs. off-chain

| Data | Location | Authority |
|---|---|---|
| USDC balances and remaining pool | Contract | On-chain |
| Recipient address | Contract | On-chain |
| Gift date, claim deadline | Contract | On-chain |
| Claim and refund eligibility | Contract | On-chain |
| Contributor contribution amounts | Contract | On-chain |
| Gift title and description | Supabase | Off-chain (display only) |
| Optional funding target | Supabase | Off-chain (display only) |
| Contributor display names | Supabase | Off-chain (display only) |
| Greeting messages | Supabase | Off-chain (display only) |
| Auth nonces | Supabase (server-side only) | Off-chain |

A missing or failed Supabase read does not mean the gift is nonexistent. The
application always shows contract data alongside whatever metadata is available.
If metadata is absent, the gift is displayed as "Gift #N".

Gift identity in Supabase: `(chain_id, registry_address, gift_id)`.
Event deduplication key: `(chain_id, registry_address, tx_hash, log_index)`.

---

## Supabase backend API

**Base URL:** `https://pewansbncyzxwuqltigc.supabase.co/functions/v1/cheers-api`

**Authentication header:** `apikey: <VITE_SUPABASE_PUBLISHABLE_KEY>`
This is a browser-safe publishable key. It is not a bearer JWT and not a secret.
Never use the Supabase service-role key in frontend code.

**CORS:** The backend allows requests from the following origins only:
- `https://cheers.signalarc.fun`
- `https://ib3q9euuvar7u3zygcmbg.preview.studio.arc.io`
- `http://localhost:5173`

The browser supplies the `Origin` header automatically. Do not set it manually.

### Public reads (no authentication)

```
GET <base>?route=health
```
Returns: `{ service, version, chainId, backend, registryReady, auth, moneySource }`

```
GET <base>?route=gift&registry=<address>&giftId=<decimal-string>&offset=0
```
Returns: `{ gift, contributions, total, nextOffset }`
Contributions paginate at 50 per page. Follow `nextOffset` until `null`.

Amount fields (`amount_raw`, `target_amount_raw`) are decimal strings in
6-decimal ERC-20 USDC units. Parse as `BigInt`, not floating-point.

### Error responses

```json
{ "error": "<code>", "message": "<human-readable text>" }
```

| HTTP | Code | Meaning |
|---|---|---|
| 400 | — | Invalid input |
| 401 | — | Invalid, expired, or already-used challenge or signature |
| 403 | — | Origin not in allowlist |
| 404 | `gift_metadata_missing` | No metadata saved; contract gift may still exist |
| 409 | `receipt_unavailable` | Wait and retry with the same transaction hash |
| 409 | `gift_metadata_missing` | Creator must save gift metadata before contribution metadata |
| 422 | — | Receipt failed or event fields do not match |
| 429 | — | Rate limited; wait one minute |
| 503 | `registry_not_enabled` | Backend activation pending; do not retry the payment |
| 503 | other | Temporary failure; use metadata recovery, do not retry the payment |

---

## Metadata write protocol (EIP-712)

Metadata writes (saving a gift title or a contribution greeting) use a
three-step protocol. No login session or JWT is required.

### Step 1 — Request a challenge

```json
POST <base>
{
  "op": "challenge",
  "wallet": "<connected address>",
  "action": "save_gift" | "save_contribution",
  "payload": { ... }
}
```

`save_gift` payload:
```json
{
  "registry": "<registry address>",
  "giftId": "<decimal integer string>",
  "txHash": "<confirmed GiftCreated transaction hash>",
  "title": "<1–100 characters>",
  "description": "<optional, up to 500 characters>",
  "targetAmountRaw": "<positive raw USDC string, or null>"
}
```

`save_contribution` payload:
```json
{
  "registry": "<registry address>",
  "giftId": "<decimal integer string>",
  "txHash": "<confirmed ContributionMade transaction hash>",
  "logIndex": "<actual non-negative integer log index>",
  "message": "<optional, up to 280 characters>",
  "displayName": "<optional, up to 60 characters>"
}
```

Response: `{ nonce, payload, typedData, expiresAt }`

Use the **normalized payload returned by the server** in the execute call, not
the original payload you sent. The `expiresAt` field in `typedData.message` is
a decimal string — convert it to `BigInt` before calling `signTypedDataAsync`.

### Step 2 — Validate and sign

Before requesting a signature, validate the returned typed data:

| Field | Expected value |
|---|---|
| `domain.name` | `"SignalArc Cheers Metadata"` |
| `domain.version` | `"1"` |
| `domain.chainId` | `5042` |
| `domain.verifyingContract` | the configured registry address |
| `primaryType` | `"MetadataAction"` |
| `message.wallet` | the connected wallet address |
| `message.action` | the requested action |
| `message.origin` | `window.location.origin` |
| `message.nonce` | the nonce from the challenge response |
| `message.expiresAt` | in the future (as BigInt) |

The EIP-712 types, in this exact order:

```
MetadataAction:
  wallet:      address
  action:      string
  origin:      string
  nonce:       string
  payloadHash: bytes32
  expiresAt:   uint256
```

`payloadHash` is `keccak256(toBytes(canonicalJSON(normalizedPayload)))`.
`canonicalJSON` recursively sorts object keys lexicographically, preserves array
order, and uses `JSON.stringify` for primitive values with no extra whitespace.

**This signature authorizes saving display metadata only. It does not transfer
USDC, approve token spending, or create any on-chain transaction.**

### Step 3 — Execute

```json
POST <base>
{
  "op": "execute",
  "nonce": "<challenge nonce>",
  "action": "<same action>",
  "payload": "<exact normalized payload from challenge response>",
  "signature": "<65-byte hex signature>"
}
```

On success:
- `save_gift`: `{ ok: true, gift, immutableMetadata: true }`
- `save_contribution`: `{ ok: true, contribution }`

Gift metadata is immutable after the first successful save. Repeated execute
calls return the stored record without creating a duplicate.

On nonce expiry (401) or receipt unavailable (409): request a new challenge for
the **same confirmed transaction hash**. Never initiate another payment or create
another gift to recover metadata.

---

## Transaction lifecycle

Each write transaction follows this lifecycle:

```
idle
  → bytecode check (useContractBytecode: eth_getCode)
  → simulation (simulateAndEstimate: simulateContract + estimateContractGas)
  → awaiting-wallet (wallet prompt shown)
  → pending (transaction broadcast, hash persisted to localStorage)
  → confirmed (receipt received, event verified)
     OR rejected (user dismissed wallet prompt)
     OR failed (revert or network error)
```

Pending hashes are persisted to localStorage scoped to
`(chainId, registry, account, giftId, action)`. On reload, the app resumes
tracking without re-submitting. A pending hash from a different account or
network is ignored.

After confirmation, the page refetches contract state and, where applicable,
metadata. Phase-boundary crossings (`useLiveTime`) also trigger a contract
refetch.

---

## Key source files

| File | Purpose |
|---|---|
| `contracts/CheersGiftRegistry.sol` | Smart contract source |
| `contracts/test/CheersGiftRegistry.t.sol` | 77 Foundry tests (unit, fuzz, invariant) |
| `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json` | Compiled artifact |
| `src/lib/cheers-abi.ts` | Typed ABI — regenerate with `forge build` after contract changes |
| `src/lib/cheers-contract.ts` | Address, formatters, simulation, event verification |
| `src/lib/cheers-api.ts` | Backend adapter, EIP-712 builder, draft storage |
| `src/hooks/useGiftListing.ts` | Registry listing with bounded event query |
| `src/test/cheers.test.ts` | 54 unit tests: parsing, phase logic, invariant |
| `src/test/cheers-tx.test.ts` | 45 tests: tx sequencing, bytecode, event verification |
| `src/test/cheers-api.test.ts` | 50 tests: API adapter, EIP-712, challenge validation, recovery |
| `src/test/cheers-event.test.ts` | 18 tests: log extraction, emitter/field matching, logIndex |

---

## Deployment record

| Item | Value |
|---|---|
| Contract | `CheersGiftRegistry` |
| Address | `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` |
| Chain | Arc Mainnet (5042) |
| Deploy tx | `0x5599a6f5f27d74b36eeffafdabeb8df24e9bbcdd0829fa97d6231df2076a7d85` |
| Deploy block | 26623210 |
| Deploy method | `forge create --interactive --broadcast` (EIP-1559, type-2 receipt) |
| USDC (confirmed via `usdc()`) | `0x3600000000000000000000000000000000000000` |
| `nextGiftId` at deploy | 1 (Gift #1 created after deployment) |
| Source-verified | Yes — explorer.arc.io |

Full deployment notes: `arc-studio-plans/DEPLOY-PREFLIGHT.md`

---

## Testing

### Smart contract tests (Foundry)

```bash
bun run contracts:test    # forge test — 77 tests across 9 suites
```

Covers: `createGift`, `contribute`, `claim`, `refund`, exact timestamp boundaries
(open/closed at `giftAt` and `claimDeadline`), fuzz (amount accumulation,
accounting identity), and stateful invariant testing (128,000 calls per invariant
checking `totalContributed == totalClaimed + totalRefunded + remainingBalance`).

All tests use a local `MockUSDC` — not a fork of Arc Mainnet.

### Frontend tests (vitest)

```bash
bun run test              # 167 tests across 4 files
```

| File | Count | Covers |
|---|---|---|
| `cheers.test.ts` | 54 | Amount parsing, phase boundaries, accounting invariant, formatters |
| `cheers-tx.test.ts` | 45 | Bytecode gate, tx sequencing, approval vs. contribution independence, event verification |
| `cheers-api.test.ts` | 50 | canonicalJSON, payloadHash, buildTypedData, validateChallenge, metaSave state machine, 503 error handling |
| `cheers-event.test.ts` | 18 | Log extraction: emitter match, field mismatch, logIndex from receipt field vs. array position |

All frontend tests are pure logic — no DOM, no wagmi hooks, no live RPC calls.

---

## Verification status

### Confirmed end-to-end

- **Contract deployment** — `CheersGiftRegistry` deployed to Arc Mainnet at
  `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` via `forge create --interactive
  --broadcast` (EIP-1559, type-2 receipt). Source-verified on the Arc explorer.
- **`createGift` transaction** — Gift #1 created on-chain. Transaction hash:
  `0xb833e96c77ee980fc98578d9c99788497683f3bf0f89363708cdfc396ef5624d`.
  `GiftCreated` event decoded and verified by the frontend.
- **Gift #1 metadata save** — Title "Cheers First Mainnet Gift" stored in Supabase.
  The Supabase backend record was confirmed via `GET ?route=gift&giftId=1`.
  EIP-712 challenge, wallet signature, and execute call all succeeded.
- **Health and CORS** — Confirmed via curl with the preview `Origin` header.
  `registryReady: true`. Automatic browser `Origin` behavior not yet confirmed.
- **Forge unit tests** — 77/77 pass (unit, boundary, fuzz, invariant).
- **Frontend tests** — 167/167 pass across 4 test files (mocked: fetch, wallet,
  viem ABI encoding). No live RPC calls in the test suite.
- **Production build** — `bunx vite build` succeeds (19s).

### Not yet confirmed end-to-end

- **Contribution flow** — `ContributionMade` transaction, greeting save, and
  recovery path have not been executed with a real wallet. All logic is covered
  by mocked tests.
- **Claim flow** — No funded gift has been claimed. `simulateAndEstimate` and
  `verifyClaimedEvent` are tested with mocks; live accuracy depends on mainnet
  state.
- **Refund flow** — No expired unclaimed gift has been tested for contributor
  withdrawal end-to-end.
- **Browser fetch** — CORS confirmed via curl; automatic browser `Origin` and
  credential handling not yet confirmed through a real browser session.
- **Mobile layout at physical widths** — Reviewed in the sandbox dev server;
  not tested in a real mobile browser at 390px.
- **Frontend hosting** — Not yet deployed to `cheers.signalarc.fun` (Vercel).
  The production build succeeds locally.
- **WalletConnect** — QR-code wallet support requires a Reown Project ID
  (`VITE_WALLETCONNECT_ID`). Injected wallets work without it.

## Outstanding items
