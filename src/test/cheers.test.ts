/**
 * Focused unit tests for SignalArc Cheers frontend logic.
 *
 * Tests:
 *   1. parseContributionAmount — valid inputs, zero, negative, too many decimals,
 *      non-numeric, empty, max precision, repeat contributions summed
 *   2. derivePhase — exact timestamp boundaries (giftAt, claimDeadline)
 *   3. Accounting identity — remainingBalance invariant
 *   4. decodeContractError — known ABI error names
 *   5. fmtCountdown — day/hour/minute display
 *   6. Approval/contribution sequencing — needsApproval logic
 *
 * These are purely computational tests. No RPC calls, no wagmi hooks, no DOM.
 * They are clearly distinct from mainnet end-to-end verification.
 */

import { describe, it, expect } from 'vitest'
import {
  parseContributionAmount,
  derivePhase,
  GiftPhase,
  remainingBalance,
  decodeContractError,
  fmtCountdown,
  type GiftData,
} from '../lib/cheers-contract'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGift(overrides: Partial<GiftData> = {}): GiftData {
  return {
    recipient:        '0x1111111111111111111111111111111111111111',
    giftAt:           1_000_000n,
    claimDeadline:    1_000_000n + 30n * 86400n,  // 30 days after giftAt
    totalContributed: 0n,
    totalClaimed:     0n,
    totalRefunded:    0n,
    ...overrides,
  }
}

// ── parseContributionAmount ───────────────────────────────────────────────────

describe('parseContributionAmount', () => {
  it('parses a whole number', () => {
    const r = parseContributionAmount('10')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.raw).toBe(10_000_000n)
  })

  it('parses two decimal places', () => {
    const r = parseContributionAmount('12.50')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.raw).toBe(12_500_000n)
  })

  it('parses exactly 6 decimal places', () => {
    const r = parseContributionAmount('0.000001')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.raw).toBe(1n)
  })

  it('parses leading dot', () => {
    const r = parseContributionAmount('.5')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.raw).toBe(500_000n)
  })

  it('parses large amount', () => {
    const r = parseContributionAmount('9999999.999999')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.raw).toBe(9_999_999_999_999n)
  })

  it('rejects empty string', () => {
    const r = parseContributionAmount('')
    expect(r.ok).toBe(false)
  })

  it('rejects whitespace only', () => {
    const r = parseContributionAmount('   ')
    expect(r.ok).toBe(false)
  })

  it('rejects zero', () => {
    const r = parseContributionAmount('0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/greater than zero/i)
  })

  it('rejects 0.000000', () => {
    const r = parseContributionAmount('0.000000')
    expect(r.ok).toBe(false)
  })

  it('rejects 7 decimal places', () => {
    const r = parseContributionAmount('1.0000001')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/decimal/i)
  })

  it('rejects negative number', () => {
    const r = parseContributionAmount('-1')
    expect(r.ok).toBe(false)
  })

  it('rejects non-numeric string', () => {
    const r = parseContributionAmount('abc')
    expect(r.ok).toBe(false)
  })

  it('rejects number with commas', () => {
    const r = parseContributionAmount('1,000')
    expect(r.ok).toBe(false)
  })

  it('rejects scientific notation', () => {
    const r = parseContributionAmount('1e6')
    expect(r.ok).toBe(false)
  })

  it('repeated contributions sum correctly (additive, not overwrite)', () => {
    const r1 = parseContributionAmount('5.00')
    const r2 = parseContributionAmount('3.25')
    expect(r1.ok && r2.ok).toBe(true)
    if (r1.ok && r2.ok) {
      expect(r1.raw + r2.raw).toBe(8_250_000n)
    }
  })
})

// ── derivePhase — exact timestamp boundaries ──────────────────────────────────

