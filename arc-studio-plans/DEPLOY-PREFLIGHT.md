# CheersGiftRegistry — Mainnet Deployment Preflight

**Prepared:** 2026-10-17  
**Target:** Arc Mainnet  
**Status:** Ready to deploy — stop here, review, then execute from your local machine.

---

## 1. Verified chain facts

| Parameter | Value | Source |
|---|---|---|
| Network | Arc Mainnet | Arc docs / onchain-facts.ts |
| Chain ID | **5042** | `eth_chainId` → `0x13b2` confirmed live against `https://rpc.mainnet.arc.io` |
| RPC URL | `https://rpc.mainnet.arc.io` | Arc docs + live RPC confirmed responding |
| Explorer | `https://explorer.arc.io` | Arc docs |
| EVM target | `paris` (required — see note below) | foundry.toml |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` | `eth_getCode` confirmed non-empty on mainnet |
| USDC decimals (ERC-20) | 6 | Arc contract-addresses docs |
| USDC decimals (native gas) | 18 | Arc docs — same balance, different view |

**EVM target note:** `foundry.toml` uses `evm_version = "paris"`. The Arc docs say Arc targets the Osaka EVM baseline, but the contract is pinned to OpenZeppelin 5.1.0 specifically because ≥5.2.0 uses the `mcopy` opcode (Cancun+). Until OZ 5.1.0 is known compatible with Osaka, keep `paris`. The contract itself uses no opcodes above Shanghai. Do not upgrade OZ or change evm_version without re-running all 77 Foundry tests.

---

## 2. Contract artifact

| Field | Value |
|---|---|
| Source | `contracts/CheersGiftRegistry.sol` |
| Compiled artifact | `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json` |
| ABI export (for frontend) | `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.abi.json` |
| Bytecode size | **3,516 bytes** (well under the 24,576-byte limit) |
| ABI entry count | 33 (4 events, 14 errors, 9 functions, 6 state variable getters) |
| Artifact is current | Yes — artifact mtime (16:34) is after source mtime (16:30) |
| Solidity version | 0.8.28 |
| Optimizer | enabled, 200 runs |

---

## 3. Constructor argument

The contract has exactly one constructor parameter:

```solidity
constructor(address _usdc)
```

**Mainnet value:** `0x3600000000000000000000000000000000000000`

This is the official USDC ERC-20 address on Arc Mainnet, confirmed by `eth_getCode` returning non-empty bytecode at this address on the live mainnet RPC.

**For `forge create`:** pass as `--constructor-args 0x3600000000000000000000000000000000000000`

---

## 4. Deployment method

### Why `bun run deploy:self` does NOT work for mainnet

`scripts/self-deploy.ts` routes through Circle Developer-Controlled Wallets + SCP API. The script explicitly filters to testnets only:

```ts
// from self-deploy.ts, listSupportedChains():
return facts.ONCHAIN_CHAINS.flatMap((chain) =>
  (chain.isTestnet && chain.scpBlockchain ? [chain.scpBlockchain] : [])
);
```

Arc Mainnet has `isTestnet: false` and no `scpBlockchain` entry in `onchain-facts.ts`. Running `bun run deploy:self` will print a usage error listing only testnet chains and exit. It will never reach mainnet.

### Correct mainnet method: `forge create` from your local terminal

Deployment is signed with **your own private key** on your own machine. The private key never enters Arc Studio, the sandbox, or any source file.

**Prerequisites on your local machine:**

1. Install Foundry: https://getfoundry.sh  
   Or install Arc Foundry (Arc's fork, handles Arc-specific protocol differences):  
   https://docs.arc.io/arc/tutorials/install-arc-foundry.md  
   Both will work for this contract; Arc Foundry is preferred for accurate gas estimation on Arc.

2. Have your deployer wallet's private key available in a **shell environment variable only** — never in a file you might commit.

3. Ensure the deployer address holds enough USDC on Arc Mainnet to cover deployment gas. Gas on Arc is paid in USDC (native view, 18 decimals). A contract of this size (~3,516 bytes) typically costs well under 1 USDC on Arc at current gas prices, but estimate before sending.

---

## 5. Exact deployment commands (Windows 11 compatible)

### Step 0 — Clone the repo to your local machine (if not already)

You will need the compiled artifact. Either:
- Clone the project repo and run `forge build` locally, OR
- Download `contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json` from Arc Studio (Code panel → right-click → Download)

### Step 1 — Set your private key (PowerShell, Windows 11)

```powershell
# PowerShell — the key is set as an environment variable, never written to disk
$env:PRIVATE_KEY = "0x<your-private-key-here>"
```

**Do not paste your private key into any file, chat, or source code.**  
If your key is in a hardware wallet or Ledger, use `forge create --ledger` instead and omit `--private-key`.

### Step 2 — Estimate gas before deploying (optional but recommended)

```powershell
forge create `
  --rpc-url https://rpc.mainnet.arc.io `
  --private-key $env:PRIVATE_KEY `
  --broadcast=false `
  --legacy `
  contracts/CheersGiftRegistry.sol:CheersGiftRegistry `
  --constructor-args 0x3600000000000000000000000000000000000000
