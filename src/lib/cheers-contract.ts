/**
 * CheersGiftRegistry contract helpers.
 *
 * Registry address comes from VITE_REGISTRY_ADDRESS. When the variable is absent
 * or empty, registryAddress returns null and the UI shows "Contract deployment pending".
 *
 * Never hardcode a contract address here — set VITE_REGISTRY_ADDRESS in .env once
 * the contract is deployed to Arc Mainnet.
 */

import { createPublicClient, http, type Abi, type SimulateContractParameters, decodeEventLog, parseAbiItem } from 'viem'
import { arc } from 'viem/chains'
import { ARC_MAINNET_ID } from '../config'
import { Amount, usdcDecimalsFor, gasTokenDecimalsFor, gasTokenToUsdc } from '../onchain-money'
import { CHEERS_ABI } from './cheers-abi'

// ── Contract address ──────────────────────────────────────────────────────────

/** Returns the deployed registry address, or null if not yet configured. */
export function registryAddress(): `0x${string}` | null {
  const raw = import.meta.env.VITE_REGISTRY_ADDRESS as string | undefined
  if (!raw || raw.trim() === '' || raw.trim() === '0x') return null
  return raw.trim() as `0x${string}`
}

/** True when the registry is configured and actions are available. */
export function isRegistryConfigured(): boolean {
  return registryAddress() !== null
}

// ── Chain constant ────────────────────────────────────────────────────────────

export const CHAIN_ID = ARC_MAINNET_ID

// ── Phase enum (mirrors the Solidity Phase enum) ─────────────────────────────

export enum GiftPhase {
  OPEN       = 0, // contributions accepted, giftAt not yet reached
  CLAIMABLE  = 1, // giftAt reached, claimDeadline not yet passed
  REFUNDABLE = 2, // claimDeadline passed, recipient did not claim
  CLOSED     = 3, // recipient claimed; no further actions
}

export const PHASE_LABELS: Record<GiftPhase, string> = {
  [GiftPhase.OPEN]:       'Collecting',
  [GiftPhase.CLAIMABLE]:  'Ready to claim',
  [GiftPhase.REFUNDABLE]: 'Claim expired',
  [GiftPhase.CLOSED]:     'Claimed',
}

export const PHASE_COLORS: Record<GiftPhase, string> = {
  [GiftPhase.OPEN]:       '#22c55e', // --success (dark-adapted green)
  [GiftPhase.CLAIMABLE]:  '#D97706', // --accent  (amber)
  [GiftPhase.REFUNDABLE]: '#f87171', // --danger  (dark-adapted red)
  [GiftPhase.CLOSED]:     '#7a8299', // --muted
}

/**
 * Balance-aware badge label.
 *
 * When `totalContributed` is provided and equals 0n, the label reflects
 * the true state for the recipient:
 *   CLAIMABLE + 0n → "No funds"          (claim window open, but nothing pooled)
 *   REFUNDABLE + 0n → "Claim expired · No funds"  (window closed, nothing to refund)
 *
 * When `totalContributed` is undefined (not yet loaded), falls back to the
 * standard PHASE_LABELS so callers never show a misleading label during loading.
 *
 * The contract phase is not modified — this is presentation only.
 */
export function displayLabel(phase: GiftPhase, totalContributed?: bigint): string {
  if (totalContributed === 0n) {
    if (phase === GiftPhase.CLAIMABLE)  return 'No funds'
    if (phase === GiftPhase.REFUNDABLE) return 'Claim expired · No funds'
  }
  return PHASE_LABELS[phase]
}

/**
 * Balance-aware badge color.
 *
 * CLAIMABLE with zero funds uses a muted amber to signal the window is open
 * but there is nothing to act on. REFUNDABLE with zero funds is gray (no
 * action available to anyone). Other phases use standard PHASE_COLORS.
 */
export function displayColor(phase: GiftPhase, totalContributed?: bigint): string {
  if (totalContributed === 0n) {
    if (phase === GiftPhase.CLAIMABLE)  return '#a16207' // muted amber — window open, no funds
    if (phase === GiftPhase.REFUNDABLE) return '#7a8299' // gray — no action available
  }
  return PHASE_COLORS[phase]
}

// ── Gift data shape (returned by getGift) ────────────────────────────────────

export interface GiftData {
  recipient: `0x${string}`
  giftAt: bigint
  claimDeadline: bigint
  totalContributed: bigint
  totalClaimed: bigint
  totalRefunded: bigint
}

/** remainingBalance = totalContributed - totalClaimed - totalRefunded */
export function remainingBalance(g: GiftData): bigint {
  return g.totalContributed - g.totalClaimed - g.totalRefunded
}

