# SignalArc Cheers — User Guide

**Group gifting in USDC. Pool contributions for one recipient.**

---

## Contents

1. [How Cheers works](#how-cheers-works)
2. [What you need](#what-you-need)
3. [Worked example: birthday group gift](#worked-example-birthday-group-gift)
4. [Creating a gift](#creating-a-gift)
5. [Contributing to a gift](#contributing-to-a-gift)
6. [Claiming a gift (recipient)](#claiming-a-gift-recipient)
7. [Refunding a contribution](#refunding-a-contribution)
8. [Gift phases and eligibility](#gift-phases-and-eligibility)
9. [Funding targets](#funding-targets)
10. [Metadata and greetings](#metadata-and-greetings)
11. [Metadata recovery](#metadata-recovery)
12. [Limitations and scope](#limitations-and-scope)

---

## How Cheers works

Cheers is a group gifting protocol built on Arc Mainnet. A creator sets up a gift
for a specific recipient wallet address. Anyone with the gift link can contribute
USDC to the pool before the gift date arrives. When the gift date comes, the
recipient logs in with their wallet, visits the gift page, and initiates a claim
transaction to receive the pooled USDC in full.

**Fund flow:**

```
Contributors' wallets
      ↓  contribute()
CheersGiftRegistry contract
      ↓  claim()
Recipient's wallet
```

If the recipient does not claim before the deadline, contributors can each
initiate a refund transaction to recover their own contribution.

**The share link does not grant claim rights.** Anyone can view and contribute
via the link; only the wallet address set at creation time can claim.

---

## What you need

- A browser wallet (MetaMask, Rabby, Coinbase Wallet, or any injected EIP-1193
  wallet) connected to **Arc Mainnet (chain ID 5042)**
- USDC on Arc Mainnet in your wallet. On Arc, USDC is both the payment token
  and the gas token — you pay the contribution amount plus a small gas fee from
  the same USDC balance
- No account, no email, no password. Your wallet address is your identity

**Gas cost:** The app estimates the gas fee dynamically before each confirmation.
The fee is a small fraction of 1 USDC at current Arc gas prices, but no fixed
amount is promised. You will see the estimate before approving any transaction.

---

## Worked example: birthday group gift

**Scenario:** Five friends want to pool $50 USDC as a birthday gift for a friend
whose wallet address they know. The friend's birthday is in two weeks.

**Step 1 — Creator sets up the gift**

One friend (the creator) visits the app, connects their wallet, and clicks
"Create a gift." They enter:

- Recipient: the birthday person's wallet address
- Gift date: two weeks from now (contributions close at this date and time)
- Claim window: 30 days (the recipient has 30 days after the gift date to claim)
- Title: "Happy birthday!" (saved as metadata, not stored on-chain)

The creator approves the `createGift` transaction. The app generates a shareable
gift link: `cheers.signalarc.fun/#/gift/2` (or whichever ID the contract assigns).

**Step 2 — Friends contribute**

Each friend opens the link, connects their wallet, and contributes their share.
For a $50 total across 5 friends, each contributes $10 USDC. Contributions do
not need to be equal — each person contributes what they choose.

Each contribution is two wallet confirmations:
1. Approve the registry contract to spend the USDC amount (if not already approved).
2. Confirm the contribution to the contract.

Each friend can optionally add a display name and a greeting message (up to 280
characters), saved to the Supabase backend after the contribution confirms.

**Step 3 — Recipient claims**

On or after the gift date, the birthday person opens the gift link, connects their
wallet, and clicks "Claim gift." They approve one transaction. The full pooled
amount ($50 USDC, minus the small gas fee) arrives in their wallet.

**Step 4 — (If unclaimed) Contributors refund**

If the birthday person does not claim by the deadline, each contributor can visit
the gift page, connect their wallet, and initiate a refund to recover their own
$10 USDC. Refunds are individual — each person must initiate their own.

---

## Creating a gift

1. Connect your wallet to Arc Mainnet.
2. Click "Create a gift" or the `+` button in the navigation.
3. Fill in the form:
   - **Recipient address:** the wallet address that will receive the pooled USDC.
     This cannot be changed after creation. The share link does not grant claim
     rights — only this address can claim.
   - **Gift date and time:** when contributions close and claiming becomes available.
     Must be in the future. Displayed in your local timezone.
   - **Claim window:** 7, 14, or 30 days. The recipient must claim before
     `gift date + claim window`.
   - **Title** (optional, 1–100 characters): displayed on the gift page.
   - **Description** (optional, up to 500 characters): shown as context for contributors.
   - **Funding target** (optional): a USDC display goal. Visual only — reaching the
     target is not required for claiming, and the contract does not enforce it.
4. Review the recipient address, dates, and timezone on the confirmation screen.
5. Approve the `createGift` transaction. No USDC is transferred at this step.
6. After confirmation, save metadata (title and description) with one EIP-712
   signature. This signature authorizes saving text metadata only — it does not
   transfer USDC or approve spending.
7. Copy and share the gift link.

---

## Contributing to a gift

1. Open a gift link or navigate to a gift by ID.
2. Connect your wallet to Arc Mainnet.
3. The gift must be in the **Collecting** phase: `block.timestamp < giftAt`. The
   contribution form is hidden in other phases.
4. Enter the USDC amount you want to contribute (positive, up to 6 decimal places).
5. If the registry contract does not already have an allowance for this amount, you
   will first be asked to approve the exact amount. This is a separate transaction.
   Approving does not contribute yet.
6. After the approval confirms (or if the allowance was already sufficient), confirm
   the contribution in a second wallet prompt.
7. After the contribution confirms on-chain, you can optionally add a display name
   and a greeting message. One EIP-712 signature saves this metadata. This step is
   optional and does not affect the on-chain contribution.

**On Arc, USDC is the gas token.** You will spend your contribution amount plus a
small gas fee from the same USDC balance. The estimated gas fee is shown before
each confirmation.

---

## Claiming a gift (recipient)

1. Open the gift link and connect the **recipient wallet** — the address set when
   the gift was created. Other wallets cannot claim.
2. The gift must be in the **Ready to claim** phase:
   `giftAt <= block.timestamp < claimDeadline`.
3. There must be a pooled balance to claim. The contract enforces this: `claim()`
   reverts if `totalContributed == 0`. The claim button is disabled and a notice
   is shown when the claim window is open but no funds have been contributed yet.
4. Click "Claim gift" and confirm the transaction. The contract transfers the full
   pooled balance to the recipient address in one transaction.
5. Claiming can only happen once. After a successful claim, the gift is **Closed**.

---

## Refunding a contribution

If a gift is not claimed before the deadline, contributors can withdraw their own
contributions. Refunds are not automatic.

1. Open the gift page and connect the **contributor wallet** — the wallet that made
   the original contributions.
2. The gift must be in the **Refundable** phase:
   `block.timestamp >= claimDeadline AND totalClaimed == 0`.
3. Click "Withdraw my contribution" and confirm the transaction.
4. The contract transfers your aggregated contribution back to your wallet.
5. Each contributor can refund only once, and only their own contribution. There is
   no expiry on refund rights after the deadline passes.

---

## Gift phases and eligibility

| Phase | Condition | Contributions | Claim | Refund |
|---|---|---|---|---|
| **Collecting** | `block.timestamp < giftAt` | Open | Not yet | Not yet |
| **Ready to claim** | `giftAt <= now < claimDeadline` | Closed | Recipient only | Not yet |
| **Claim expired** | `now >= claimDeadline`, unclaimed | Closed | No | Contributors only |
| **Closed** | `totalClaimed > 0` | Closed | Done | No |

**Important boundaries:**
- At exactly `block.timestamp == giftAt`, contributions close and claiming opens
  simultaneously. The contract enforces these conditions.
- At exactly `block.timestamp == claimDeadline`, claiming reverts and refunding
  becomes available.
- The contract is the authority on all balances, deadlines, and eligibility. The
  application reads state directly from the contract.

---

## Funding targets

The optional funding target shown on gift pages is for display only. It gives
contributors a sense of the intended total, but:

- The contract does not enforce or check the target.
- The recipient can only claim when funds have been contributed. The contract
  enforces this with a `ZeroAmount` revert; the frontend disables the claim
  button and shows "Claim window open · No funds contributed yet" when the
  window is open but the pool is empty.
- Contributions can exceed the target without restriction.
- The target cannot be changed after the gift is created.

---

## Metadata and greetings

Gift titles, descriptions, targets, contributor display names, and greeting messages
are stored in Supabase. They are not stored on the blockchain.

**What this means:**
- Titles and greetings can be read by anyone who knows the gift ID (they are not
  private).
- The contract balance, recipient, and deadlines are determined by the contract —
  not by Supabase. A metadata read failure does not mean the gift does not exist.
- The first creator to save metadata for a gift locks it. Gift metadata (title,
  description, target) is immutable once saved.
- Contribution greeting messages are immutable once saved. An empty message can
  be filled in once.

**Authentication:** Metadata writes use an EIP-712 wallet signature. No login or
session is required. Each signature is tied to a single action, a nonce, an
expiry (5 minutes), and the registry contract address. Signing authorizes
saving text metadata only — it does not transfer USDC, create an on-chain
transaction, or approve token spending.

---

## Metadata recovery

If an on-chain transaction (gift creation or contribution) confirms but the
metadata save fails, the app shows a recovery notice. You can retry the metadata
save from that notice without sending another blockchain transaction or payment.

The retry uses the same confirmed transaction hash and gift ID. A new EIP-712
signature is requested (the original may have expired). The on-chain transaction
is not repeated.

If the metadata save continues to fail, your on-chain contribution is still
recorded and your financial rights (claim or refund eligibility) are not affected.
The gift will appear as "Gift #N" until metadata is saved.

---

## Limitations and scope

Cheers V1 is a focused group gifting tool. It does not support:

- **Multiple recipients per gift.** One gift, one recipient.
- **Random or first-come giveaways.** Only the designated recipient can claim.
- **Automatic refunds.** Contributors must initiate their own refund after the
  deadline.
- **Automatic bill splitting.** Contribution amounts are chosen freely by each
  contributor.
- **Automatic merchant purchases.** The contract transfers USDC to a wallet address
  only.
- **Cancellation or admin withdrawal.** Once a gift is created, the creator cannot
  cancel it or retrieve the pooled funds. Only the recipient can claim, or
  contributors can refund after the deadline.
- **Application fees.** The contract charges no fee. Participants pay only the
  Arc Mainnet gas fee for each transaction.
- **Smart-account wallets (V1).** V1 accepts standard 65-byte EOA signatures for
  metadata writes. Smart-account wallets can hold USDC and receive gifts but
  cannot save metadata in V1.

---

## Verification status

The following flows have been confirmed end-to-end on Arc Mainnet:

- Contract deployment and source verification.
- Gift #1 creation (`createGift` transaction confirmed, `GiftCreated` event verified).
- Gift #1 metadata save (EIP-712 challenge, wallet signature, and execute all
  succeeded; Supabase record confirmed).

The following flows have not yet been confirmed end-to-end and are covered only
by mocked tests:

- Contribution (`ContributionMade` transaction and greeting save).
- Claim (funded gift claimed by recipient).
- Refund (contributor withdrawal after claim deadline).
- Real browser fetch behavior (CORS confirmed via curl; automatic `Origin`
  handling in a live browser session not yet confirmed).
- Mobile layout at physical widths in a real browser.
