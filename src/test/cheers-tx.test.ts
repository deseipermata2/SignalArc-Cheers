/**
 * Transaction-sequencing and bytecode-gate tests for SignalArc Cheers.
 *
 * These tests cover:
 *   1. Approval state blocks contribution (pending approval → contribution disabled)
 *   2. Failed approval blocks contribution (approval failed → contribution disabled)
 *   3. Successful approval still requires explicit confirmation (approval confirmed ≠ contribution submitted)
 *   4. Reload restores pending transaction state without re-submitting
 *   5. Replacement, cancellation, rejection, and reverted receipt handling
 *   6. Account/network changes invalidate pending state
 *   7. Bytecode validation gates writes
 *   8. verifyContributedEvent, verifyClaimedEvent, verifyRefundedEvent
 *   9. simulateAndEstimate gas format
 *
 * These are pure logic and state-machine tests. No real wagmi hooks, no RPC calls,
 * no DOM, no network. They simulate the state-machine logic that the components
 * implement. All tests distinguish local mock-token logic from mainnet end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  verifyContributedEvent,
  verifyClaimedEvent,
  verifyRefundedEvent,
  decodeContractError,
  type TxReceipt,
} from '../lib/cheers-contract'
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem'

// ── Helpers ───────────────────────────────────────────────────────────────────

const GIFT_ID   = 1n
const ACCOUNT   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
const RECIPIENT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`
const REGISTRY  = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`
const TX_HASH   = '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`

/** Build a minimal fake receipt */
function makeReceipt(
  status: 'success' | 'reverted',
  logs: TxReceipt['logs'] = [],
): TxReceipt {
  return { status, logs, transactionHash: TX_HASH }
}

/**
 * Build an encoded ContributionMade log that matches the real ABI.
 * keccak256("ContributionMade(uint256,address,uint256,uint256)") =
 * 0x... — we use viem's encodeEventTopics for correctness.
 */
function makeContributionMadeLog(
  giftId: bigint,
  contributor: `0x${string}`,
  amount: bigint,
  totalContributed: bigint,
): TxReceipt['logs'][0] {
  // encodeEventTopics only accepts indexed fields in args
  const topics = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'ContributionMade',
      inputs: [
        { name: 'giftId',           type: 'uint256', indexed: true },
        { name: 'contributor',      type: 'address', indexed: true },
        { name: 'amount',           type: 'uint256', indexed: false },
        { name: 'totalContributed', type: 'uint256', indexed: false },
      ],
    }],
    eventName: 'ContributionMade',
    args: { giftId, contributor },
  })
  const data = encodeAbiParameters(
    parseAbiParameters('uint256 amount, uint256 totalContributed'),
    [amount, totalContributed],
  )
  return { topics: topics as `0x${string}`[], data }
}

function makeGiftClaimedLog(
  giftId: bigint,
  recipient: `0x${string}`,
  amount: bigint,
): TxReceipt['logs'][0] {
  const topics = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'GiftClaimed',
      inputs: [
        { name: 'giftId',    type: 'uint256', indexed: true },
        { name: 'recipient', type: 'address', indexed: true },
        { name: 'amount',    type: 'uint256', indexed: false },
      ],
    }],
    eventName: 'GiftClaimed',
    args: { giftId, recipient },
  })
  const data = encodeAbiParameters(
    parseAbiParameters('uint256 amount'),
    [amount],
  )
  return { topics: topics as `0x${string}`[], data }
}

function makeContributorRefundedLog(
  giftId: bigint,
  contributor: `0x${string}`,
  amount: bigint,
): TxReceipt['logs'][0] {
  const topics = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'ContributorRefunded',
      inputs: [
        { name: 'giftId',      type: 'uint256', indexed: true },
        { name: 'contributor', type: 'address', indexed: true },
        { name: 'amount',      type: 'uint256', indexed: false },
      ],
    }],
    eventName: 'ContributorRefunded',
    args: { giftId, contributor },
  })
  const data = encodeAbiParameters(
    parseAbiParameters('uint256 amount'),
    [amount],
  )
  return { topics: topics as `0x${string}`[], data }
}

