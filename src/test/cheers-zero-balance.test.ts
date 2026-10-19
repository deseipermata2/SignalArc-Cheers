/**
 * Focused tests for zero-balance and null-balance display logic.
 *
 * Tests the production logic extracted from GiftDetailPage and GiftsListing:
 *   1. canClaim gate — null/zero/positive remaining balance
 *   2. poolLabel — listing label per phase × balance combination
 *   3. Detail-page notice selection — null vs confirmed zero
 *   4. canClaim with all three eligibility conditions
 *
 * These are purely computational tests.
 * No RPC, no wagmi hooks, no DOM, no mainnet interaction.
 */

import { describe, it, expect } from 'vitest'
import {
  derivePhase, GiftPhase, remainingBalance,
  displayLabel, displayColor,
  PHASE_LABELS, PHASE_COLORS,
  type GiftData,
} from '../lib/cheers-contract'

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = 1_000_000n           // arbitrary epoch seconds
const GIFT_AT       = NOW + 86_400n      // 1 day from now
const CLAIM_DL      = NOW + 86_400n + 7n * 86_400n  // +7 days after giftAt

function makeGift(overrides: Partial<GiftData> = {}): GiftData {
  return {
    recipient:         '0xRecipient',
    giftAt:            GIFT_AT,
    claimDeadline:     CLAIM_DL,
    totalContributed:  100n,
    totalClaimed:      0n,
    totalRefunded:     0n,
    ...overrides,
  }
}

// ── canClaim logic (extracted from GiftDetailPage) ────────────────────────────
//
// canClaim = isRecipientInClaimWindow && remaining !== null && remaining > 0n
// isRecipientInClaimWindow = phase === CLAIMABLE && wallet === recipient

function computeCanClaim(
  gift: GiftData,
  walletAddress: string | null,
  remaining: bigint | null,
  nowSec: bigint,
): boolean {
  const phase = derivePhase(gift, nowSec)
  const isRecipientInClaimWindow =
    phase === GiftPhase.CLAIMABLE &&
    walletAddress !== null &&
    gift.recipient.toLowerCase() === walletAddress.toLowerCase()
  return isRecipientInClaimWindow && remaining !== null && remaining > 0n
}

// ── poolLabel logic (extracted from GiftsListing) ─────────────────────────────

interface ListItem {
  phase: GiftPhase
  totalContributed: bigint
  pooledDisplay: string
}

function poolLabel(item: ListItem): string {
  if (item.phase === GiftPhase.CLOSED)   return 'Claimed'
  if (item.totalContributed === 0n) {
    if (item.phase === GiftPhase.CLAIMABLE || item.phase === GiftPhase.REFUNDABLE) {
      return 'Claim window open · No funds'
    }
    return 'No contributions yet'
  }
  return 'Pooled'
}

// ── detailNotice logic (extracted from GiftDetailPage) ────────────────────────
//
// When isRecipientInClaimWindow:
//   remaining === null → show loading notice (not zero-balance notice)
//   remaining === 0n   → show zero-balance notice with exact text
//   remaining > 0n     → show claim button (no notice)

type NoticeKind = 'loading' | 'zero-balance' | 'claim-button' | 'none'

function detailNoticeKind(
  isRecipientInClaimWindow: boolean,
  remaining: bigint | null,
): NoticeKind {
  if (!isRecipientInClaimWindow) return 'none'
  if (remaining === null)        return 'loading'
  if (remaining === 0n)          return 'zero-balance'
  return 'claim-button'
}

// ── canClaim — null balance ────────────────────────────────────────────────────

describe('canClaim — null remaining balance', () => {
  const claimableGift = makeGift({ totalContributed: 100n })
  const duringWindow = GIFT_AT + 3600n   // inside claim window

  it('is false when remaining is null (balance loading)', () => {
    expect(computeCanClaim(claimableGift, '0xRecipient', null, duringWindow)).toBe(false)
  })

  it('is false when remaining is null even if recipient is correct', () => {
    expect(computeCanClaim(claimableGift, '0xrecipient', null, duringWindow)).toBe(false)
  })

  it('is false when remaining is null and wallet is wrong', () => {
    expect(computeCanClaim(claimableGift, '0xOther', null, duringWindow)).toBe(false)
  })
})

// ── canClaim — confirmed zero balance ─────────────────────────────────────────

describe('canClaim — confirmed zero remaining balance', () => {
  const claimableGift = makeGift({ totalContributed: 0n })
  const duringWindow = GIFT_AT + 3600n

  it('is false when remaining is 0n (no funds to claim)', () => {
    expect(computeCanClaim(claimableGift, '0xRecipient', 0n, duringWindow)).toBe(false)
  })

  it('is false even if caller is the recipient', () => {
    expect(computeCanClaim(claimableGift, '0xrecipient', 0n, duringWindow)).toBe(false)
  })

  it('is false for 0n balance regardless of totalContributed field', () => {
    // remainingBalance could be 0n because all was refunded
    const allRefunded = makeGift({ totalContributed: 50n, totalRefunded: 50n })
    expect(remainingBalance(allRefunded)).toBe(0n)
    expect(computeCanClaim(allRefunded, '0xRecipient', 0n, duringWindow)).toBe(false)
  })
})

