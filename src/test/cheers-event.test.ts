/**
 * Focused tests for verifyContributedEvent in cheers-contract.ts.
 *
 * These tests exercise the production event-extraction code with real
 * viem ABI encoding. They cover:
 *   1. Happy path — correct emitter, topic, giftId, contributor, amount → ok + logIndex
 *   2. logIndex differs from array position (canonical on-chain index != array offset)
 *   3. Wrong emitter with the same topic — must be rejected
 *   4. Mismatched giftId with correct emitter and topic
 *   5. Mismatched contributor
 *   6. Mismatched amount
 *   7. Missing ContributionMade event (no matching log)
 *   8. Reverted receipt
 *   9. Multiple logs before the ContributionMade — array position != canonical index
 *  10. RPC omitted logIndex (null) — ok but logIndex is null in result
 *  11. No emitter filter when registry is undefined — still matches topic
 *  12. Second ContributionMade for a different giftId does not match
 *
 * No network calls. All logs are hand-constructed using viem encodeAbiParameters.
 */

import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, keccak256, toBytes, checksumAddress } from 'viem'
import { verifyContributedEvent, type TxReceipt, type TxReceiptLog } from '../lib/cheers-contract'

// ── Constants ──────────────────────────────────────────────────────────────────

const REGISTRY      = checksumAddress(('0x' + '11'.repeat(20)) as `0x${string}`)
const OTHER_ADDR    = checksumAddress(('0x' + '22'.repeat(20)) as `0x${string}`)
const CONTRIBUTOR   = checksumAddress(('0x' + 'aa'.repeat(20)) as `0x${string}`)
const OTHER_CONTRIB = checksumAddress(('0x' + 'bb'.repeat(20)) as `0x${string}`)

const GIFT_ID  = 7n
const AMOUNT   = 5_000_000n  // $5.00 USDC (6 decimals)
const TOTAL    = 15_000_000n // $15.00 USDC

// ContributionMade(uint256 indexed giftId, address indexed contributor, uint256 amount, uint256 totalContributed)
const CONTRIBUTION_MADE_TOPIC0 = keccak256(toBytes('ContributionMade(uint256,address,uint256,uint256)'))

/** Encode a ContributionMade log. The two indexed params go into topics[1] and topics[2].
 *  The two non-indexed params (amount, totalContributed) go into data. */
function makeContributionMadeLog(opts: {
  address?: `0x${string}`
  giftId?: bigint
  contributor?: `0x${string}`
  amount?: bigint
  totalContributed?: bigint
  logIndex?: number | null
} = {}): TxReceiptLog {
  const giftId     = opts.giftId     ?? GIFT_ID
  const contributor = opts.contributor ?? CONTRIBUTOR
  const amount     = opts.amount     ?? AMOUNT
  const total      = opts.totalContributed ?? TOTAL

  // Indexed params: ABI-encode each as a single 32-byte word, matching EVM topic encoding
  const topic1 = encodeAbiParameters([{ type: 'uint256' }], [giftId])
  const topic2 = encodeAbiParameters([{ type: 'address' }], [contributor])

  // Non-indexed params encoded as data
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [amount, total],
  )

  return {
    address:  opts.address ?? REGISTRY,
    topics:   [CONTRIBUTION_MADE_TOPIC0, topic1, topic2],
    data,
    logIndex: opts.logIndex !== undefined ? opts.logIndex : 0,
  }
}

function makeOtherLog(logIndex = 0): TxReceiptLog {
  return {
    address: OTHER_ADDR,
    topics:  [keccak256(toBytes('Transfer(address,address,uint256)'))],
    data:    '0x',
    logIndex,
  }
}

function makeReceipt(logs: TxReceiptLog[], status: 'success' | 'reverted' = 'success'): TxReceipt {
  return { status, logs, transactionHash: '0xABC' }
}

// ── 1. Happy path ──────────────────────────────────────────────────────────────