describe('derivePhase — timestamp boundaries', () => {
  const gift = makeGift({ totalContributed: 100n })
  const giftAt = gift.giftAt            // 1_000_000
  const deadline = gift.claimDeadline   // 1_000_000 + 30*86400

  it('OPEN one second before giftAt', () => {
    expect(derivePhase(gift, giftAt - 1n)).toBe(GiftPhase.OPEN)
  })

  it('CLAIMABLE at exact giftAt', () => {
    expect(derivePhase(gift, giftAt)).toBe(GiftPhase.CLAIMABLE)
  })

  it('CLAIMABLE one second after giftAt', () => {
    expect(derivePhase(gift, giftAt + 1n)).toBe(GiftPhase.CLAIMABLE)
  })

  it('CLAIMABLE one second before deadline', () => {
    expect(derivePhase(gift, deadline - 1n)).toBe(GiftPhase.CLAIMABLE)
  })

  it('REFUNDABLE at exact deadline', () => {
    expect(derivePhase(gift, deadline)).toBe(GiftPhase.REFUNDABLE)
  })

  it('REFUNDABLE one second after deadline', () => {
    expect(derivePhase(gift, deadline + 1n)).toBe(GiftPhase.REFUNDABLE)
  })

  it('REFUNDABLE far in the future (no refund expiry)', () => {
    expect(derivePhase(gift, deadline + 365n * 86400n)).toBe(GiftPhase.REFUNDABLE)
  })

  it('OPEN when totalContributed is 0 (phase still depends on timestamps)', () => {
    const emptyGift = makeGift()
    expect(derivePhase(emptyGift, giftAt - 1n)).toBe(GiftPhase.OPEN)
  })

  it('CLOSED when totalClaimed > 0, regardless of timestamp', () => {
    const claimed = makeGift({ totalClaimed: 50n })
    // Even before giftAt, if somehow claimed
    expect(derivePhase(claimed, giftAt - 1000n)).toBe(GiftPhase.CLOSED)
    expect(derivePhase(claimed, deadline + 1n)).toBe(GiftPhase.CLOSED)
  })
})

// ── Accounting invariant ──────────────────────────────────────────────────────

describe('remainingBalance accounting invariant', () => {
  it('satisfies totalContributed = totalClaimed + totalRefunded + remaining', () => {
    const cases: GiftData[] = [
      makeGift({ totalContributed: 1000n, totalClaimed: 0n,    totalRefunded: 0n }),
      makeGift({ totalContributed: 1000n, totalClaimed: 1000n, totalRefunded: 0n }),
      makeGift({ totalContributed: 1000n, totalClaimed: 0n,    totalRefunded: 1000n }),
      makeGift({ totalContributed: 1000n, totalClaimed: 0n,    totalRefunded: 600n }),
      makeGift({ totalContributed: 0n,    totalClaimed: 0n,    totalRefunded: 0n }),
    ]
    for (const g of cases) {
      const remaining = remainingBalance(g)
      expect(g.totalContributed).toBe(g.totalClaimed + g.totalRefunded + remaining)
    }
  })

  it('remaining is 0 after full claim', () => {
    const g = makeGift({ totalContributed: 500n, totalClaimed: 500n })
    expect(remainingBalance(g)).toBe(0n)
  })

  it('remaining is 0 after full refund', () => {
    const g = makeGift({ totalContributed: 300n, totalRefunded: 300n })
    expect(remainingBalance(g)).toBe(0n)
  })

  it('partial refund leaves positive remaining', () => {
    const g = makeGift({ totalContributed: 300n, totalRefunded: 100n })
    expect(remainingBalance(g)).toBe(200n)
  })
})

// ── decodeContractError ───────────────────────────────────────────────────────

