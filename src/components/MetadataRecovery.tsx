/**
 * MetadataRecovery — shown when the on-chain tx succeeded but metadata save failed.
 *
 * Allows the creator/contributor to retry saving metadata without initiating
 * any new blockchain transaction. Recovery uses the same confirmed txHash
 * that was already submitted.
 *
 * This signature authorizes saving metadata only. It does NOT transfer USDC
 * or approve token spending.
 */

import { useState, useCallback } from 'react'
import { useSignTypedData } from 'wagmi'
import { AlertTriangle, RefreshCw, CheckCircle2 } from 'lucide-react'
import {
  metaSaveGift,
  metaSaveContribution,
  type MetaSaveState,
  type MetadataTypedData,
  type SaveGiftPayload,
  type SaveContributionPayload,
  type GiftMeta,
  type ContributionMeta,
} from '../lib/cheers-api'
import { registryAddress } from '../lib/cheers-contract'

// ── Shared helpers ────────────────────────────────────────────────────────────

function metaStateLabel(state: MetaSaveState): string {
  switch (state) {
    case 'challenging': return 'Requesting challenge…'
    case 'signing':     return 'Sign in wallet…'
    case 'saving':      return 'Saving…'
    case 'done':        return 'Saved'
    default:            return 'Save details'
  }
}

/** Convert the MetadataTypedData (bigint expiresAt) to the shape wagmi expects. */
function toWagmiTypedData(data: MetadataTypedData) {
  return {
    domain:      data.domain,
    types:       { MetadataAction: data.types.MetadataAction },
    primaryType: 'MetadataAction' as const,
    message:     {
      wallet:      data.message.wallet,
      action:      data.message.action,
      origin:      data.message.origin,
      nonce:       data.message.nonce,
      payloadHash: data.message.payloadHash,
      expiresAt:   data.message.expiresAt, // bigint — wagmi supports this
    },
  }
}

// ── Gift metadata recovery ────────────────────────────────────────────────────

interface GiftMetaRecoveryProps {
  wallet: `0x${string}`
  payload: SaveGiftPayload
  onSaved: (meta: GiftMeta) => void
}

export function GiftMetaRecovery({ wallet, payload, onSaved }: GiftMetaRecoveryProps) {
  const registry = registryAddress()
  const { signTypedDataAsync } = useSignTypedData()

  const [metaState, setMetaState] = useState<MetaSaveState>('idle')
  const [metaError, setMetaError] = useState<string | null>(null)

  const handleSave = useCallback(async () => {
    if (!registry) return
    setMetaError(null)

    const result = await metaSaveGift({
      wallet,
      registry: registry,
      payload,
      onStateChange: setMetaState,
      signTypedData: async (data: MetadataTypedData) =>
        signTypedDataAsync(toWagmiTypedData(data)),
    })

    if (result.ok) {
      onSaved(result.gift!)
    } else {
      setMetaError(result.error)
      setMetaState('idle')
    }
  }, [wallet, registry, payload, onSaved, signTypedDataAsync])

  if (metaState === 'done') {
    return (
      <div
        className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
        style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}
      >
        <CheckCircle2 size={14} strokeWidth={2} style={{ color: 'var(--success)' }} />
        <span style={{ color: 'var(--success)' }}>Gift details saved.</span>
      </div>
    )
  }

  const busy = metaState === 'challenging' || metaState === 'signing' || metaState === 'saving'

  return (
    <div
      className="rounded-xl px-4 py-4 space-y-3"
      style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.18)' }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
            Gift created — details not saved
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            Your gift is live on-chain. Saving the title and details requires one wallet signature.
            No new transaction is needed.
          </p>
        </div>
      </div>

      {metaError && (
        <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">{metaError}</p>
      )}

      <button
        disabled={busy}
        onClick={() => void handleSave()}
        className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-opacity"
        style={{
          background: busy ? 'rgba(217,119,6,0.08)' : 'rgba(217,119,6,0.15)',
          border: '1px solid rgba(217,119,6,0.3)',
          color: 'var(--accent)',
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.7 : 1,
          minHeight: 40,
        }}
      >
        <RefreshCw size={13} strokeWidth={2} className={busy ? 'animate-spin' : ''} />
        {metaStateLabel(metaState)}
      </button>

      <p className="text-xs" style={{ color: 'var(--subtle)' }}>
        This signature authorizes saving title and description only.
        It does not transfer USDC or approve token spending.
      </p>
    </div>
  )
}

// ── Contribution greeting recovery ────────────────────────────────────────────

interface ContribGreetingRecoveryProps {
  wallet: `0x${string}`
  payload: SaveContributionPayload
  onSaved: (contribution: ContributionMeta) => void
}

export function ContribGreetingRecovery({ wallet, payload, onSaved }: ContribGreetingRecoveryProps) {
  const registry = registryAddress()
  const { signTypedDataAsync } = useSignTypedData()

  const [metaState, setMetaState] = useState<MetaSaveState>('idle')
  const [metaError, setMetaError] = useState<string | null>(null)

  const handleSave = useCallback(async () => {
    if (!registry) return
    setMetaError(null)

    const result = await metaSaveContribution({
      wallet,
      registry: registry,
      payload,
      onStateChange: setMetaState,
      signTypedData: async (data: MetadataTypedData) =>
        signTypedDataAsync(toWagmiTypedData(data)),
    })

    if (result.ok) {
      onSaved(result.contribution!)
    } else {
      setMetaError(result.error)
      setMetaState('idle')
    }
  }, [wallet, registry, payload, onSaved, signTypedDataAsync])

  if (metaState === 'done') {
    return (
      <div
        className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
        style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}
      >
        <CheckCircle2 size={14} strokeWidth={2} style={{ color: 'var(--success)' }} />
        <span style={{ color: 'var(--success)' }}>Greeting saved.</span>
      </div>
    )
  }

  const busy = metaState === 'challenging' || metaState === 'signing' || metaState === 'saving'

  return (
    <div
      className="rounded-xl px-4 py-4 space-y-3"
      style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.18)' }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
            Contribution confirmed — greeting not saved
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            Your USDC contribution is confirmed on-chain. Saving your greeting requires
            one wallet signature. No new transaction is needed.
          </p>
        </div>
      </div>

      {metaError && (
        <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">{metaError}</p>
      )}

      <button
        disabled={busy}
        onClick={() => void handleSave()}
        className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-opacity"
        style={{
          background: busy ? 'rgba(217,119,6,0.08)' : 'rgba(217,119,6,0.15)',
          border: '1px solid rgba(217,119,6,0.3)',
          color: 'var(--accent)',
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.7 : 1,
          minHeight: 40,
        }}
      >
        <RefreshCw size={13} strokeWidth={2} className={busy ? 'animate-spin' : ''} />
        {metaStateLabel(metaState)}
      </button>

      <p className="text-xs" style={{ color: 'var(--subtle)' }}>
        This signature authorizes saving your greeting only.
        It does not transfer USDC or approve token spending.
      </p>
    </div>
  )
}