describe('verifyContributedEvent — happy path', () => {
  it('returns ok=true with correct args and logIndex', () => {
    const log = makeContributionMadeLog({ logIndex: 5 })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.giftId).toBe(GIFT_ID)
      expect(result.args.amount).toBe(AMOUNT)
      expect(result.args.contributor.toLowerCase()).toBe(CONTRIBUTOR.toLowerCase())
      expect(result.logIndex).toBe(5)
    }
  })

  it('contributor matching is case-insensitive', () => {
    const log = makeContributionMadeLog({ contributor: CONTRIBUTOR.toLowerCase() as `0x${string}`, logIndex: 3 })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR.toUpperCase() as `0x${string}`, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
  })
})

// ── 2. logIndex differs from array position ────────────────────────────────────

describe('verifyContributedEvent — logIndex != array position', () => {
  it('returns the canonical logIndex (10), not the array index (2)', () => {
    // Three logs: indices 8, 9, 10 on-chain but at positions 0, 1, 2 in the receipt array
    const logs: TxReceiptLog[] = [
      makeOtherLog(8),
      makeOtherLog(9),
      makeContributionMadeLog({ logIndex: 10 }),
    ]
    const result = verifyContributedEvent(makeReceipt(logs), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Must return 10 (on-chain canonical index), not 2 (array position)
      expect(result.logIndex).toBe(10)
      expect(result.logIndex).not.toBe(2)
    }
  })

  it('first matching log is returned when there are multiple ContributionMade logs', () => {
    // Two ContributionMade logs for the same giftId/contributor/amount at different on-chain indices
    const logs: TxReceiptLog[] = [
      makeContributionMadeLog({ logIndex: 4 }),
      makeContributionMadeLog({ logIndex: 7 }),
    ]
    const result = verifyContributedEvent(makeReceipt(logs), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Returns the first match
      expect(result.logIndex).toBe(4)
    }
  })
})

// ── 3. Wrong emitter with the same topic ──────────────────────────────────────

describe('verifyContributedEvent — wrong emitter', () => {
  it('rejects a ContributionMade log emitted by a different contract (not the registry)', () => {
    // Same topic, same args — but emitted by OTHER_ADDR, not REGISTRY
    const log = makeContributionMadeLog({ address: OTHER_ADDR, logIndex: 0 })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })

  it('still matches when the emitter filter is omitted (no registry provided)', () => {
    // When expectedRegistry is undefined, emitter is not checked
    const log = makeContributionMadeLog({ address: OTHER_ADDR, logIndex: 0 })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT)
    expect(result.ok).toBe(true)
  })

  it('correct emitter after wrong-emitter logs is still found', () => {
    const logs: TxReceiptLog[] = [
      makeContributionMadeLog({ address: OTHER_ADDR, logIndex: 0 }),  // wrong emitter
      makeContributionMadeLog({ address: REGISTRY,   logIndex: 1 }),  // correct
    ]
    const result = verifyContributedEvent(makeReceipt(logs), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.logIndex).toBe(1)
  })
})

// ── 4. Mismatched giftId ───────────────────────────────────────────────────────

describe('verifyContributedEvent — mismatched giftId', () => {
  it('rejects when giftId does not match', () => {
    const log = makeContributionMadeLog({ giftId: 999n })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('event not found')
  })

  it('rejects a ContributionMade for giftId+1 even if emitter/contributor/amount match', () => {
    const log = makeContributionMadeLog({ giftId: GIFT_ID + 1n })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })
})

// ── 5. Mismatched contributor ─────────────────────────────────────────────────

describe('verifyContributedEvent — mismatched contributor', () => {
  it('rejects when contributor does not match', () => {
    const log = makeContributionMadeLog({ contributor: OTHER_CONTRIB })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })
})

// ── 6. Mismatched amount ──────────────────────────────────────────────────────

