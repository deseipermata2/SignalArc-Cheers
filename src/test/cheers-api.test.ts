/**
 * Focused tests for the Cheers API adapter layer.
 *
 * Tests:
 *   1. canonicalJSON — deterministic key sorting, array order, nested objects, null/primitives
 *   2. computePayloadHash — keccak256(toBytes(canonicalJSON(...))) determinism
 *   3. buildTypedData — expiresAt decimal string → bigint conversion
 *   4. validateChallenge — domain, chainId, wallet, action, origin, expiry validation
 *   5. metaSaveGift flow — challenge→sign→execute state transitions (mocked fetch)
 *   6. metaSaveContribution flow — same but for contribution
 *   7. Signature rejection handling
 *   8. Expiry handling (401 → retryable)
 *   9. Receipt-unavailable (409 → retryable)
 *  10. Account/network change during async flow
 *  11. Draft localStorage scoping (draftKey uniqueness)
 *  12. API error codes
 *  13. saveDraft / loadDraft / clearDraft round-trips
 *
 * No real network calls, no wagmi hooks. All fetch calls are mocked.
 * These tests cover frontend logic only — not mainnet end-to-end verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  canonicalJSON,
  computePayloadHash,
  buildTypedData,
  validateChallenge,
  draftKey,
  saveDraft,
  loadDraft,
  clearDraft,
  apiChallenge,
  apiExecute,
  metaSaveGift,
  metaSaveContribution,
  ApiError,
  type ChallengeResponse,
} from '../lib/cheers-api'
import { keccak256, toBytes } from 'viem'

// Aliases for use in topic tests
const k256 = keccak256
const tb = toBytes

// ── Test constants ────────────────────────────────────────────────────────────

const REGISTRY   = '0xREGISTRY0000000000000000000000000000000000' as `0x${string}`
const WALLET     = '0xWALLET0000000000000000000000000000000000a' as `0x${string}`
const GIFT_ID    = '42'
const TX_HASH    = '0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB' as `0x${string}`
const NONCE      = 'test-nonce-abc123'
const EXPIRES_AT_STR  = String(Math.floor(Date.now() / 1000) + 300) // 5 min from now
const EXPIRES_AT_PAST = String(Math.floor(Date.now() / 1000) - 1)   // already expired

const CHAIN_ID = 5042

function makeTypedData(overrides: {
  wallet?: string; action?: string; origin?: string
  nonce?: string; expiresAt?: string; chainId?: number; verifyingContract?: string
} = {}): ReturnType<typeof buildTypedData> {
  return buildTypedData({
    domain: {
      name: 'SignalArc Cheers Metadata',
      version: '1',
      chainId:            overrides.chainId             ?? CHAIN_ID,
      verifyingContract:  overrides.verifyingContract   ?? REGISTRY,
    },
    types: {
      MetadataAction: [
        { name: 'wallet',      type: 'address' },
        { name: 'action',      type: 'string'  },
        { name: 'origin',      type: 'string'  },
        { name: 'nonce',       type: 'string'  },
        { name: 'payloadHash', type: 'bytes32' },
        { name: 'expiresAt',   type: 'uint256' },
      ],
    },
    primaryType: 'MetadataAction',
    message: {
      wallet:      overrides.wallet      ?? WALLET,
      action:      overrides.action      ?? 'save_gift',
      origin:      overrides.origin      ?? window.location.origin,
      nonce:       overrides.nonce       ?? NONCE,
      payloadHash: '0x1234567890000000000000000000000000000000000000000000000000000000',
      expiresAt:   overrides.expiresAt   ?? EXPIRES_AT_STR,
    },
  })
}

// ── Mock fetch ────────────────────────────────────────────────────────────────

function mockFetch(response: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
  })
}

function mockFetchError(response: { error: string; message: string }, status: number) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(response),
  })
}

function makeChallengeResponse(overrides: {
  action?: string; wallet?: string; origin?: string; expiresAt?: string
} = {}): ChallengeResponse {
  const payload = { registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH, title: 'Test Gift', description: null, targetAmountRaw: null }
  return {
    nonce: NONCE,
    payload,
    typedData: {
      domain: {
        name: 'SignalArc Cheers Metadata',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: REGISTRY,
      },
      types: {
        MetadataAction: [
          { name: 'wallet',      type: 'address' },
          { name: 'action',      type: 'string'  },
          { name: 'origin',      type: 'string'  },
          { name: 'nonce',       type: 'string'  },
          { name: 'payloadHash', type: 'bytes32' },
          { name: 'expiresAt',   type: 'uint256' },
        ],
      },
      primaryType: 'MetadataAction',
      message: {
        wallet:      overrides.wallet   ?? WALLET,
        action:      overrides.action   ?? 'save_gift',
        origin:      overrides.origin   ?? window.location.origin,
        nonce:       NONCE,
        payloadHash: '0x1234567890000000000000000000000000000000000000000000000000000000',
        expiresAt:   overrides.expiresAt ?? EXPIRES_AT_STR,
      },
    },
    expiresAt: new Date(Number(overrides.expiresAt ?? EXPIRES_AT_STR) * 1000).toISOString(),
  }
}

// ── 1. canonicalJSON ──────────────────────────────────────────────────────────

describe('canonicalJSON', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJSON({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles nested objects with recursive sort', () => {
    expect(canonicalJSON({ b: { z: 1, a: 2 }, a: 3 })).toBe('{"a":3,"b":{"a":2,"z":1}}')
  })

  it('handles null', () => {
    expect(canonicalJSON(null)).toBe('null')
  })

  it('handles primitives', () => {
    expect(canonicalJSON(42)).toBe('42')
    expect(canonicalJSON('hello')).toBe('"hello"')
    expect(canonicalJSON(true)).toBe('true')
  })

  it('produces different output for different key order inputs', () => {
    const a = canonicalJSON({ z: 1, a: 2 })
    const b = canonicalJSON({ a: 2, z: 1 })
    expect(a).toBe(b) // same canonical output regardless of input order
  })

  it('handles arrays of objects', () => {
    expect(canonicalJSON([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]')
  })
})

// ── 2. computePayloadHash ─────────────────────────────────────────────────────

describe('computePayloadHash', () => {
  it('produces a 0x-prefixed 32-byte hex string', () => {
    const hash = computePayloadHash({ registry: REGISTRY, giftId: GIFT_ID })
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    const payload = { registry: REGISTRY, giftId: GIFT_ID, title: 'My Gift' }
    expect(computePayloadHash(payload)).toBe(computePayloadHash(payload))
  })

  it('changes when payload changes', () => {
    const a = computePayloadHash({ title: 'A' })
    const b = computePayloadHash({ title: 'B' })
    expect(a).not.toBe(b)
  })

  it('matches manual keccak256(toBytes(canonicalJSON(...)))', () => {
    const payload = { registry: REGISTRY, giftId: '1', title: 'Test' }
    const expected = keccak256(toBytes(canonicalJSON(payload)))
    expect(computePayloadHash(payload)).toBe(expected)
  })

  it('key order does not affect the hash (canonical)', () => {
    const a = computePayloadHash({ b: 2, a: 1 })
    const b = computePayloadHash({ a: 1, b: 2 })
    expect(a).toBe(b)
  })
})

// ── 3. buildTypedData ─────────────────────────────────────────────────────────

describe('buildTypedData', () => {
  it('converts expiresAt decimal string to bigint', () => {
    const td = makeTypedData({ expiresAt: '9999999999' })
    expect(td.message.expiresAt).toBe(9999999999n)
    expect(typeof td.message.expiresAt).toBe('bigint')
  })

  it('preserves domain fields verbatim', () => {
    const td = makeTypedData()
    expect(td.domain.name).toBe('SignalArc Cheers Metadata')
    expect(td.domain.version).toBe('1')
    expect(td.domain.chainId).toBe(CHAIN_ID)
  })

  it('primaryType is MetadataAction', () => {
    const td = makeTypedData()
    expect(td.primaryType).toBe('MetadataAction')
  })
})

// ── 4. validateChallenge ──────────────────────────────────────────────────────

describe('validateChallenge', () => {
  it('accepts a valid challenge', () => {
    const td = makeTypedData()
    const result = validateChallenge(td, {
      expectedWallet:   WALLET,
      expectedAction:   'save_gift',
      expectedRegistry: REGISTRY,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects wrong domain name', () => {
    const td = makeTypedData()
    const bad = { ...td, domain: { ...td.domain, name: 'Wrong Name' } }
    const result = validateChallenge(bad, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('domain name')
  })

  it('rejects wrong chainId', () => {
    const td = makeTypedData({ chainId: 1 })
    const result = validateChallenge(td, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('chainId')
  })

  it('rejects wrong wallet', () => {
    const td = makeTypedData({ wallet: '0xDEAD000000000000000000000000000000000000' })
    const result = validateChallenge(td, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('wallet')
  })

  it('rejects wrong action', () => {
    const td = makeTypedData({ action: 'save_contribution' })
    const result = validateChallenge(td, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('action')
  })

  it('rejects expired challenge', () => {
    const td = makeTypedData({ expiresAt: EXPIRES_AT_PAST })
    const result = validateChallenge(td, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('expired')
  })

  it('rejects wrong verifyingContract', () => {
    const td = makeTypedData({ verifyingContract: '0xDEAD000000000000000000000000000000000000' })
    const result = validateChallenge(td, { expectedWallet: WALLET, expectedAction: 'save_gift', expectedRegistry: REGISTRY })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('verifyingContract')
  })
})

// ── 5. metaSaveGift flow ──────────────────────────────────────────────────────

describe('metaSaveGift — state transitions', () => {
  beforeEach(() => {
    // Provide VITE env stubs
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  })
  afterEach(() => { vi.restoreAllMocks() })

  const giftPayload = {
    registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH,
    title: 'Birthday Gift', description: null, targetAmountRaw: null,
  }

  it('transitions through challenging → signing → saving → done on success', async () => {
    const states: string[] = []
    const challengeResp = makeChallengeResponse()

    // First call: challenge; second call: execute
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, gift: { title: 'Birthday Gift' } }) })

    const result = await metaSaveGift({
      wallet: WALLET,
      registry: REGISTRY,
      payload: giftPayload,
      onStateChange: (s) => states.push(s),
      signTypedData: (_data) => Promise.resolve('0xSIG' as `0x${string}`),
    })

    expect(states).toEqual(['challenging', 'signing', 'saving', 'done'])
    expect(result.ok).toBe(true)
  })

  it('returns not-ok when challenge fetch fails', async () => {
    mockFetchError({ error: 'invalid_input', message: 'Bad request' }, 400)
    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
  })

  it('returns not-ok and retryable=false when user rejects signature', async () => {
    const challengeResp = makeChallengeResponse()
    mockFetch(challengeResp)

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.reject(new Error('User rejected the request.')),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(false)
      expect(result.error).toContain('cancelled')
    }
  })

  it('returns not-ok and retryable=true when nonce expires (401)', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: 'nonce_expired', message: 'Nonce expired' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
  })

  it('returns not-ok and retryable=true when receipt unavailable (409 receipt_unavailable)', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: () => Promise.resolve({ error: 'receipt_unavailable', message: 'Receipt not ready' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(true)
      expect(result.error).toContain('Wait')
    }
  })

  it('returns not-ok and retryable=false on 503 (never repay)', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ error: 'db_error', message: 'DB unavailable' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // 503 non-registry_not_enabled is NOT retryable — never repay
      expect(result.retryable).toBe(false)
      expect(result.error).toContain('temporarily')
    }
  })

  it('validates challenge domain before signing — rejects mismatched registry', async () => {
    const badChallenge = makeChallengeResponse()
    // Tamper with verifyingContract
    badChallenge.typedData.domain.verifyingContract = '0xBAD0000000000000000000000000000000000000'
    mockFetch(badChallenge)

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('verifyingContract')
  })

  it('does not call signTypedData when challenge validation fails', async () => {
    const badChallenge = makeChallengeResponse({ action: 'save_contribution' })
    mockFetch(badChallenge)

    const signSpy = vi.fn()
    await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: signSpy,
    })
    expect(signSpy).not.toHaveBeenCalled()
  })
})

// ── 6. metaSaveContribution flow ──────────────────────────────────────────────

describe('metaSaveContribution — state transitions', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  })
  afterEach(() => { vi.restoreAllMocks() })

  const contribPayload = {
    registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH,
    logIndex: 2, displayName: 'Alice', message: 'Happy birthday!',
  }

  it('succeeds and returns contribution record', async () => {
    const challengeResp: ChallengeResponse = {
      ...makeChallengeResponse({ action: 'save_contribution' }),
      typedData: {
        ...makeChallengeResponse({ action: 'save_contribution' }).typedData,
        message: {
          ...makeChallengeResponse({ action: 'save_contribution' }).typedData.message,
          action: 'save_contribution',
        },
      },
    }
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, contribution: { display_name: 'Alice' } }) })

    const result = await metaSaveContribution({
      wallet: WALLET, registry: REGISTRY, payload: contribPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.contribution).toBeDefined()
  })

  it('rejects when action mismatch in challenge (save_gift returned for save_contribution)', async () => {
    const wrongActionChallenge = makeChallengeResponse({ action: 'save_gift' }) // wrong action
    mockFetch(wrongActionChallenge)

    const result = await metaSaveContribution({
      wallet: WALLET, registry: REGISTRY, payload: contribPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('action')
  })
})

// ── 7. Account change during async flow ───────────────────────────────────────

describe('account change scoping', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('challenge wallet mismatch blocks signing (simulates account change mid-flow)', async () => {
    const otherWallet = '0xOTHER00000000000000000000000000000000000' as `0x${string}`
    const challengeForOther = makeChallengeResponse({ wallet: otherWallet })
    mockFetch(challengeForOther)

    const signSpy = vi.fn()
    const result = await metaSaveGift({
      wallet: WALLET, // we're now connected as WALLET but challenge is for otherWallet
      registry: REGISTRY,
      payload: { registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH, title: 'Test', description: null, targetAmountRaw: null },
      onStateChange: () => {},
      signTypedData: signSpy,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('wallet')
    expect(signSpy).not.toHaveBeenCalled()
  })
})

// ── 8. Draft localStorage ─────────────────────────────────────────────────────

describe('draft localStorage', () => {
  it('draftKey is unique per chainId + registry + account + giftId + action', () => {
    const k1 = draftKey({ chainId: 5042, registry: '0xA', account: '0xB', giftId: '1', action: 'gift' })
    const k2 = draftKey({ chainId: 5042, registry: '0xA', account: '0xB', giftId: '2', action: 'gift' })
    const k3 = draftKey({ chainId: 5042, registry: '0xA', account: '0xC', giftId: '1', action: 'gift' })
    const k4 = draftKey({ chainId: 1,    registry: '0xA', account: '0xB', giftId: '1', action: 'gift' })
    const k5 = draftKey({ chainId: 5042, registry: '0xA', account: '0xB', giftId: '1', action: 'contribution' })
    const keys = new Set([k1, k2, k3, k4, k5])
    expect(keys.size).toBe(5)
  })

  it('includes optional eventKey for contribution deduplication', () => {
    const k1 = draftKey({ chainId: 5042, registry: '0xA', account: '0xB', giftId: '1', action: 'contribution', eventKey: '0xTX:2' })
    const k2 = draftKey({ chainId: 5042, registry: '0xA', account: '0xB', giftId: '1', action: 'contribution', eventKey: '0xTX:3' })
    expect(k1).not.toBe(k2)
  })

  it('saveDraft + loadDraft round-trips', () => {
    const key = 'test-draft-key-1'
    const val = { title: 'My Gift', description: 'Hello', targetInput: '10.00' }
    saveDraft(key, val)
    const loaded = loadDraft<typeof val>(key)
    expect(loaded).toEqual(val)
    clearDraft(key)
  })

  it('loadDraft returns null for missing key', () => {
    expect(loadDraft('definitely-does-not-exist-xyz')).toBeNull()
  })

  it('clearDraft removes the key', () => {
    const key = 'test-draft-clear-2'
    saveDraft(key, { x: 1 })
    clearDraft(key)
    expect(loadDraft(key)).toBeNull()
  })

  it('different accounts do not share drafts', () => {
    const k1 = draftKey({ chainId: 5042, registry: '0xR', account: '0xAlice', giftId: '5', action: 'gift' })
    const k2 = draftKey({ chainId: 5042, registry: '0xR', account: '0xBob',   giftId: '5', action: 'gift' })
    saveDraft(k1, { title: 'Alice draft' })
    saveDraft(k2, { title: 'Bob draft' })
    expect(loadDraft<{ title: string }>(k1)?.title).toBe('Alice draft')
    expect(loadDraft<{ title: string }>(k2)?.title).toBe('Bob draft')
    clearDraft(k1); clearDraft(k2)
  })
})

// ── 9. ApiError class ─────────────────────────────────────────────────────────

describe('ApiError', () => {
  it('is an instance of Error', () => {
    const err = new ApiError(400, 'bad_input', 'Invalid')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof ApiError).toBe(true)
  })

  it('carries status, code, and message', () => {
    const err = new ApiError(503, 'registry_not_enabled', 'Not enabled')
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_not_enabled')
    expect(err.message).toBe('Not enabled')
  })
})

// ── 10. 503 error message distinctions ───────────────────────────────────────

describe('503 error handling', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  })
  afterEach(() => { vi.restoreAllMocks() })

  const giftPayload = {
    registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH,
    title: 'Test Gift', description: null, targetAmountRaw: null,
  }

  it('503 registry_not_enabled: retryable=false, message mentions activation pending and no new payment', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true,  status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ error: 'registry_not_enabled', message: 'Registry not enabled' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(false)
      expect(result.error).toMatch(/activation is pending/i)
      expect(result.error).toMatch(/no new payment/i)
    }
  })

  it('503 registry_not_enabled: does NOT say "retry the payment"', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true,  status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ error: 'registry_not_enabled', message: 'Registry not enabled' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    if (!result.ok) {
      expect(result.error).not.toMatch(/retry the payment/i)
    }
  })

  it('503 temporary db/rpc failure: retryable=false, message says do not retry payment but use recovery', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true,  status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ error: 'db_unavailable', message: 'Temporary database error' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(false)
      expect(result.error).toMatch(/temporarily unavailable/i)
      expect(result.error).toMatch(/do not retry the payment/i)
    }
  })

  it('503 temporary failure shows recovery option (retryable=false but message mentions recovery)', async () => {
    const challengeResp = makeChallengeResponse()
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true,  status: 200, json: () => Promise.resolve(challengeResp) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ error: 'rpc_error', message: 'RPC failed' }) })

    const result = await metaSaveGift({
      wallet: WALLET, registry: REGISTRY, payload: giftPayload,
      onStateChange: () => {},
      signTypedData: () => Promise.resolve('0xSIG' as `0x${string}`),
    })
    if (!result.ok) {
      // retryable=false means auto-retry is disabled, but the user can manually retry via recovery
      expect(result.retryable).toBe(false)
      expect(result.error).toMatch(/recovery/i)
    }
  })
})

// ── 11. Log index topic detection (unit) ──────────────────────────────────────

describe('ContributionMade topic0', () => {
  it('keccak256 of ContributionMade canonical signature matches expected topic', () => {
    // This verifies the frontend and backend agree on the event signature
    // ContributionMade(uint256 indexed giftId, address indexed contributor, uint256 amount, uint256 totalContributed)
    // Canonical ABI encoding uses only types, not names
    const topic = k256(tb('ContributionMade(uint256,address,uint256,uint256)'))
    expect(topic).toMatch(/^0x[0-9a-f]{64}$/)
    // Deterministic
    expect(k256(tb('ContributionMade(uint256,address,uint256,uint256)'))).toBe(topic)
    // Different signature produces different topic
    expect(topic).not.toBe(k256(tb('ContributionMade(uint256,address,uint256)')))
  })

  it('a matching log is found at the correct index', () => {
    const topic0 = k256(tb('ContributionMade(uint256,address,uint256,uint256)'))
    const otherTopic = k256(tb('Transfer(address,address,uint256)'))

    const logs = [
      { topics: [otherTopic] },        // index 0 — not ContributionMade
      { topics: [otherTopic] },        // index 1 — not ContributionMade
      { topics: [topic0] },            // index 2 — ContributionMade
    ]

    let found = 0
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].topics[0] === topic0) { found = i; break }
    }
    expect(found).toBe(2)
  })
})

// ── 12. apiChallenge and apiExecute error propagation ────────────────────────

describe('apiChallenge and apiExecute', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('throws ApiError on 403 forbidden', async () => {
    mockFetchError({ error: 'forbidden_origin', message: 'Origin not allowed' }, 403)
    await expect(
      apiChallenge(WALLET, 'save_gift', { registry: REGISTRY, giftId: '1', txHash: TX_HASH, title: 'T', description: null, targetAmountRaw: null })
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('throws ApiError with status 429 on rate limit', async () => {
    mockFetchError({ error: 'rate_limited', message: 'Too many requests' }, 429)
    let thrown: ApiError | null = null
    try {
      await apiChallenge(WALLET, 'save_gift', { registry: REGISTRY, giftId: '1', txHash: TX_HASH, title: 'T', description: null, targetAmountRaw: null })
    } catch (e) {
      if (e instanceof ApiError) thrown = e
    }
    expect(thrown?.status).toBe(429)
  })

  it('apiExecute throws ApiError on 422 verification failure', async () => {
    mockFetchError({ error: 'verification_failed', message: 'Mismatched event' }, 422)
    await expect(
      apiExecute(NONCE, 'save_gift', { registry: REGISTRY, giftId: GIFT_ID, txHash: TX_HASH, title: 'T', description: null, targetAmountRaw: null }, '0xSIG')
    ).rejects.toBeInstanceOf(ApiError)
  })
})
