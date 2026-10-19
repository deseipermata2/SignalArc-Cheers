/**
 * cheers-api.ts — typed browser fetch wrapper for the SignalArc Cheers backend.
 *
 * API base: VITE_SUPABASE_URL + /functions/v1/cheers-api
 * Auth: apikey header = VITE_SUPABASE_PUBLISHABLE_KEY (browser-safe, never a secret).
 *
 * All amount fields are raw decimal strings in 6-decimal USDC units.
 * Parse amounts with BigInt(), never with parseFloat().
 *
 * The publishable key is a browser-safe identifier — it is NOT a bearer JWT.
 * Send it as the `apikey` header. The browser supplies Origin automatically; do
 * not set it manually.
 *
 * EIP-712 domain for MetadataAction:
 *   name: "SignalArc Cheers Metadata"
 *   version: "1"
 *   chainId: 5042
 *   verifyingContract: <configured registry address>
 *
 * primaryType: "MetadataAction"
 * Types (exact order matters for hashing):
 *   wallet:      address
 *   action:      string
 *   origin:      string
 *   nonce:       string
 *   payloadHash: bytes32
 *   expiresAt:   uint256
 *
 * payloadHash = keccak256(toBytes(canonicalJSON(normalizedPayload)))
 * canonicalJSON: recursively sort object keys lexicographically, preserve array order,
 * no extra whitespace. Use the normalizedPayload returned by the challenge, not the
 * payload you sent.
 */

import { keccak256, toBytes } from 'viem'
import { CHAIN_ID } from './cheers-contract'

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export function apiBase(): string | null {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  return `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/cheers-api`
}

export function isApiConfigured(): boolean {
  return apiBase() !== null
}

// ── Error types ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ── Backend data shapes ───────────────────────────────────────────────────────

export interface GiftMeta {
  chain_id: number
  registry_address: string
  gift_id: string
  creator_address: string
  recipient_address: string
  title: string | null
  description: string | null
  target_amount_raw: string | null
  gift_at: string              // ISO timestamp
  claim_deadline: string       // ISO timestamp
  creation_tx_hash: string
  creation_log_index: number
  created_at: string
}

export interface ContributionMeta {
  chain_id: number
  registry_address: string
  gift_id: string
  tx_hash: string
  log_index: number
  contributor_address: string
  amount_raw: string
  display_name: string | null
  message: string | null
  block_number: number
  confirmed_at: string
  recorded_at: string
}

export interface GiftResponse {
  gift: GiftMeta | null
  contributions: ContributionMeta[]
  total: number
  nextOffset: number | null
}

// ── Canonical JSON ────────────────────────────────────────────────────────────

/**
 * Produce deterministic JSON: recursively sort object keys lexicographically,
 * preserve array order, no extra whitespace.
 *
 * payloadHash = keccak256(toBytes(canonicalJSON(normalizedPayload)))
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(canonicalJSON).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',') + '}'
}

/**
 * Compute the payloadHash for EIP-712 signing.
 * payloadHash = keccak256(toBytes(canonicalJSON(normalizedPayload)))
 */
export function computePayloadHash(normalizedPayload: unknown): `0x${string}` {
  const json = canonicalJSON(normalizedPayload)
  return keccak256(toBytes(json))
}

// ── EIP-712 typed data builder ────────────────────────────────────────────────

export type MetadataAction = 'save_gift' | 'save_contribution'

export interface MetadataTypedData {
  domain: {
    name: string
    version: string
    chainId: number
    verifyingContract: `0x${string}`
  }
  types: {
    MetadataAction: Array<{ name: string; type: string }>
  }
  primaryType: 'MetadataAction'
  message: {
    wallet: `0x${string}`
    action: string
    origin: string
    nonce: string
    payloadHash: `0x${string}`
    expiresAt: bigint
  }
}

/**
 * Build the EIP-712 typedData for a MetadataAction signature.
 *
 * The expiresAt field in the challenge response is a decimal string; we convert
 * it to bigint here before passing to wagmi signTypedDataAsync.
 *
 * Validates that the returned challenge matches the local request before building.
 */