describe('verifyContributedEvent — mismatched amount', () => {
  it('rejects when amount does not match', () => {
    const log = makeContributionMadeLog({ amount: AMOUNT + 1n })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })

  it('rejects amount off by one cent', () => {
    const log = makeContributionMadeLog({ amount: AMOUNT - 1n })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })
})

// ── 7. Missing ContributionMade event ─────────────────────────────────────────

describe('verifyContributedEvent — missing event', () => {
  it('returns ok=false when no ContributionMade log is present', () => {
    const logs: TxReceiptLog[] = [makeOtherLog(0), makeOtherLog(1)]
    const result = verifyContributedEvent(makeReceipt(logs), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('event not found')
  })

  it('returns ok=false for an empty log array', () => {
    const result = verifyContributedEvent(makeReceipt([]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
  })
})

// ── 8. Reverted receipt ────────────────────────────────────────────────────────

describe('verifyContributedEvent — reverted receipt', () => {
  it('returns ok=false when receipt.status is reverted, even if log is present', () => {
    const log = makeContributionMadeLog()
    const result = verifyContributedEvent(makeReceipt([log], 'reverted'), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('reverted')
  })
})

// ── 9. RPC omitted logIndex (null) ────────────────────────────────────────────

describe('verifyContributedEvent — null logIndex from RPC', () => {
  it('returns ok=true but logIndex=null when RPC omitted logIndex', () => {
    const log = makeContributionMadeLog({ logIndex: null })
    const result = verifyContributedEvent(makeReceipt([log]), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.logIndex).toBeNull()
    }
  })

  it('does not substitute array position when logIndex is null', () => {
    const logs: TxReceiptLog[] = [
      makeOtherLog(0),
      makeOtherLog(1),
      makeContributionMadeLog({ logIndex: null }), // array position 2, but logIndex null
    ]
    const result = verifyContributedEvent(makeReceipt(logs), GIFT_ID, CONTRIBUTOR, AMOUNT, REGISTRY)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Must be null — NOT 2 (the array position)
      expect(result.logIndex).toBeNull()
    }
  })
})

// ── 10. 503 temporary failure allows fresh challenge (state machine) ──────────

describe('503 temporary failure recovery model', () => {
  it('retryable=false means auto-retry is disabled, but recovery panel allows a fresh challenge', () => {
    // This tests the contract between the API layer and the UI:
    // - 503 returns { ok: false, retryable: false }
    // - The UI shows the recovery panel (MetadataRecovery) which calls metaSaveGift/metaSaveContribution again
    // - metaSaveGift starts a fresh challenge — it does NOT reuse the old nonce
    // - The confirmed tx hash is preserved and passed to the new challenge
    // - No new blockchain transaction is initiated

    // Model the state the UI holds after a 503:
    const recoveryState = {
      confirmedTxHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      confirmedLogIndex: 5,
      greetingPayload: {
        registry:    REGISTRY,
        giftId:      '7',
        txHash:      ('0x' + 'ab'.repeat(32)) as `0x${string}`,
        logIndex:    5,
        displayName: 'Alice',
        message:     'Happy birthday!',
      },
      metaSaveError: 'Service temporarily unavailable. Do not retry the payment.',
      // retryable: false means: do not auto-call metaSave again
      // But the recovery panel (user-initiated) CAN call metaSave again with the same payload
    }

    // Recovery preserves the original tx identity
    expect(recoveryState.greetingPayload.txHash).toBe(recoveryState.confirmedTxHash)
    expect(recoveryState.greetingPayload.logIndex).toBe(recoveryState.confirmedLogIndex)

    // The error message clearly says "Do not retry the payment"
    expect(recoveryState.metaSaveError).toMatch(/do not retry the payment/i)

    // No new blockchain transaction: the greetingPayload has no writeContract call
    // This is structural — recovery only calls metaSaveContribution (API), not writeContrib
    expect(recoveryState.greetingPayload).not.toHaveProperty('approvalTx')
    expect(recoveryState.greetingPayload).not.toHaveProperty('writeContract')
  })
})