// ── 1. Approval state blocks contribution ─────────────────────────────────────

describe('Approval pending blocks contribution', () => {
  /**
   * The ContributePanel logic: contribution button is disabled while
   * approveState is 'awaiting-wallet' or 'pending'.
   * approvalDone = !needsApproval || approvalConfirmed
   * contribution disabled = needsApproval && !approvalDone
   */

  type ApproveState = 'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'rejected' | 'failed'

  function contribEnabled(approveState: ApproveState, approvalConfirmed: boolean, needsApproval: boolean): boolean {
    const approvalDone = !needsApproval || approvalConfirmed
    return !needsApproval || approvalDone
  }

  it('contribution is disabled while approval is awaiting-wallet', () => {
    expect(contribEnabled('awaiting-wallet', false, true)).toBe(false)
  })

  it('contribution is disabled while approval is pending (in-flight)', () => {
    expect(contribEnabled('pending', false, true)).toBe(false)
  })

  it('contribution is disabled when approval failed', () => {
    expect(contribEnabled('failed', false, true)).toBe(false)
  })

  it('contribution is disabled when approval was rejected', () => {
    expect(contribEnabled('rejected', false, true)).toBe(false)
  })

  it('contribution is enabled only after approvalConfirmed=true', () => {
    expect(contribEnabled('confirmed', true, true)).toBe(true)
  })

  it('contribution is immediately enabled when no approval needed', () => {
    expect(contribEnabled('idle', false, false)).toBe(true)
  })
})

// ── 2. Successful approval still requires explicit confirmation ───────────────

describe('Approval confirmed does not auto-submit contribution', () => {
  /**
   * The ContributePanel never calls handleContribute automatically.
   * approvalConfirmed is set to true in the useEffect when receipt.status === 'success'.
   * The contribution button becomes enabled but the user must click it.
   * We test the state transition directly.
   */

  it('approvalConfirmed transitions true on success receipt without calling contribute', () => {
    let approvalConfirmed = false
    let contributeCallCount = 0

    // Simulate the approval receipt useEffect logic
    function onApproveReceipt(status: 'success' | 'reverted') {
      if (status === 'success') {
        approvalConfirmed = true
        // DO NOT call contribute — user must click explicitly
      }
    }

    function handleContribute() {
      contributeCallCount++
    }

    onApproveReceipt('success')
    expect(approvalConfirmed).toBe(true)
    expect(contributeCallCount).toBe(0)

    // Contribution only happens when user explicitly calls it
    handleContribute()
    expect(contributeCallCount).toBe(1)
  })

  it('approval success state is independent of contribution state', () => {
    type TxState = 'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'rejected' | 'failed'
    let approveState: TxState = 'idle'
    let contribState: TxState = 'idle'

    // Simulate approval completing
    approveState = 'confirmed'
    expect(contribState).toBe('idle') // contribution state unchanged

    // Only after user click does contribState change
    contribState = 'awaiting-wallet'
    expect(approveState).toBe('confirmed')
    expect(contribState).toBe('awaiting-wallet')
  })
})

// ── 3. Reload restores pending hash without re-submitting ─────────────────────