export function buildTypedData(
  challengeTypedData: {
    domain: {
      name: string; version: string; chainId: number; verifyingContract: string
    }
    types: { MetadataAction: Array<{ name: string; type: string }> }
    primaryType: string
    message: {
      wallet: string; action: string; origin: string
      nonce: string; payloadHash: string; expiresAt: string
    }
  },
): MetadataTypedData {
  return {
    domain: {
      name:              challengeTypedData.domain.name,
      version:           challengeTypedData.domain.version,
      chainId:           challengeTypedData.domain.chainId,
      verifyingContract: challengeTypedData.domain.verifyingContract as `0x${string}`,
    },
    types: {
      MetadataAction: challengeTypedData.types.MetadataAction,
    },
    primaryType: 'MetadataAction',
    message: {
      wallet:      challengeTypedData.message.wallet as `0x${string}`,
      action:      challengeTypedData.message.action,
      origin:      challengeTypedData.message.origin,
      nonce:       challengeTypedData.message.nonce,
      payloadHash: challengeTypedData.message.payloadHash as `0x${string}`,
      expiresAt:   BigInt(challengeTypedData.message.expiresAt),
    },
  }
}

// ── Validation helpers ────────────────────────────────────────────────────────

/** Validate the challenge domain/message against our local request. */
export interface ChallengeValidationParams {
  expectedWallet: `0x${string}`
  expectedAction: MetadataAction
  expectedRegistry: `0x${string}`
  expectedNonce?: string
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export function validateChallenge(
  challengeTypedData: MetadataTypedData,
  params: ChallengeValidationParams,
): ValidationResult {
  const { domain, message } = challengeTypedData

  if (domain.name !== 'SignalArc Cheers Metadata')
    return { ok: false, error: `Unexpected domain name: ${domain.name}` }
  if (domain.version !== '1')
    return { ok: false, error: `Unexpected domain version: ${domain.version}` }
  if (domain.chainId !== CHAIN_ID)
    return { ok: false, error: `Challenge chainId ${domain.chainId} does not match expected ${CHAIN_ID}` }
  if (domain.verifyingContract.toLowerCase() !== params.expectedRegistry.toLowerCase())
    return { ok: false, error: 'Challenge verifyingContract does not match registry address' }
  if (message.wallet.toLowerCase() !== params.expectedWallet.toLowerCase())
    return { ok: false, error: 'Challenge wallet does not match connected account' }
  if (message.action !== params.expectedAction)
    return { ok: false, error: `Challenge action "${message.action}" does not match expected "${params.expectedAction}"` }
  if (message.origin !== window.location.origin)
    return { ok: false, error: `Challenge origin "${message.origin}" does not match this window origin` }
  if (params.expectedNonce && message.nonce !== params.expectedNonce)
    return { ok: false, error: 'Challenge nonce mismatch' }

  // Check expiry (expiresAt is already bigint from buildTypedData)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (message.expiresAt <= nowSec)
    return { ok: false, error: 'Challenge has already expired. Request a new one.' }

  return { ok: true }
}

// ── Payload shapes ────────────────────────────────────────────────────────────

export interface SaveGiftPayload {
  registry: string
  giftId: string
  txHash: string
  title: string
  description?: string | null
  targetAmountRaw?: string | null
}

export interface SaveContributionPayload {
  registry: string
  giftId: string
  txHash: string
  logIndex: number
  message?: string | null
  displayName?: string | null
}

// ── Challenge response ────────────────────────────────────────────────────────

export interface ChallengeResponse {
  nonce: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any             // normalized payload — use this verbatim in execute
  typedData: {
    domain: {
      name: string; version: string; chainId: number; verifyingContract: string
    }
    types: { MetadataAction: Array<{ name: string; type: string }> }
    primaryType: string
    message: {
      wallet: string; action: string; origin: string
      nonce: string; payloadHash: string; expiresAt: string
    }
  }
  expiresAt: string        // ISO timestamp
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

async function apiFetch<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const base = apiBase()
  if (!base || !SUPABASE_KEY) throw new ApiError(0, 'not_configured', 'API not configured')

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      ...(options.headers ?? {}),
    },
    // Do NOT set Origin — browser supplies it automatically from window.location
    // Do NOT use credentials: 'include' — we don't use cookies
  })

  if (!res.ok) {
    let errBody: { error?: string; message?: string } = {}
    try { errBody = (await res.json()) as typeof errBody } catch { /* ignore */ }
    throw new ApiError(
      res.status,
      errBody.error ?? 'unknown',
      errBody.message ?? `HTTP ${res.status}`,
    )
  }

  return res.json() as Promise<T>
}

// ── Public API methods ────────────────────────────────────────────────────────

/** GET /cheers-api?route=health */
export async function apiHealth(): Promise<{
  service: string; version: string; chainId: number
  backend: string; registryReady: boolean; auth: string; moneySource: string
}> {
  const base = apiBase()
  if (!base) throw new ApiError(0, 'not_configured', 'API not configured')
  return apiFetch(`${base}?route=health`)
}