/** Derive phase from on-chain timestamps; mirrors getPhase() in the contract. */
export function derivePhase(g: GiftData, nowSec: bigint): GiftPhase {
  if (g.totalClaimed > 0n) return GiftPhase.CLOSED
  if (nowSec < g.giftAt)   return GiftPhase.OPEN
  if (nowSec < g.claimDeadline) return GiftPhase.CLAIMABLE
  return GiftPhase.REFUNDABLE
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format a USDC raw bigint (6 decimals) as "$X.XX". */
export function fmtUsdc(raw: bigint): string {
  const formatted = Amount.fromRaw(raw, usdcDecimalsFor(CHAIN_ID)).toFixed(2)
  return `$${formatted}`
}

/** Format a Unix timestamp (seconds) as a human-readable date string. */
export function fmtDate(unixSec: bigint): string {
  const d = new Date(Number(unixSec) * 1000)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Format a Unix timestamp (seconds) as a relative countdown string. */
export function fmtCountdown(unixSec: bigint, nowSec: bigint): string {
  const diff = Number(unixSec - nowSec)
  if (diff <= 0) return 'now'
  const days  = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  if (days > 0)  return `${days}d ${hours}h`
  const mins = Math.floor((diff % 3600) / 60)
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/** Shorten a wallet address for display. */
export function fmtAddress(addr: string): string {
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

// ── Claim durations (seconds) ─────────────────────────────────────────────────

export const CLAIM_DURATIONS = [
  { label: '7 days',  seconds: 7n  * 86400n },
  { label: '14 days', seconds: 14n * 86400n },
  { label: '30 days', seconds: 30n * 86400n },
] as const

export const DEFAULT_CLAIM_DURATION_IDX = 2 // 30 days

// ── USDC ERC-20 address on Arc Mainnet ────────────────────────────────────────

/** The canonical USDC ERC-20 address on Arc Mainnet, from onchain-facts. */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const

// ── Amount parsing ────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true;  raw: bigint }
  | { ok: false; error: string }

/**
 * Parse a user-entered USDC string (e.g. "12.50") into a 6-decimal bigint.
 * Returns { ok: false, error } for invalid, negative, zero, or > 6 decimal places.
 */
export function parseContributionAmount(input: string): ParseResult {
  const s = input.trim()
  if (!s) return { ok: false, error: 'Enter an amount' }

  // Reject anything that is not a plain positive decimal
  if (!/^\d+(\.\d*)?$/.test(s) && !/^\.\d+$/.test(s))
    return { ok: false, error: 'Enter a valid number' }

  const dotIdx = s.indexOf('.')
  const fractionPart = dotIdx === -1 ? '' : s.slice(dotIdx + 1)
  if (fractionPart.length > 6)
    return { ok: false, error: 'At most 6 decimal places' }

  try {
    const whole    = dotIdx === -1 ? s : s.slice(0, dotIdx)
    const fraction = fractionPart.padEnd(6, '0')
    const raw = BigInt(whole === '' ? '0' : whole) * 1_000_000n + BigInt(fraction)
    if (raw === 0n) return { ok: false, error: 'Amount must be greater than zero' }
    return { ok: true, raw }
  } catch {
    return { ok: false, error: 'Enter a valid number' }
  }
}

// ── ABI error decoder ─────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  AlreadyClaimed:           'This gift has already been claimed.',
  AlreadyRefunded:          'You have already withdrawn your contribution.',
  ClaimWindowClosed:        'The claim window has passed.',
  ClaimWindowNotOpen:       'The gift date has not arrived yet.',
  ContributionWindowClosed: 'Contributions closed when the gift date arrived.',
  GiftDoesNotExist:         'This gift does not exist.',
  InvalidClaimDuration:     'Invalid claim window duration.',
  InvalidGiftAt:            'Gift date must be in the future.',
  InvalidRecipient:         'Invalid recipient address.',
  NotContributor:           'Only contributors can request a refund.',
  NotRecipient:             'Only the recipient can claim this gift.',
  RefundWindowNotOpen:      'Refunds are only available after the claim window expires.',
  ZeroAmount:               'Amount must be greater than zero.',
  ReentrancyGuardReentrantCall: 'Reentrancy detected.',
}

/** Extract a human-readable message from a wagmi/viem error. */
export function decodeContractError(err: unknown): string {
  if (!err) return 'Unknown error.'
  const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))
  for (const [name, friendly] of Object.entries(ERROR_MESSAGES)) {
    if (msg.includes(name)) return friendly
  }
  if (msg.includes('User rejected') || msg.includes('user rejected'))
    return 'Transaction cancelled.'
  if (msg.includes('insufficient funds') || msg.includes('transfer amount exceeds balance'))
    return 'Insufficient USDC balance.'
  if (msg.includes('transfer amount exceeds allowance') || msg.includes('ERC20: insufficient allowance'))
    return 'USDC spending not yet approved. Complete the approval step first.'
  if (msg.includes('replacement fee too low') || msg.includes('nonce too low'))
    return 'Transaction replaced or cancelled.'
  return 'Transaction failed. Check your wallet and try again.'
}

// ── Simulation and gas estimation ─────────────────────────────────────────────

/**
 * A viem public client for Arc Mainnet, used for simulateContract and
 * estimateContractGas. Created once at module load; shared across all callers.
 */
export const arcPublicClient = createPublicClient({
  chain: arc,
  transport: http('https://rpc.mainnet.arc.io'),
})

export interface SimulateResult {
  ok: true
  gasEstimateUsdc: string  // human-readable e.g. "~$0.01 USDC"
}

export interface SimulateFailure {
  ok: false
  error: string
}

/**
 * Simulate a contract call and estimate the gas fee in USDC.
 *
 * On Arc, gas is paid from the same pool as USDC. The estimate converts:
 *   gasUnits × gasPrice (18-decimal native) → 6-decimal USDC display.
 *
 * The returned fee is an estimate only — the actual fee charged by the
 * network may differ. We show it as "~$X.XX USDC" and include a caveat.
 */
export async function simulateAndEstimate<TAbi extends Abi>(
  params: SimulateContractParameters<TAbi>,
  account: `0x${string}`,
): Promise<SimulateResult | SimulateFailure> {
  try {
    // 1. Simulate — this will throw if the call would revert
    await arcPublicClient.simulateContract(
      { ...params, account } as Parameters<typeof arcPublicClient.simulateContract>[0]
    )

    // 2. Estimate gas units
    const gasUnits = await arcPublicClient.estimateContractGas(
      { ...params, account } as Parameters<typeof arcPublicClient.estimateContractGas>[0]
    )

    // 3. Get current gas price (baseFee + tip)
    const gasPrice = await arcPublicClient.getGasPrice()

    // 4. Calculate fee in native units (18 decimals on Arc)
    const feeNative = gasUnits * gasPrice

    // 5. Wrap in Amount using gas-token decimals, then convert to USDC decimals
    const gasDecimals = gasTokenDecimalsFor(CHAIN_ID)
    const feeNativeAmount = Amount.fromRaw(feeNative, gasDecimals)
    const feeUsdcAmount = gasTokenToUsdc(CHAIN_ID, feeNativeAmount)

    // 6. Format with 4 decimal places to show micro-cent precision
    return { ok: true, gasEstimateUsdc: `~$${feeUsdcAmount.toFixed(4)} USDC` }
  } catch (err) {
    return { ok: false, error: decodeContractError(err) }
  }
}

// ── Event verification helpers ────────────────────────────────────────────────

const CONTRIBUTED_ABI_ITEM = parseAbiItem(
  'event ContributionMade(uint256 indexed giftId, address indexed contributor, uint256 amount, uint256 totalContributed)'
)

const GIFT_CLAIMED_ABI_ITEM = parseAbiItem(
  'event GiftClaimed(uint256 indexed giftId, address indexed recipient, uint256 amount)'
)

const CONTRIBUTION_REFUNDED_ABI_ITEM = parseAbiItem(
  'event ContributorRefunded(uint256 indexed giftId, address indexed contributor, uint256 amount)'
)

/** Receipt log shape returned by wagmi's useWaitForTransactionReceipt */
export interface TxReceiptLog {
  /** The address of the contract that emitted this log. */
  address?: `0x${string}`
  topics?: readonly `0x${string}`[]
  data?: `0x${string}`
  /**
   * The canonical on-chain log index within the block.
   * Wagmi returns this as number | null; null means the RPC did not include it.
   * This is NOT the same as the log's position in the receipt.logs array —
   * other transactions in the same block may have logs before this one.
   */
  logIndex?: number | null
}

/** Receipt shape returned by wagmi's useWaitForTransactionReceipt */
export interface TxReceipt {
  status: 'success' | 'reverted'
  logs: ReadonlyArray<TxReceiptLog>
  transactionHash: `0x${string}`
}

export interface EventVerifyOk<T> {
  ok: true
  args: T
  /**
   * The canonical on-chain logIndex of the matched log (from the RPC receipt).
   * Null when the RPC omitted logIndex — in that case the caller must not
   * fall back to the array position; retain the tx hash for recovery instead.
   */
  logIndex: number | null
}
export interface EventVerifyFail  { ok: false; error: string }

/** Verify a ContributionMade event in the receipt for the given giftId and contributor.
 *
 * Matching rules (all must hold):
 *  1. log.address matches the configured registry (case-insensitive).
 *  2. topic0 decodes as ContributionMade.
 *  3. giftId == expectedGiftId.
 *  4. contributor == expectedContributor (case-insensitive).
 *  5. amount == expectedAmount.
 *
 * Returns the matched log's canonical logIndex (may be null if the RPC omitted it).
 * The caller must NOT substitute the array position when logIndex is null.
 */
export function verifyContributedEvent(
  receipt: TxReceipt,
  expectedGiftId: bigint,
  expectedContributor: `0x${string}`,
  expectedAmount: bigint,
  expectedRegistry?: `0x${string}`,
): EventVerifyOk<{ giftId: bigint; contributor: `0x${string}`; amount: bigint }> | EventVerifyFail {
  if (receipt.status !== 'success')
    return { ok: false, error: 'Transaction was reverted on chain.' }

  for (const log of receipt.logs) {
    try {
      if (!log.topics) continue
      // Rule 1: emitter must be the registry contract (when provided)
      if (expectedRegistry && log.address && log.address.toLowerCase() !== expectedRegistry.toLowerCase())
        continue
      const decoded = decodeEventLog({ abi: [CONTRIBUTED_ABI_ITEM], topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data })
      if (decoded.eventName !== 'ContributionMade') continue
      const args = decoded.args as { giftId: bigint; contributor: `0x${string}`; amount: bigint }
      // Rules 3–5: exact field match
      if (
        args.giftId === expectedGiftId &&
        args.contributor.toLowerCase() === expectedContributor.toLowerCase() &&
        args.amount === expectedAmount
      ) {
        return {
          ok: true,
          args,
          // logIndex is the canonical on-chain index, not the array position
          logIndex: log.logIndex ?? null,
        }
      }
    } catch { /* not this log */ }
  }
  return { ok: false, error: 'Contribution confirmed but event not found. Check the explorer.' }
}

/** Verify a GiftClaimed event in the receipt for the given giftId. */
export function verifyClaimedEvent(
  receipt: TxReceipt,
  expectedGiftId: bigint,
  expectedRecipient: `0x${string}`,
): EventVerifyOk<{ giftId: bigint; recipient: `0x${string}`; amount: bigint }> | EventVerifyFail {
  if (receipt.status !== 'success')
    return { ok: false, error: 'Transaction was reverted on chain.' }

  for (const log of receipt.logs) {
    try {
      if (!log.topics) continue
      const decoded = decodeEventLog({ abi: [GIFT_CLAIMED_ABI_ITEM], topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data })
      if (decoded.eventName !== 'GiftClaimed') continue
      const args = decoded.args
      if (
        args.giftId === expectedGiftId &&
        args.recipient.toLowerCase() === expectedRecipient.toLowerCase()
      ) return { ok: true, args, logIndex: log.logIndex ?? null }
    } catch { /* not this log */ }
  }
  return { ok: false, error: 'Claim confirmed but event not found. Check the explorer.' }
}

/** Verify a ContributionRefunded event in the receipt for the given giftId. */
export function verifyRefundedEvent(
  receipt: TxReceipt,
  expectedGiftId: bigint,
  expectedContributor: `0x${string}`,
): EventVerifyOk<{ giftId: bigint; contributor: `0x${string}`; amount: bigint }> | EventVerifyFail {
  if (receipt.status !== 'success')
    return { ok: false, error: 'Transaction was reverted on chain.' }

  for (const log of receipt.logs) {
    try {
      if (!log.topics) continue
      const decoded = decodeEventLog({ abi: [CONTRIBUTION_REFUNDED_ABI_ITEM], topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data })
      if (decoded.eventName !== 'ContributorRefunded') continue
      const args = decoded.args
      if (
        args.giftId === expectedGiftId &&
        args.contributor.toLowerCase() === expectedContributor.toLowerCase()
      ) return { ok: true, args, logIndex: log.logIndex ?? null }
    } catch { /* not this log */ }
  }
  return { ok: false, error: 'Refund confirmed but event not found. Check the explorer.' }
}

// ── Re-export ABI for callers that import from cheers-contract ────────────────
// (avoids circular imports by ensuring the ABI is always available here)
export { CHEERS_ABI }