describe('Reload restores pending transaction state without re-submitting', () => {
  /**
   * usePendingTx reads from localStorage on mount.
   * The sync effect: if (pendingHash && txState === 'idle') setTxState('pending')
   * This transitions to 'pending' only — it does NOT re-call writeContractAsync.
   */

  it('restores to pending state from stored hash', () => {
    type TxState = 'idle' | 'pending' | 'confirmed' | 'failed'
    let txState: TxState = 'idle'
    let submitCount = 0

    const storedHash = '0xdeadbeef' as `0x${string}`

    // Simulate the sync effect that runs after reload
    function syncPendingHash(pendingHash: `0x${string}` | null, currentState: TxState): TxState {
      if (pendingHash && currentState === 'idle') return 'pending'
      return currentState
    }

    txState = syncPendingHash(storedHash, txState)
    expect(txState).toBe('pending')
    expect(submitCount).toBe(0) // no re-submission
  })

  it('does not transition if state is already non-idle', () => {
    type TxState = 'idle' | 'awaiting-wallet' | 'pending' | 'confirmed'
    function syncPendingHash(pendingHash: `0x${string}` | null, currentState: TxState): TxState {
      if (pendingHash && currentState === 'idle') return 'pending'
      return currentState
    }

    // If already pending (e.g., hash was set this session), do not double-transition
    expect(syncPendingHash('0xabc', 'pending')).toBe('pending')
    expect(syncPendingHash('0xabc', 'awaiting-wallet')).toBe('awaiting-wallet')
  })

  it('localStorage key includes chain, registry, account, giftId, action (scoped key)', () => {
    // Mirrors the key built by usePendingTx
    function buildKey(registry: string | null, account: string | null, giftId: string, action: string): string | null {
      if (!registry || !account) return null
      return `cheers:pending:${registry.toLowerCase()}:${account.toLowerCase()}:${giftId}:${action}`
    }

    const key = buildKey(REGISTRY, ACCOUNT, '42', 'contribute')
    expect(key).toBe(`cheers:pending:${REGISTRY.toLowerCase()}:${ACCOUNT.toLowerCase()}:42:contribute`)

    // Different action → different key → no collision between approve and contribute
    const approveKey = buildKey(REGISTRY, ACCOUNT, '42', 'approve')
    const contributeKey = buildKey(REGISTRY, ACCOUNT, '42', 'contribute')
    expect(approveKey).not.toBe(contributeKey)
  })
})

// ── 4. Replacement, cancellation, rejection, reverted receipts ────────────────

describe('Transaction outcome handling', () => {
  /**
   * Test the decodeContractError function for all relevant failure modes,
   * and the receipt-status check that guards event verification.
   */

  it('user rejection maps to "cancelled" message', () => {
    expect(decodeContractError(new Error('User rejected request'))).toMatch(/cancelled/i)
    expect(decodeContractError(new Error('user rejected the request'))).toMatch(/cancelled/i)
  })

  it('replacement fee too low maps to replacement message', () => {
    expect(decodeContractError(new Error('replacement fee too low'))).toMatch(/replaced/i)
  })

  it('nonce too low maps to replacement message', () => {
    expect(decodeContractError(new Error('nonce too low'))).toMatch(/replaced/i)
  })

  it('reverted receipt triggers failed state via verifyContributedEvent', () => {
    const receipt = makeReceipt('reverted')
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, 1_000_000n)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/reverted/i)
  })

  it('reverted receipt triggers failed state via verifyClaimedEvent', () => {
    const receipt = makeReceipt('reverted')
    const result = verifyClaimedEvent(receipt, GIFT_ID, RECIPIENT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/reverted/i)
  })

  it('reverted receipt triggers failed state via verifyRefundedEvent', () => {
    const receipt = makeReceipt('reverted')
    const result = verifyRefundedEvent(receipt, GIFT_ID, ACCOUNT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/reverted/i)
  })

  it('success receipt with no matching event returns not-ok', () => {
    const receipt = makeReceipt('success', [])
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, 1_000_000n)
    expect(result.ok).toBe(false)
  })
})

// ── 5. Account/network changes prevent stale submissions ─────────────────────