/**
 * GET /cheers-api?route=gift — fetch gift metadata + contributions (paginated).
 * Follows nextOffset until null to retrieve all pages.
 */
export async function apiGetGift(
  registry: string,
  giftId: string,
  offset = 0,
): Promise<GiftResponse> {
  const base = apiBase()
  if (!base) throw new ApiError(0, 'not_configured', 'API not configured')
  const params = new URLSearchParams({
    route: 'gift',
    registry,
    giftId,
    offset: String(offset),
  })
  return apiFetch<GiftResponse>(`${base}?${params}`)
}

/**
 * Fetch ALL contribution pages for a gift, following nextOffset.
 * Returns merged list of contributions.
 */
export async function apiGetAllContributions(
  registry: string,
  giftId: string,
): Promise<{ gift: GiftMeta | null; contributions: ContributionMeta[] }> {
  let offset = 0
  let gift: GiftMeta | null = null
  const contributions: ContributionMeta[] = []

  while (true) {
    const page = await apiGetGift(registry, giftId, offset)
    if (page.gift && !gift) gift = page.gift
    contributions.push(...page.contributions)
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }

  return { gift, contributions }
}

/** POST challenge — request a sign-and-save nonce for metadata. */
export async function apiChallenge(
  wallet: `0x${string}`,
  action: MetadataAction,
  payload: SaveGiftPayload | SaveContributionPayload,
): Promise<ChallengeResponse> {
  const base = apiBase()
  if (!base) throw new ApiError(0, 'not_configured', 'API not configured')
  return apiFetch<ChallengeResponse>(base, {
    method: 'POST',
    body: JSON.stringify({ op: 'challenge', wallet, action, payload }),
  })
}

/** POST execute — submit a signed MetadataAction. */
export async function apiExecute(
  nonce: string,
  action: MetadataAction,
  payload: SaveGiftPayload | SaveContributionPayload,
  signature: `0x${string}`,
): Promise<{ ok: true; gift?: GiftMeta; contribution?: ContributionMeta; immutableMetadata?: boolean }> {
  const base = apiBase()
  if (!base) throw new ApiError(0, 'not_configured', 'API not configured')
  return apiFetch(base, {
    method: 'POST',
    body: JSON.stringify({ op: 'execute', nonce, action, payload, signature }),
  })
}

// ── Draft + recovery localStorage ────────────────────────────────────────────

/**
 * Scoped draft key for metadata pending save.
 * Keyed by: chainId + registry + account + giftId + action (+ optional eventKey for contributions).
 */
export function draftKey(params: {
  chainId: number
  registry: string
  account: string
  giftId: string
  action: 'gift' | 'contribution'
  eventKey?: string   // e.g. txHash+logIndex for contribution uniqueness
}): string {
  const parts = [
    'cheers-draft',
    String(params.chainId),
    params.registry.toLowerCase(),
    params.account.toLowerCase(),
    params.giftId,
    params.action,
    ...(params.eventKey ? [params.eventKey] : []),
  ]
  return parts.join(':')
}

export interface GiftDraft {
  title: string
  description?: string
  targetAmountRaw?: string | null
  /** Saved after on-chain creation */
  confirmedTxHash?: string
  confirmedGiftId?: string
}

export interface ContributionDraft {
  displayName?: string
  message?: string
  /** Saved after on-chain confirmation */
  confirmedTxHash?: string
  confirmedLogIndex?: number
}

export function saveDraft<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* storage full — ignore */ }
}

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch { return null }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

// ── Metadata sign-and-save flow ───────────────────────────────────────────────

export type MetaSaveState =
  | 'idle'
  | 'challenging'
  | 'signing'
  | 'saving'
  | 'done'
  | 'failed'

export interface MetaSaveResult {
  ok: true
  gift?: GiftMeta
  contribution?: ContributionMeta
}

export interface MetaSaveError {
  ok: false
  error: string
  /** True when the nonce expired or was consumed — caller must request a new challenge. */
  retryable: boolean
}

/**
 * Full challenge→sign→execute flow for metadata.
 *
 * onStateChange: called on each state transition so the UI can update.
 * signTypedData: caller provides the wagmi signTypedDataAsync result.
 *
 * If the nonce expires during a retried failed operation, the caller must call
 * this function again with the SAME txHash — never initiate a new payment.
 */
