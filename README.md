# SignalArc Cheers

**Group gifting in USDC. Pool contributions for one recipient.**

SignalArc Cheers lets a group of people each contribute USDC toward a gift for one
predetermined recipient. Contributors send funds directly into a smart contract on
Arc Mainnet. The recipient claims the pooled total during a defined window; if the
window closes unclaimed, each contributor can withdraw their own contribution.

Target domain: [cheers.signalarc.fun](https://cheers.signalarc.fun)

---

## What it does

- A creator sets a recipient wallet address, a future gift date, and a claim window
  (7, 14, or 30 days).
- Anyone with the share link can view the gift page and add USDC to the pool before
  the gift date arrives. The share link does not grant claim rights — only the
  designated recipient address can claim.
- At the gift date, the recipient initiates a claim transaction and receives the
  entire pooled balance in one transfer.
- If the recipient does not claim before the deadline, the gift expires. Each
  contributor can then initiate a separate refund transaction to withdraw their own
  contribution. Refunds are user-initiated; they do not happen automatically.

## What it does not do

- Random giveaways or first-come-first-claimed funds.
- Multiple recipients per gift.
- Automatic bill splitting or merchant purchases.
- Admin withdrawals or platform fees.
- Automatic refunds — contributors must initiate their own refund after the deadline.

---

## Network

| Property | Value |
|---|---|
| Chain | Arc Mainnet |
| Chain ID | 5042 |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Gas token | USDC (Arc uses USDC as the native gas asset) |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000` — 6 decimals |

Because Arc uses USDC as its native gas token, contributors pay both their USDC
contribution amount and the transaction gas fee from the same USDC balance. The
application estimates gas dynamically before each confirmation step; no fixed fee
is promised.

---

## Deployed contract

| Item | Value |
|---|---|
| Contract | `CheersGiftRegistry` |
| Address | `0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0` |
| Chain | Arc Mainnet (5042) |
| Deploy tx | `0x5599a6f5f27d74b36eeffafdabeb8df24e9bbcdd0829fa97d6231df2076a7d85` |
| Block | 26623210 |
| Explorer | [View on Arc Explorer](https://explorer.arc.io/address/0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0) |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Foundry](https://getfoundry.sh) for contract work
- A browser wallet (MetaMask, Rabby, Coinbase Wallet, or any injected EIP-1193 wallet)
  funded with USDC on Arc Mainnet

### Install and run

```bash
bun install
bun run dev        # starts Vite dev server at http://localhost:5173
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values (all three are required for
full functionality):

```
VITE_REGISTRY_ADDRESS=0x4aa7A36494b3C4894cC25357BdfEC96d4b3fE4b0
VITE_SUPABASE_URL=https://pewansbncyzxwuqltigc.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<browser-safe publishable key>
```

`VITE_SUPABASE_PUBLISHABLE_KEY` is a browser-safe key. Never add a Supabase
service-role key or any other secret to `.env` or frontend source.

When `VITE_REGISTRY_ADDRESS` is absent, the app displays "On-chain gifting is
coming soon." and disables all write actions.

### Optional

```
VITE_WALLETCONNECT_ID=<Reown project ID>
```

WalletConnect (QR-code mobile wallet support) is optional. The app works with
injected browser wallets without it.

---

## Test and build

```bash
# Frontend logic tests (pure, no RPC, no wallet)
bun run test                # 167 tests across 4 files

# Solidity contract tests (requires Foundry)
bun run contracts:test      # 77 tests: unit, fuzz, invariant

# Lint and typecheck
bun run check               # 0 errors expected

# Production build
bunx vite build
```

---

## Documentation

| Document | Contents |
|---|---|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | How to create, contribute, claim, and refund; wallet setup; worked example |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Contract rules, frontend architecture, data boundary, API protocol |
| [arc-studio-plans/PLAN.md](arc-studio-plans/PLAN.md) | Full implementation plan and phase history |
| [arc-studio-plans/DEPLOY-PREFLIGHT.md](arc-studio-plans/DEPLOY-PREFLIGHT.md) | Deployment verification and post-deploy checklist |

---

## Wallet stack

- **Connection:** ConnectKit + wagmi v2 + viem
- **Connectors:** Injected wallets (MetaMask, Rabby, etc.) and Coinbase Wallet
- **No custodial wallets, no Google/email login, no Circle API keys**
- **Metadata writes:** EIP-712 single-use signed messages — no login session required

---

## License

MIT