describe('decodeContractError', () => {
  const cases: [string, RegExp][] = [
    ['AlreadyClaimed',           /already been claimed/i],
    ['AlreadyRefunded',          /already withdrawn/i],
    ['ClaimWindowClosed',        /claim window has passed/i],
    ['ClaimWindowNotOpen',       /gift date has not arrived/i],
    ['ContributionWindowClosed', /contributions closed/i],
    ['GiftDoesNotExist',         /does not exist/i],
    ['NotContributor',           /only contributors/i],
    ['NotRecipient',             /only the recipient/i],
    ['RefundWindowNotOpen',      /refunds are only available/i],
    ['ZeroAmount',               /greater than zero/i],
    ['User rejected request',    /cancelled/i],
    ['user rejected',            /cancelled/i],
    ['insufficient funds',       /insufficient/i],
  ]

  for (const [errorText, expectedPattern] of cases) {
    it(`maps "${errorText}"`, () => {
      const result = decodeContractError(new Error(errorText))
      expect(result).toMatch(expectedPattern)
    })
  }

  it('returns fallback for unknown error', () => {
    const result = decodeContractError(new Error('something totally unexpected'))
    expect(result).toMatch(/try again/i)
  })

  it('handles null gracefully', () => {
    const result = decodeContractError(null)
    expect(typeof result).toBe('string')
  })

  // Regression: Gift #2 contribution simulation returned "Transaction failed"
  // because "transfer amount exceeds allowance" did not match the existing
  // "transfer amount exceeds balance" check. Fixed by adding an explicit check.
  it('regression: ERC-20 transferFrom allowance revert decodes correctly (Gift #2)', () => {
    const err = new Error(
      'The contract function "contribute" reverted with the following reason:\n' +
      'ERC20: transfer amount exceeds allowance'
    )
    expect(decodeContractError(err)).toBe('USDC spending not yet approved. Complete the approval step first.')
  })

  it('decodes ERC-20 insufficient allowance variant', () => {
    expect(decodeContractError(new Error('ERC20: insufficient allowance')))
      .toBe('USDC spending not yet approved. Complete the approval step first.')
  })

  it('regression: allowance error must NOT fall through to generic message', () => {
    const err = new Error('execution reverted: ERC20: transfer amount exceeds allowance')
    expect(decodeContractError(err)).not.toMatch(/try again/i)
  })
})

// ── fmtCountdown ──────────────────────────────────────────────────────────────

describe('fmtCountdown', () => {
  it('returns "now" when diff is 0', () => {
    expect(fmtCountdown(1000n, 1000n)).toBe('now')
  })

  it('returns "now" when past', () => {
    expect(fmtCountdown(1000n, 2000n)).toBe('now')
  })

  it('shows days and hours', () => {
    // 2 days + 3 hours = 2*86400 + 3*3600 = 183600 seconds
    const result = fmtCountdown(200_000n, 200_000n - 183_600n)
    expect(result).toMatch(/2d/)
    expect(result).toMatch(/3h/)
  })

  it('shows hours and minutes when < 1 day', () => {
    // 5 hours + 20 minutes = 19200 seconds
    const result = fmtCountdown(200_000n, 200_000n - 19_200n)
    expect(result).toMatch(/5h/)
    expect(result).toMatch(/20m/)
  })

  it('shows only minutes when < 1 hour', () => {
    // 45 minutes = 2700 seconds
    const result = fmtCountdown(200_000n, 200_000n - 2_700n)
    expect(result).toMatch(/45m/)
    expect(result).not.toMatch(/h/)
  })
})

// ── Approval/contribution sequencing ─────────────────────────────────────────

describe('needsApproval logic', () => {
  // This mirrors the logic in ContributePanel:
  //   needsApproval = parsedAmount !== null && (allowance === undefined || allowance < parsedAmount)

  function needsApproval(allowance: bigint | undefined, parsedAmount: bigint | null): boolean {
    return parsedAmount !== null && (allowance === undefined || allowance < parsedAmount)
  }

  it('requires approval when allowance is undefined', () => {
    expect(needsApproval(undefined, 1_000_000n)).toBe(true)
  })

  it('requires approval when allowance < amount', () => {
    expect(needsApproval(500_000n, 1_000_000n)).toBe(true)
  })

  it('does not require approval when allowance === amount', () => {
    expect(needsApproval(1_000_000n, 1_000_000n)).toBe(false)
  })

  it('does not require approval when allowance > amount', () => {
    expect(needsApproval(5_000_000n, 1_000_000n)).toBe(false)
  })

  it('does not evaluate when parsedAmount is null', () => {
    expect(needsApproval(undefined, null)).toBe(false)
  })

  it('exact-amount approval satisfies subsequent contribution', () => {
    const amount = 2_500_000n
    // After approval of exact amount, allowance equals amount
    expect(needsApproval(amount, amount)).toBe(false)
  })
})