export async function metaSaveGift(
  params: {
    wallet: `0x${string}`
    registry: `0x${string}`
    payload: SaveGiftPayload
    onStateChange: (s: MetaSaveState) => void
    signTypedData: (data: MetadataTypedData) => Promise<`0x${string}`>
  },
): Promise<MetaSaveResult | MetaSaveError> {
  const { wallet, registry, payload, onStateChange, signTypedData } = params

  // Step 1: challenge
  onStateChange('challenging')
  let challengeResp: ChallengeResponse
  try {
    challengeResp = await apiChallenge(wallet, 'save_gift', payload)
  } catch (err) {
    return { ok: false, error: apiErrorMessage(err), retryable: isRetryable(err) }
  }

  // Build and validate typed data
  const typedData = buildTypedData(challengeResp.typedData)
  const validation = validateChallenge(typedData, {
    expectedWallet: wallet,
    expectedAction: 'save_gift',
    expectedRegistry: registry,
    expectedNonce: challengeResp.nonce,
  })
  if (!validation.ok) {
    return { ok: false, error: validation.error, retryable: false }
  }

  // Step 2: sign
  onStateChange('signing')
  let signature: `0x${string}`
  try {
    signature = await signTypedData(typedData)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const cancelled = msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('cancel')
    return { ok: false, error: cancelled ? 'Signature cancelled.' : 'Signature failed.', retryable: !cancelled }
  }

  // Step 3: execute — use the normalized payload returned by the challenge
  onStateChange('saving')
  try {
    // The backend returns a normalized payload; we must send it verbatim.
    // Cast is safe: the backend's normalized payload satisfies SaveGiftPayload.
    const result = await apiExecute(challengeResp.nonce, 'save_gift', challengeResp.payload as SaveGiftPayload, signature)
    onStateChange('done')
    return { ok: true, gift: result.gift }
  } catch (err) {
    return { ok: false, error: apiErrorMessage(err), retryable: isRetryable(err) }
  }
}

export async function metaSaveContribution(
  params: {
    wallet: `0x${string}`
    registry: `0x${string}`
    payload: SaveContributionPayload
    onStateChange: (s: MetaSaveState) => void
    signTypedData: (data: MetadataTypedData) => Promise<`0x${string}`>
  },
): Promise<MetaSaveResult | MetaSaveError> {
  const { wallet, registry, payload, onStateChange, signTypedData } = params

  onStateChange('challenging')
  let challengeResp: ChallengeResponse
  try {
    challengeResp = await apiChallenge(wallet, 'save_contribution', payload)
  } catch (err) {
    return { ok: false, error: apiErrorMessage(err), retryable: isRetryable(err) }
  }

  const typedData = buildTypedData(challengeResp.typedData)
  const validation = validateChallenge(typedData, {
    expectedWallet: wallet,
    expectedAction: 'save_contribution',
    expectedRegistry: registry,
    expectedNonce: challengeResp.nonce,
  })
  if (!validation.ok) {
    return { ok: false, error: validation.error, retryable: false }
  }

  onStateChange('signing')
  let signature: `0x${string}`
  try {
    signature = await signTypedData(typedData)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const cancelled = msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('cancel')
    return { ok: false, error: cancelled ? 'Signature cancelled.' : 'Signature failed.', retryable: !cancelled }
  }

  onStateChange('saving')
  try {
    const result = await apiExecute(challengeResp.nonce, 'save_contribution', challengeResp.payload as SaveContributionPayload, signature)
    onStateChange('done')
    return { ok: true, contribution: result.contribution }
  } catch (err) {
    return { ok: false, error: apiErrorMessage(err), retryable: isRetryable(err) }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Signature expired or already used. Please try again.'
    if (err.status === 403) return 'This origin is not authorized. Contact support.'
    if (err.status === 409 && err.code === 'receipt_unavailable')
      return 'On-chain receipt not yet available. Wait a moment, then retry with the same transaction.'
    if (err.status === 409 && err.code === 'gift_metadata_missing')
      return 'Save the gift details first, then save your greeting.'
    if (err.status === 422) return 'Verification failed. The transaction or signature does not match.'
    if (err.status === 429) return 'Too many requests. Wait one minute and try again.'
    if (err.status === 503 && err.code === 'registry_not_enabled')
      return 'Backend activation is pending for this registry. Your on-chain transaction succeeded. Try saving details once the registry is activated — no new payment needed.'
    if (err.status === 503) return 'Service temporarily unavailable. Your on-chain transaction succeeded. Do not retry the payment — use the recovery option to save your details once service resumes.'
    return err.message
  }
  if (err instanceof Error) return err.message
  return 'Unexpected error.'
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    // 401 = expired nonce, can retry with new challenge for same tx
    // 409 receipt_unavailable = wait and retry
    // 429 = wait and retry
    return err.status === 401 || err.status === 409 || err.status === 429
  }
  return false
}