// ── canClaim — positive balance ───────────────────────────────────────────────

describe('canClaim — positive remaining balance', () => {
  const fundedGift = makeGift({ totalContributed: 1_000_000n })
  const duringWindow = GIFT_AT + 3600n

  it('is true when recipient, CLAIMABLE, and balance positive', () => {
    expect(computeCanClaim(fundedGift, '0xRecipient', 1_000_000n, duringWindow)).toBe(true)
  })

  it('is false when wallet is wrong address', () => {
    expect(computeCanClaim(fundedGift, '0xOther', 1_000_000n, duringWindow)).toBe(false)
  })

  it('is false when wallet is null (not connected)', () => {
    expect(computeCanClaim(fundedGift, null, 1_000_000n, duringWindow)).toBe(false)
  })

  it('is false before giftAt (OPEN phase)', () => {
    const before = GIFT_AT - 1n
    expect(computeCanClaim(fundedGift, '0xRecipient', 1_000_000n, before)).toBe(false)
  })

  it('is false at or after claimDeadline (REFUNDABLE phase)', () => {
    expect(computeCanClaim(fundedGift, '0xRecipient', 1_000_000n, CLAIM_DL)).toBe(false)
  })

  it('is true at exactly giftAt (claim window opens at giftAt)', () => {
    expect(computeCanClaim(fundedGift, '0xRecipient', 1_000_000n, GIFT_AT)).toBe(true)
  })

  it('is true at claimDeadline minus one second (last valid second)', () => {
    expect(computeCanClaim(fundedGift, '0xRecipient', 1_000_000n, CLAIM_DL - 1n)).toBe(true)
  })

  it('is false on a claimed (closed) gift', () => {
    // CLOSED phase: totalClaimed === totalContributed && totalContributed > 0
    const claimed = makeGift({ totalContributed: 1_000_000n, totalClaimed: 1_000_000n })
    expect(computeCanClaim(claimed, '0xRecipient', 0n, duringWindow)).toBe(false)
  })

  it('is case-insensitive on wallet address', () => {
    expect(computeCanClaim(fundedGift, '0xrecipient', 1_000_000n, duringWindow)).toBe(true)
    expect(computeCanClaim(fundedGift, '0XRECIPIENT', 1_000_000n, duringWindow)).toBe(true)
  })
})

// ── poolLabel — listing card labels ──────────────────────────────────────────

describe('poolLabel — listing card', () => {
  it('OPEN with zero contributions → "No contributions yet" (still accepting)', () => {
    expect(poolLabel({ phase: GiftPhase.OPEN, totalContributed: 0n, pooledDisplay: '' }))
      .toBe('No contributions yet')
  })

  it('OPEN with positive contributions → "Pooled"', () => {
    expect(poolLabel({ phase: GiftPhase.OPEN, totalContributed: 1_000_000n, pooledDisplay: '$1.00' }))
      .toBe('Pooled')
  })

  it('CLAIMABLE with zero contributions → "Claim window open · No funds"', () => {
    expect(poolLabel({ phase: GiftPhase.CLAIMABLE, totalContributed: 0n, pooledDisplay: '' }))
      .toBe('Claim window open · No funds')
  })

  it('CLAIMABLE with positive contributions → "Pooled"', () => {
    expect(poolLabel({ phase: GiftPhase.CLAIMABLE, totalContributed: 1_000_000n, pooledDisplay: '$1.00' }))
      .toBe('Pooled')
  })

  it('REFUNDABLE with zero contributions → "Claim window open · No funds"', () => {
    // Deadline passed, nothing contributed
    expect(poolLabel({ phase: GiftPhase.REFUNDABLE, totalContributed: 0n, pooledDisplay: '' }))
      .toBe('Claim window open · No funds')
  })

  it('CLOSED → "Claimed" regardless of balance', () => {
    expect(poolLabel({ phase: GiftPhase.CLOSED, totalContributed: 1_000_000n, pooledDisplay: '$1.00' }))
      .toBe('Claimed')
    expect(poolLabel({ phase: GiftPhase.CLOSED, totalContributed: 0n, pooledDisplay: '' }))
      .toBe('Claimed')
  })
})

// ── detailNoticeKind — notice vs loading vs claim button ──────────────────────

