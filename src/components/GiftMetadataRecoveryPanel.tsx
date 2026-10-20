/**
 * GiftMetadataRecoveryPanel — full recovery UI for a gift whose on-chain
 * record exists but whose Supabase metadata was never saved or failed to save.
 *
 * Flow:
 * 1. Fetch the GiftCreated event from the registry using bounded block pagination.
 * 2. When the event is found, confirm the connected wallet is the creator.
 * 3. When event lookup fails (any error, including range limits), show a manual
 *    transaction hash input so the recovery form is never blocked by an RPC error.
 * 4. Restore any persisted draft from localStorage (scoped to
 *    chainId + registry + account + giftId).
 * 5. Show MetadataForm to collect title / description / optional target.
 * 6. Persist the complete payload before requesting a signature.
 * 7. Render GiftMetaRecovery which drives the challenge → EIP-712 sign → execute flow.
 * 8. On success, call onSaved and clear only the matching draft.
 *
 * This component never initiates a blockchain transaction.
 * It works for already-claimed gifts (phase CLOSED).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { AlertTriangle, Loader2, Search, Hash } from 'lucide-react'
import { isHash } from 'viem'
import {
  CHAIN_ID,
  registryAddress,
} from '../lib/cheers-contract'
import {
  draftKey,
  saveDraft,
  loadDraft,
  clearDraft,
  type GiftDraft,
  type SaveGiftPayload,
  type GiftMeta,
} from '../lib/cheers-api'
import { MetadataForm, metaFieldsToPayload, type GiftMetaFields, type GiftMetaErrors } from './MetadataForm'
import { GiftMetaRecovery } from './MetadataRecovery'
import { useGiftCreatedEvent } from '../hooks/useGiftCreatedEvent'

interface Props {
  giftId: string
  connectedWallet: `0x${string}`
  onSaved: (meta: GiftMeta) => void
}

const EMPTY_FIELDS: GiftMetaFields = { title: '', description: '', targetInput: '' }
const EMPTY_ERRORS: GiftMetaErrors = { title: null, description: null, target: null }

export function GiftMetadataRecoveryPanel({ giftId, connectedWallet, onSaved }: Props) {
  const registry = registryAddress()

  // ── 1. Fetch creation event ────────────────────────────────────────────────
  const { state: eventState, event, error: eventError, refetch } = useGiftCreatedEvent(giftId)

  // ── 2. Draft ───────────────────────────────────────────────────────────────
  const dk = registry
    ? draftKey({ chainId: CHAIN_ID, registry, account: connectedWallet, giftId, action: 'gift' })
    : null

  // Load draft synchronously on first render.
  const lastDkRef = useRef<string | null>(null)
  const [draft, setDraft] = useState<GiftDraft | null>(() => (dk ? loadDraft<GiftDraft>(dk) : null))

  // ── 3. Form state ──────────────────────────────────────────────────────────
  const [fields, setFields] = useState<GiftMetaFields>(() => {
    const stored = dk ? loadDraft<GiftDraft>(dk) : null
    return stored
      ? { title: stored.title ?? '', description: stored.description ?? '', targetInput: stored.targetAmountRaw ?? '' }
      : EMPTY_FIELDS
  })
  const [errors, setErrors] = useState<GiftMetaErrors>(EMPTY_ERRORS)

  // ── 4. Manual txHash input (fallback when event lookup fails) ───────────────
  const [manualTxHash, setManualTxHash] = useState<string>(draft?.confirmedTxHash ?? '')
  const [manualTxHashError, setManualTxHashError] = useState<string | null>(null)

  // When the scoped key changes (wallet or giftId changed), reload draft.
  const [dkTick, setDkTick] = useState(0)
  useEffect(() => {
    if (lastDkRef.current !== dk) {
      lastDkRef.current = dk
      setDkTick(t => t + 1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dk])

  const draftReloadedRef = useRef(false)
  useEffect(() => {
    if (dkTick === 0 && draftReloadedRef.current) return
    draftReloadedRef.current = true
    if (!dk) return
    const stored = loadDraft<GiftDraft>(dk)
    queueMicrotask(() => {
      setDraft(stored)
      if (stored) {
        setFields({
          title: stored.title ?? '',
          description: stored.description ?? '',
          targetInput: stored.targetAmountRaw ?? '',
        })
        if (stored.confirmedTxHash) setManualTxHash(stored.confirmedTxHash)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dkTick])

  const handleFieldsChange = useCallback((next: GiftMetaFields) => {
    setFields(next)
    setErrors(EMPTY_ERRORS)
  }, [])

  const handleErrorsChange = useCallback((next: GiftMetaErrors) => {
    setErrors(next)
  }, [])

  // ── 5. Derived state ───────────────────────────────────────────────────────
  // Prefer event txHash; fall back to manually entered hash.
  const txHashFromEvent = event?.txHash ?? null
  const txHash = txHashFromEvent ?? (manualTxHash.trim() || draft?.confirmedTxHash) ?? undefined

  const isCreator = event
    ? event.creator.toLowerCase() === connectedWallet.toLowerCase()
    : true  // when event not available, allow manual entry; backend verifies creator

  const titleValue = fields.title.trim()
  const hasFormErrors = !!(errors.title || errors.description || errors.target)

  const validateManualTxHash = useCallback((val: string): boolean => {
    const v = val.trim()
    if (!v) {
      setManualTxHashError('Enter the transaction hash from your createGift transaction.')
      return false
    }
    if (!isHash(v)) {
      setManualTxHashError('Not a valid transaction hash. It should be 0x followed by 64 hex characters.')
      return false
    }
    setManualTxHashError(null)
    return true
  }, [])

  const buildPayload = useCallback((txH: string): SaveGiftPayload | null => {
    if (!registry || !titleValue || hasFormErrors) return null
    const derived = metaFieldsToPayload(fields)
    if (!derived.title) return null
    return {
      registry,
      giftId,
      txHash: txH,
      title: derived.title,
      description: derived.description,
      targetAmountRaw: derived.targetAmountRaw,
    }
  }, [registry, giftId, titleValue, fields, hasFormErrors])

  // Persist draft on every field change when we have a tx hash
  useEffect(() => {
    if (!dk || !titleValue) return
    saveDraft<GiftDraft>(dk, {
      title: titleValue,
      description: fields.description.trim() || undefined,
      targetAmountRaw: fields.targetInput.trim() || undefined,
      confirmedTxHash: txHash,
      confirmedGiftId: giftId,
    })
  }, [dk, titleValue, fields, txHash, giftId])

  const handleSaved = useCallback((meta: GiftMeta) => {
    if (dk) clearDraft(dk)
    onSaved(meta)
  }, [dk, onSaved])

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!registry) return null

  // Loading
  if (eventState === 'fetching' || eventState === 'idle') {
    return (
      <div className="rounded-2xl px-5 py-4" style={{ background: 'rgba(217,119,6,0.04)', border: '1px dashed rgba(217,119,6,0.2)' }}>
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
          <Loader2 size={13} strokeWidth={2} className="animate-spin shrink-0" />
          Looking up creation event…
        </div>
      </div>
    )
  }

  // Event not the creator
  if (eventState === 'ok' && !isCreator) {
    return (
      <div className="rounded-2xl px-5 py-4" style={{ background: 'rgba(217,119,6,0.04)', border: '1px dashed rgba(217,119,6,0.2)' }}>
        <p className="text-sm font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Title not saved</p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          Only the creator can save gift details. Connect the creator wallet to add a title.
        </p>
      </div>
    )
  }

  // Event found — use canonical txHash from event
  if (eventState === 'ok' && txHashFromEvent) {
    const confirmedPayload = buildPayload(txHashFromEvent)
    return (
      <div className="space-y-3">
        <MetadataForm
          fields={fields}
          errors={errors}
          onChange={handleFieldsChange}
          onErrorChange={handleErrorsChange}
        />
        {confirmedPayload && !hasFormErrors && titleValue
          ? <GiftMetaRecovery wallet={connectedWallet} payload={confirmedPayload} onSaved={handleSaved} />
          : <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              {titleValue ? 'Fix the errors above to continue.' : 'Enter a title above to save gift details.'}
            </p>
        }
      </div>
    )
  }

  // Event lookup failed or not-found — always show manual txHash input
  // The form is never blocked; the creator can enter the txHash from their wallet history.
  const manualHashValid = manualTxHash.trim().length > 0 && isHash(manualTxHash.trim())
  const effectiveTxHash = manualHashValid ? manualTxHash.trim() : (draft?.confirmedTxHash ?? '')
  const fallbackPayload = effectiveTxHash ? buildPayload(effectiveTxHash) : null

  return (
    <div className="space-y-4">
      {/* Error notice — concise, no raw RPC details */}
      <div className="rounded-xl px-4 py-3 text-xs flex items-start gap-2"
        style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.18)', color: 'var(--muted)' }}>
        <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
        <span>
          {eventState === 'not-found'
            ? 'Creation event not found in contract logs.'
            : (eventError ?? 'Could not fetch the creation event.')}
          {' '}Enter the transaction hash from your wallet history to continue.
        </span>
      </div>

      {/* Manual txHash input — always available on error */}
      <div>
        <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--ink-2)' }}>
          <Hash size={11} strokeWidth={2.5} className="inline mr-1" />
          Creation transaction hash
        </label>
        <input
          type="text"
          value={manualTxHash}
          onChange={e => {
            setManualTxHash(e.target.value)
            if (e.target.value.trim()) setManualTxHashError(null)
          }}
          onBlur={() => { if (manualTxHash.trim()) validateManualTxHash(manualTxHash) }}
          placeholder="0x..."
          spellCheck={false}
          className="w-full rounded-xl px-3 py-2.5 text-xs font-mono"
          style={{
            background: 'var(--surface-2)',
            border: manualTxHashError ? '1px solid rgba(248,113,113,0.5)' : '1px solid var(--border)',
            color: 'var(--ink-1)',
            outline: 'none',
          }}
        />
        {manualTxHashError && (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{manualTxHashError}</p>
        )}
        <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
          Find this hash in your wallet's transaction history on{' '}
          <a href="https://explorer.arc.io" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            explorer.arc.io
          </a>.
          This signature authorizes saving metadata only — no USDC transfer.
        </p>
      </div>

      {/* Retry event lookup */}
      <button
        type="button"
        onClick={refetch}
        className="flex items-center gap-1.5 text-xs"
        style={{ color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <Search size={11} strokeWidth={2.5} />
        Retry automatic lookup
      </button>

      {/* Metadata form */}
      <MetadataForm
        fields={fields}
        errors={errors}
        onChange={handleFieldsChange}
        onErrorChange={handleErrorsChange}
      />

      {/* Recovery action — enabled only when txHash + title are valid */}
      {fallbackPayload && !hasFormErrors && titleValue && manualHashValid
        ? <GiftMetaRecovery wallet={connectedWallet} payload={fallbackPayload} onSaved={handleSaved} />
        : <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            {!effectiveTxHash
              ? 'Enter the creation transaction hash above to continue.'
              : !titleValue
              ? 'Enter a title above to save gift details.'
              : manualHashValid ? 'Fix the errors above to continue.' : 'Enter a valid transaction hash (0x… 64 hex chars).'}
          </p>
      }
    </div>
  )
}