```

Omitting `--broadcast` (or setting it to false) runs a dry-run simulation and shows the estimated gas without broadcasting.

### Step 3 — Deploy

The actual deployment used `--interactive --broadcast` (prompts for key in terminal, no env var needed):

```powershell
forge create `
  --rpc-url https://rpc.mainnet.arc.io `
  --interactive `
  --broadcast `
  contracts/CheersGiftRegistry.sol:CheersGiftRegistry `
  --constructor-args 0x3600000000000000000000000000000000000000 `
  --verify=false
```

Alternatively with `--private-key` (key in env var, not prompted):

```powershell
forge create `
  --rpc-url https://rpc.mainnet.arc.io `
  --private-key $env:PRIVATE_KEY `
  contracts/CheersGiftRegistry.sol:CheersGiftRegistry `
  --constructor-args 0x3600000000000000000000000000000000000000 `
  --verify=false
```

**Transaction type**: Arc Mainnet accepted an EIP-1559 type-2 transaction (the receipt `type` field was `"0x2"`). The `--legacy` flag is not required. If a type-2 deploy fails on your machine, add `--legacy` for a type-0 transaction.

**`--verify=false`**: Contract verification on the Arc explorer is a separate step and is not required for the contract to function.

Foundry will output:
```
Deployer: 0x<your-address>
Deployed to: 0x<contract-address>
Transaction hash: 0x<tx-hash>
```

### Step 4 (bash / Linux / macOS)

If running on bash instead of PowerShell:

```bash
export PRIVATE_KEY="0x<your-private-key-here>"

forge create \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key "$PRIVATE_KEY" \
  --legacy \
  contracts/CheersGiftRegistry.sol:CheersGiftRegistry \
  --constructor-args 0x3600000000000000000000000000000000000000 \
  --verify=false
```

---

## 6. Ledger hardware wallet (recommended for production)

If your deployer address is on a Ledger:

```powershell
forge create `
  --rpc-url https://rpc.mainnet.arc.io `
  --ledger `
  --legacy `
  contracts/CheersGiftRegistry.sol:CheersGiftRegistry `
  --constructor-args 0x3600000000000000000000000000000000000000
```

Foundry will prompt you to approve the transaction on the device. The private key never leaves the hardware.

---

## 7. Where the contract address and transaction hash are recorded

After deployment, record the address in **two places**:

### A. `.env` in the Arc Studio project (for the frontend)

```
VITE_REGISTRY_ADDRESS=0x<deployed-contract-address>
```

After editing `.env`, restart the Vite dev server — Vite reads env files only at startup, not via HMR.