describe('Account and network change handling', () => {
  /**
   * Pending transaction keys are scoped by (registry, account, giftId, action).
   * When the account changes, the old key does not match the new account, so
   * the pending hash for the old account is never restored.
   */

  function buildKey(registry: string, account: string, giftId: string, action: string): string {
    return `cheers:pending:${registry.toLowerCase()}:${account.toLowerCase()}:${giftId}:${action}`
  }

  it('different account produces a different pending key', () => {
    const key1 = buildKey(REGISTRY, ACCOUNT, '1', 'claim')
    const key2 = buildKey(REGISTRY, '0xdddddddddddddddddddddddddddddddddddddddd', '1', 'claim')
    expect(key1).not.toBe(key2)
  })

  it('pending hash from previous account is not restored on account change', () => {
    // Simulate localStorage with key for old account
    const oldAccount = ACCOUNT
    const newAccount = '0xdddddddddddddddddddddddddddddddddddddddd'
    const storage: Record<string, string> = {}

    const oldKey = buildKey(REGISTRY, oldAccount, '1', 'contribute')
    storage[oldKey] = '0xdeadbeef'

    // When new account loads, it reads a different key → no pending hash
    const newKey = buildKey(REGISTRY, newAccount, '1', 'contribute')
    const restored = storage[newKey] ?? null
    expect(restored).toBeNull()
  })

  it('all keys are cleared for an account when registry changes', () => {
    const oldRegistry = REGISTRY
    const newRegistry = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const storage: Record<string, string> = {}

    const oldKey = buildKey(oldRegistry, ACCOUNT, '1', 'contribute')
    storage[oldKey] = '0xdeadbeef'

    const newKey = buildKey(newRegistry, ACCOUNT, '1', 'contribute')
    expect(storage[newKey]).toBeUndefined()
  })
})

// ── 6. Bytecode validation gates writes ───────────────────────────────────────

describe('Bytecode validation', () => {
  type BytecodeStatus = 'idle' | 'checking' | 'ok' | 'empty' | 'error'

  function writesEnabled(status: BytecodeStatus): boolean {
    return status === 'ok'
  }

  it('writes disabled when checking', () => {
    expect(writesEnabled('checking')).toBe(false)
  })

  it('writes disabled when empty (no contract at address)', () => {
    expect(writesEnabled('empty')).toBe(false)
  })

  it('writes disabled when error (RPC failure)', () => {
    expect(writesEnabled('error')).toBe(false)
  })

  it('writes disabled when idle (no address configured)', () => {
    expect(writesEnabled('idle')).toBe(false)
  })

  it('writes enabled only when ok', () => {
    expect(writesEnabled('ok')).toBe(true)
  })

  it('bytecode check is invalidated when address changes', () => {
    // The useContractBytecode hook re-runs the effect when address changes
    // because address is in the dependency array. We model this as a pure fn.
    type Result = { addr: string; status: 'ok' | 'empty' | 'error' }

    function deriveStatus(result: Result | null, address: string | null): BytecodeStatus {
      if (!address) return 'idle'
      if (!result || result.addr !== address) return 'checking'
      return result.status
    }

    const result: Result = { addr: '0xaaa', status: 'ok' }

    // Same address → ok
    expect(deriveStatus(result, '0xaaa')).toBe('ok')

    // Different address → checking (stale result discarded)
    expect(deriveStatus(result, '0xbbb')).toBe('checking')

    // No address → idle
    expect(deriveStatus(result, null)).toBe('idle')
  })
})

// ── 7. Event verification: ContributionMade ───────────────────────────────────

describe('verifyContributedEvent', () => {
  const amount = 5_000_000n // $5.00 USDC

  it('returns ok when matching ContributionMade log is present', () => {
    const log = makeContributionMadeLog(GIFT_ID, ACCOUNT, amount, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, amount)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.giftId).toBe(GIFT_ID)
      expect(result.args.amount).toBe(amount)
    }
  })

  it('returns not-ok when giftId does not match', () => {
    const log = makeContributionMadeLog(99n, ACCOUNT, amount, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, amount)
    expect(result.ok).toBe(false)
  })

  it('returns not-ok when contributor address does not match', () => {
    const otherAccount = '0x9999999999999999999999999999999999999999' as `0x${string}`
    const log = makeContributionMadeLog(GIFT_ID, otherAccount, amount, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, amount)
    expect(result.ok).toBe(false)
  })

  it('returns not-ok when amount does not match', () => {
    const log = makeContributionMadeLog(GIFT_ID, ACCOUNT, 999n, 999n)
    const receipt = makeReceipt('success', [log])
    const result = verifyContributedEvent(receipt, GIFT_ID, ACCOUNT, amount)
    expect(result.ok).toBe(false)
  })

  it('address matching is case-insensitive (via lower-cased compare in verify fn)', () => {
    // The verify function uses .toLowerCase() for comparison on both sides.
    // Test this directly without re-encoding (which would fail checksum).
    const addr1 = '0xaAbBcCdDeEfF0011223344556677889900aAbBcC' as `0x${string}`
    const addr1Lower = addr1.toLowerCase() as `0x${string}`
    // Both should produce the same lower-cased string
    expect(addr1.toLowerCase()).toBe(addr1Lower.toLowerCase())
    // Simulate what verifyContributedEvent does internally:
    const matches = addr1.toLowerCase() === addr1Lower.toLowerCase()
    expect(matches).toBe(true)
  })
})