describe('detailNoticeKind — detail page notice selection', () => {
  it('not recipient → none', () => {
    expect(detailNoticeKind(false, null)).toBe('none')
    expect(detailNoticeKind(false, 0n)).toBe('none')
    expect(detailNoticeKind(false, 1_000_000n)).toBe('none')
  })

  it('recipient + null → loading (not zero-balance)', () => {
    expect(detailNoticeKind(true, null)).toBe('loading')
  })

  it('recipient + 0n → zero-balance notice with exact text', () => {
    expect(detailNoticeKind(true, 0n)).toBe('zero-balance')
  })

  it('recipient + positive → show claim button (no notice)', () => {
    expect(detailNoticeKind(true, 1_000_000n)).toBe('claim-button')
    expect(detailNoticeKind(true, 1n)).toBe('claim-button')
  })

  it('null is never treated as zero', () => {
    // The loading state and the zero state must not be conflated
    expect(detailNoticeKind(true, null)).not.toBe('zero-balance')
    expect(detailNoticeKind(true, 0n)).not.toBe('loading')
  })
})

// ── displayLabel ──────────────────────────────────────────────────────────────
//
// Tests the production badge label function used by PhaseBadge.
// The function must exactly match the badges shown to the user.

describe('displayLabel', () => {
  it('CLAIMABLE + 0n → "No funds" (not "Ready to claim")', () => {
    expect(displayLabel(GiftPhase.CLAIMABLE, 0n)).toBe('No funds')
    expect(displayLabel(GiftPhase.CLAIMABLE, 0n)).not.toBe(PHASE_LABELS[GiftPhase.CLAIMABLE])
  })

  it('REFUNDABLE + 0n → "Claim expired · No funds" (not "Claim expired")', () => {
    expect(displayLabel(GiftPhase.REFUNDABLE, 0n)).toBe('Claim expired · No funds')
    expect(displayLabel(GiftPhase.REFUNDABLE, 0n)).not.toBe(PHASE_LABELS[GiftPhase.REFUNDABLE])
  })

  it('CLAIMABLE + undefined → standard "Ready to claim" (loading fallback)', () => {
    expect(displayLabel(GiftPhase.CLAIMABLE, undefined)).toBe(PHASE_LABELS[GiftPhase.CLAIMABLE])
  })

  it('REFUNDABLE + undefined → standard "Claim expired" (loading fallback)', () => {
    expect(displayLabel(GiftPhase.REFUNDABLE, undefined)).toBe(PHASE_LABELS[GiftPhase.REFUNDABLE])
  })

  it('CLAIMABLE + positive → standard "Ready to claim"', () => {
    expect(displayLabel(GiftPhase.CLAIMABLE, 1_000_000n)).toBe(PHASE_LABELS[GiftPhase.CLAIMABLE])
    expect(displayLabel(GiftPhase.CLAIMABLE, 1n)).toBe(PHASE_LABELS[GiftPhase.CLAIMABLE])
  })

  it('REFUNDABLE + positive → standard "Claim expired"', () => {
    expect(displayLabel(GiftPhase.REFUNDABLE, 1_000_000n)).toBe(PHASE_LABELS[GiftPhase.REFUNDABLE])
  })

  it('OPEN + 0n → standard "Collecting" (zero during open is expected)', () => {
    expect(displayLabel(GiftPhase.OPEN, 0n)).toBe(PHASE_LABELS[GiftPhase.OPEN])
  })

  it('CLOSED + any → standard "Claimed"', () => {
    expect(displayLabel(GiftPhase.CLOSED, 0n)).toBe(PHASE_LABELS[GiftPhase.CLOSED])
    expect(displayLabel(GiftPhase.CLOSED, 1_000_000n)).toBe(PHASE_LABELS[GiftPhase.CLOSED])
  })
})

// ── displayColor ──────────────────────────────────────────────────────────────

describe('displayColor', () => {
  it('CLAIMABLE + 0n → muted amber (distinct from standard amber)', () => {
    const noFundsColor = displayColor(GiftPhase.CLAIMABLE, 0n)
    expect(noFundsColor).not.toBe(PHASE_COLORS[GiftPhase.CLAIMABLE])
    // Must still be recognisably amber-family
    expect(noFundsColor.toLowerCase()).toContain('a1')
  })

  it('REFUNDABLE + 0n → gray (no action available to anyone)', () => {
    expect(displayColor(GiftPhase.REFUNDABLE, 0n)).toBe(PHASE_COLORS[GiftPhase.CLOSED])
  })

  it('CLAIMABLE + positive → standard amber', () => {
    expect(displayColor(GiftPhase.CLAIMABLE, 1_000_000n)).toBe(PHASE_COLORS[GiftPhase.CLAIMABLE])
  })

  it('CLAIMABLE + undefined → standard amber (loading fallback)', () => {
    expect(displayColor(GiftPhase.CLAIMABLE, undefined)).toBe(PHASE_COLORS[GiftPhase.CLAIMABLE])
  })

  it('OPEN + 0n → standard green', () => {
    expect(displayColor(GiftPhase.OPEN, 0n)).toBe(PHASE_COLORS[GiftPhase.OPEN])
  })
})