### B. `AGENTS.md` (project memory)

Update the "Deployment" table in AGENTS.md with:
- Contract address
- Transaction hash
- Deployer address
- Deployment timestamp

### C. Supabase backend

The Supabase Edge Function backend must be told the registry address before `registryReady` becomes `true`. Contact the backend operator (or update the `REGISTRY_ADDRESS` secret in the Supabase project settings if you have access) with the deployed address and chain ID (5042).

---

## 8. Deployer address and balance

The deployer address is **your wallet** — the one whose private key you use in Step 3. Arc Studio does not know this address in advance and does not hold any funds.

**Check your deployer balance before deploying:**

```powershell
cast balance <your-address> --rpc-url https://rpc.mainnet.arc.io
```

The result is in native USDC units (18 decimals). For example, `1000000000000000000` = 1.000000 USDC. You need enough to cover deployment gas (~0.01–0.10 USDC at typical Arc gas prices, but measure with the dry-run in Step 2).

**The frontend wallet (the wallet users connect via ConnectKit) is NOT the deployer** and should not be used as the deployer. These are two separate addresses with separate roles.

---

## 9. Deployment transaction details available for review

| Item | Value |
|---|---|
| Contract | `CheersGiftRegistry` |
| Chain | Arc Mainnet, ID 5042 |
| Constructor arg | `address _usdc = 0x3600000000000000000000000000000000000000` |
| Bytecode size | 3,516 bytes |
| Signing method | Local `forge create` with your private key or Ledger |
| Gas token | USDC (native, 18 decimals) |
| Approximate gas cost | Measure with dry-run; expect < 0.10 USDC |
| Contract address | **Not yet known — determined at broadcast** |
| Transaction hash | **Not yet known — determined at broadcast** |

---

## 10. Post-deployment checklist

- [ ] Record contract address and tx hash in `AGENTS.md`
- [ ] Set `VITE_REGISTRY_ADDRESS=0x<address>` in `.env`, restart dev server
- [ ] Verify `useContractBytecode` returns `ok` in the app (connect wallet, open gift-detail or create-gift page)
- [ ] Notify Supabase backend operator of the registry address to enable `registryReady: true`
- [ ] Test `createGift` with a small gift using a test wallet on mainnet
- [ ] Verify `GiftCreated` event appears in the Arc explorer
- [ ] Test metadata save flow (challenge → sign → execute) for a real gift
- [ ] Update `arc-studio-plans/PLAN.md` phase table to mark Phase 7 in progress

---

## 11. What to do if deployment fails

- **"insufficient funds"**: Your deployer wallet does not have enough USDC on Arc Mainnet for gas. Add USDC via CCTP bridge from another chain.
- **"nonce too low"**: A previous transaction from the same deployer is still pending. Wait for it to confirm, then retry.
- **"transaction type not supported"**: Try adding `--legacy` flag. The actual deployment used `--interactive --broadcast` (type-2, EIP-1559) without `--legacy`.
- **Constructor reverts** (`"CheersGiftRegistry: zero usdc"`): The `--constructor-args` address was `0x0000...0000`. Verify the USDC address.
- **Artifact stale**: If you edited the contract source, rebuild with `forge build` before deploying.

---

## 12. Security reminders

- Never put `PRIVATE_KEY` in `.env`, any source file, or any git-tracked file.
- Never share your private key or seed phrase in this chat or any other chat.
- `VITE_REGISTRY_ADDRESS` is the deployed contract address — a public value. It is safe to put in `.env` and commit.
- The Supabase publishable key (`VITE_SUPABASE_PUBLISHABLE_KEY`) is browser-safe. Do not add a service-role key or secret to `.env`.
- The contract has no admin keys, upgrade proxy, or owner address. Once deployed, it cannot be paused, upgraded, or drained by any admin. The only way to recover funds is through the contract's own `claim` and `refund` functions.