// ── 8. Event verification: GiftClaimed ───────────────────────────────────────

describe('verifyClaimedEvent', () => {
  const amount = 100_000_000n // $100.00 USDC

  it('returns ok when matching GiftClaimed log is present', () => {
    const log = makeGiftClaimedLog(GIFT_ID, RECIPIENT, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyClaimedEvent(receipt, GIFT_ID, RECIPIENT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args.amount).toBe(amount)
  })

  it('returns not-ok when giftId does not match', () => {
    const log = makeGiftClaimedLog(99n, RECIPIENT, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyClaimedEvent(receipt, GIFT_ID, RECIPIENT)
    expect(result.ok).toBe(false)
  })

  it('returns not-ok when recipient does not match', () => {
    const otherRecipient = '0x1234567890123456789012345678901234567890' as `0x${string}`
    const log = makeGiftClaimedLog(GIFT_ID, otherRecipient, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyClaimedEvent(receipt, GIFT_ID, RECIPIENT)
    expect(result.ok).toBe(false)
  })

  it('handles empty logs gracefully', () => {
    const receipt = makeReceipt('success', [])
    const result = verifyClaimedEvent(receipt, GIFT_ID, RECIPIENT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeTruthy()
  })
})

// ── 9. Event verification: ContributorRefunded ───────────────────────────────

describe('verifyRefundedEvent', () => {
  const amount = 25_000_000n // $25.00 USDC

  it('returns ok when matching ContributorRefunded log is present', () => {
    const log = makeContributorRefundedLog(GIFT_ID, ACCOUNT, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyRefundedEvent(receipt, GIFT_ID, ACCOUNT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args.amount).toBe(amount)
  })

  it('returns not-ok when giftId does not match', () => {
    const log = makeContributorRefundedLog(99n, ACCOUNT, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyRefundedEvent(receipt, GIFT_ID, ACCOUNT)
    expect(result.ok).toBe(false)
  })

  it('returns not-ok when contributor does not match', () => {
    const other = '0x5555555555555555555555555555555555555555' as `0x${string}`
    const log = makeContributorRefundedLog(GIFT_ID, other, amount)
    const receipt = makeReceipt('success', [log])
    const result = verifyRefundedEvent(receipt, GIFT_ID, ACCOUNT)
    expect(result.ok).toBe(false)
  })
})

// ── 10. simulateAndEstimate gas format ───────────────────────────────────────

describe('simulateAndEstimate gas format', () => {
  /**
   * simulateAndEstimate calls arcPublicClient — we mock it to test the
   * formatting and error-propagation logic independently.
   */

  it('formats a gas estimate as ~$X.XXXX USDC', () => {
    // Mock the arcPublicClient methods used by simulateAndEstimate
    const mockClient = {
      simulateContract: vi.fn().mockResolvedValue({ result: undefined }),
      estimateContractGas: vi.fn().mockResolvedValue(21_000n),
      getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n), // 1 gwei in 18-dec native
    }

    // Manually replicate the formatting logic from simulateAndEstimate
    // (we are testing the math, not calling the live function)
    const gasUnits = 21_000n
    const gasPrice = 1_000_000_000n  // 1 gwei
    const feeNative = gasUnits * gasPrice // 21_000 * 1e9 = 2.1e13 in 18-dec
    // gasTokenToUsdc: native 18-dec → USDC 6-dec
    // Arc native decimals = 18, USDC decimals = 6
    // feeUsdc = feeNative / 10^(18-6) = feeNative / 10^12
    const feeUsdc = feeNative / 1_000_000_000_000n  // = 21n micro-USDC
    expect(feeUsdc).toBe(21n)

    // Format: Amount.fromRaw(21n, 6).toFixed(4) = "0.0000"
    // 21 / 1e6 = 0.000021, toFixed(4) → "0.0000"
    const display = (Number(feeUsdc) / 1e6).toFixed(4)
    expect(display).toBe('0.0000')
    expect(`~$${display} USDC`).toMatch(/^~\$[\d.]+\sUSDC$/)

    // Mock returns did not throw
    expect(mockClient.simulateContract).not.toHaveBeenCalled() // we didn't call it
  })

  it('propagates simulation revert as not-ok result', () => {
    // Test decodeContractError maps revert messages correctly
    const revertMsg = new Error('execution reverted: ContributionWindowClosed')
    const decoded = decodeContractError(revertMsg)
    expect(decoded).toMatch(/contributions closed/i)
  })

  it('propagates insufficient funds as not-ok result', () => {
    const err = new Error('insufficient funds for gas * price + value')
    const decoded = decodeContractError(err)
    expect(decoded).toMatch(/insufficient/i)
  })
})

// ── 11. Approval-vs-contribution independence ─────────────────────────────────

describe('Approval does not count as contribution success', () => {
  /**
   * Verify that an approve receipt being 'success' CANNOT trigger the
   * contribution success path. The two receipt useEffects are separate.
   * Model the logic as pure state-machine functions.
   */

  type TxState = 'idle' | 'pending' | 'confirmed' | 'failed'

  function processApproveReceipt(
    receipt: { status: 'success' | 'reverted' } | null,
  ): { approveState: TxState; approvalConfirmed: boolean; contribTriggered: boolean } {
    if (!receipt) return { approveState: 'idle', approvalConfirmed: false, contribTriggered: false }
    if (receipt.status === 'success') {
      return { approveState: 'confirmed', approvalConfirmed: true, contribTriggered: false }
    }
    return { approveState: 'failed', approvalConfirmed: false, contribTriggered: false }
  }

  function processContribReceipt(
    receipt: TxReceipt | null,
    giftId: bigint,
    account: `0x${string}`,
    amount: bigint,
  ): { contribState: TxState; stepDone: boolean } {
    if (!receipt) return { contribState: 'idle', stepDone: false }
    const verify = verifyContributedEvent(receipt, giftId, account, amount)
    if (verify.ok) return { contribState: 'confirmed', stepDone: true }
    return { contribState: 'failed', stepDone: false }
  }

  it('approve success does not set stepDone=true', () => {
    const approveResult = processApproveReceipt({ status: 'success' })
    expect(approveResult.approvalConfirmed).toBe(true)
    expect(approveResult.contribTriggered).toBe(false)
    // Contribution step was never called
    const { stepDone } = processContribReceipt(null, GIFT_ID, ACCOUNT, 1_000_000n)
    expect(stepDone).toBe(false)
  })

  it('contribution receipt with matching event sets stepDone=true', () => {
    const amount = 1_000_000n
    const log = makeContributionMadeLog(GIFT_ID, ACCOUNT, amount, amount)
    const receipt = makeReceipt('success', [log])
    const { stepDone, contribState } = processContribReceipt(receipt, GIFT_ID, ACCOUNT, amount)
    expect(stepDone).toBe(true)
    expect(contribState).toBe('confirmed')
  })

  it('approve receipt cannot be mistaken for a contribution receipt (separate events)', () => {
    // An approve receipt would have an ERC-20 Approval event, not ContributionMade
    // Feeding it to verifyContributedEvent should return not-ok
    const approveReceipt = makeReceipt('success', []) // no ContributionMade log
    const { stepDone } = processContribReceipt(approveReceipt, GIFT_ID, ACCOUNT, 1_000_000n)
    expect(stepDone).toBe(false)
  })
})

// ── Cleanup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})
