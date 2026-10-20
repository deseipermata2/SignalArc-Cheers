/**
 * GiftMetadataRecoveryPanel — full recovery UI for a gift whose on-chain
 * record exists but whose Supabase metadata was never saved or failed to save.
 *
 * Flow:
 * 1. Fetch the GiftCreated event from the registry to obtain the canonical
 *    txHash and verify the connected wallet is the creator.
 * 2. Restore any persisted draft from localStorage (scoped to
 *    chainId + registry + account + giftId).
 * 3. If no draft title exists, show MetadataForm to collect title /
 *    description / optional target.
 * 4. Persist the complete payload before requesting a signature so a
 *    reload or rejected signature does not lose recovery information.
 * 5. Render GiftMetaRecovery which drives the challenge → EIP-712 sign →
 *    execute flow.
 * 6. On success, call onSaved and clear only the matching draft.
 *
 * This component never initiates a blockchain transaction.
 * It works for already-claimed gifts (phase CLOSED).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { AlertTriangle, Loader2, Search } from 'lucide-react'
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

  // Load draft synchronously on first render (lazy initializer avoids set-state-in-effect).
  // Re-load when dk changes (account or giftId changed) via a ref-guarded tick pattern.
  const lastDkRef = useRef<string | null>(null)
  const [draft, setDraft] = useState<GiftDraft | null>(() => (dk ? loadDraft<GiftDraft>(dk) : null))

  // ── 3. Form state ──────────────────────────────────────────────────────────
  // Initialize fields from the draft loaded above (same lazy initializer trick).
  const [fields, setFields] = useState<GiftMetaFields>(() => {
    const stored = dk ? loadDraft<GiftDraft>(dk) : null
    return stored
      ? { title: stored.title ?? '', description: stored.description ?? '', targetInput: stored.targetAmountRaw ?? '' }
      : EMPTY_FIELDS
  })
  const [errors, setErrors] = useState<GiftMetaErrors>(EMPTY_ERRORS)

  // When the scoped key changes (wallet or giftId changed), reload draft.
  // Uses a ref to detect the change without a synchronous setState-in-effect.
  const [dkTick, setDkTick] = useState(0)
  useEffect(() => {
    if (lastDkRef.current !== dk) {
      lastDkRef.current = dk
      setDkTick(t => t + 1)  // trigger re-read below via dkTick
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dk])

  // dkTick change → reload draft and fields via a scheduled microtask (avoids synchronous setState)
  const draftReloadedRef = useRef(false)
  useEffect(() => {
    if (dkTick === 0 && draftReloadedRef.current) return
    draftReloadedRef.current = true
    if (!dk) return
    const stored = loadDraft<GiftDraft>(dk)
    // schedule the state updates so React batches them outside the effect body
    queueMicrotask(() => {
      setDraft(stored)
      if (stored) {
        setFields({
          title: stored.title ?? '',
          description: stored.description ?? '',
          targetInput: stored.targetAmountRaw ?? '',
        })
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

  // ── 4. Derived state ───────────────────────────────────────────────────────
  const txHash = event?.txHash ?? draft?.confirmedTxHash
  const isCreator = event
    ? event.creator.toLowerCase() === connectedWallet.toLowerCase()
    : false

  const titleValue = fields.title.trim()
  const hasFormErrors = !!(errors.title || errors.description || errors.target)

  const buildPayload = useCallback((txH: string): SaveGiftPayload | null => {
    if (!registry || !titleValue || hasFormErrors) return null
    // Validate silently to confirm no errors; if validateMetadata sets errors we
    // can't call setState here, so we only proceed when the current errors are clear.
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

  // Event error or not found — fall back to draft txHash if available
  if (eventState === 'error' || eventState === 'not-found') {
    if (draft?.confirmedTxHash) {
      const fallbackPayload = buildPayload(draft.confirmedTxHash)
      return (
        <div className="space-y-3">
          <div className="rounded-xl px-4 py-3 text-xs flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--muted)' }}>
            <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
            <span>
              Could not fetch the creation event{eventError ? `: ${eventError}` : ''}.
              Using your saved transaction hash for recovery.
            </span>
          </div>
          <MetadataForm fields={fields} errors={errors} onChange={handleFieldsChange} onErrorChange={handleErrorsChange} />
          {fallbackPayload && !hasFormErrors && titleValue
            ? <GiftMetaRecovery wallet={connectedWallet} payload={fallbackPayload} onSaved={handleSaved} />
            : <p className="text-xs" style={{ color: 'var(--subtle)' }}>Enter a title above to enable recovery.</p>
          }
        </div>
      )
    }

    return (
      <div className="rounded-2xl px-5 py-4 space-y-3"
        style={{ background: 'rgba(217,119,6,0.04)', border: '1px dashed rgba(217,119,6,0.2)' }}>
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>Title not saved</p>
            <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>
              {eventState === 'not-found'
                ? 'The creation event for this gift was not found in the contract logs.'
                : `Could not fetch the creation event: ${eventError ?? 'unknown error'}.`}
              {' '}Connect the original creator wallet to enable recovery.
            </p>
          </div>
        </div>
        <button onClick={refetch}
          className="flex items-center gap-1.5 text-xs font-semibold"
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <Search size={11} strokeWidth={2.5} />
          Try again
        </button>
      </div>
    )
  }

  // Event found but not the creator
  if (eventState === 'ok' && !isCreator) {
    return (
      <div className="rounded-2xl px-5 py-4"
        style={{ background: 'rgba(217,119,6,0.04)', border: '1px dashed rgba(217,119,6,0.2)' }}>
        <p className="text-sm font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Title not saved</p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          Only the creator can save gift details. Connect the creator wallet to add a title.
        </p>
      </div>
    )
  }

  // Creator confirmed — form + recovery
  const confirmedPayload = txHash ? buildPayload(txHash) : null

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
            {titleValue
              ? 'Fix the errors above to continue.'
              : 'Enter a title above to save gift details.'}
          </p>
      }
    </div>
  )
}
