/**
 * CreateGiftPage — create a new community gift on CheersGiftRegistry.
 *
 * Collects:
 *   - Title (required), description (optional), funding target (optional, visual only)
 *   - Recipient wallet address (validated checksum)
 *   - Gift date+time (must be in the future), displayed in the user's timezone
 *   - Claim window: 7, 14, or 30 days (default 30)
 *
 * Flow:
 *   1. Form (metadata + gift params) → save draft to localStorage
 *   2. Review panel (recipient + deadlines confirmed)
 *   3. createGift() on-chain → wait for receipt → parse GiftCreated event
 *   4. Sign and save metadata via API (challenge → EIP-712 sign → execute)
 *   5. Share URL with gift ID
 *
 * If metadata save fails, retain the confirmed gift ID/hash and show recovery.
 * The on-chain creation is always shown regardless of metadata save result.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignTypedData } from 'wagmi'
import { isAddress, getAddress, parseAbiItem, decodeEventLog } from 'viem'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Gift, Calendar, Clock, CheckCircle2, Copy, ExternalLink } from 'lucide-react'
import { TxButton, type TxState } from '../components/TxButton'
import { ContractPendingNotice } from '../components/ContractPendingNotice'
import { WrongNetwork } from '../components/WrongNetwork'
import { MetadataForm, validateMetadata, metaFieldsToPayload, type GiftMetaFields, type GiftMetaErrors } from '../components/MetadataForm'
import { GiftMetaRecovery } from '../components/MetadataRecovery'
import { usePendingTx } from '../hooks/usePendingTx'
import { useContractBytecode } from '../hooks/useContractBytecode'
import {
  registryAddress,
  isRegistryConfigured,
  CHAIN_ID,
  CLAIM_DURATIONS,
  DEFAULT_CLAIM_DURATION_IDX,
  fmtDate,
  fmtAddress,
  decodeContractError,
  simulateAndEstimate,
  CHEERS_ABI,
} from '../lib/cheers-contract'
import {
  metaSaveGift,
  saveDraft,
  loadDraft,
  clearDraft,
  draftKey,
  type MetaSaveState,
  type SaveGiftPayload,
  type GiftMeta,
} from '../lib/cheers-api'
import { buildTxExplorerUrl } from '../onchain-facts'

// ── Timezone helpers ──────────────────────────────────────────────────────────

function localTzLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offset = -new Date().getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const h = Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0')
  const m = (Math.abs(offset) % 60).toString().padStart(2, '0')
  return `${tz} (UTC${sign}${h}:${m})`
}

function localDateTimeToUnix(value: string): bigint | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  if (isNaN(ms)) return null
  if (ms <= Date.now()) return null
  return BigInt(Math.floor(ms / 1000))
}

function minDateTimeLocal(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000)
  d.setSeconds(0, 0)
  return d.toISOString().slice(0, 16)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-semibold mb-2" style={{ color: 'var(--ink-2)' }}>
      {children}
    </p>
  )
}

function FieldError({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <p className="text-xs mt-1.5" style={{ color: 'var(--danger)' }} role="alert">{msg}</p>
}

function FormCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl px-5 py-5 space-y-5">
      {children}
    </div>
  )
}

// ── Draft key ─────────────────────────────────────────────────────────────────

function giftDraftKey(registry: string | null, account: string | undefined): string | null {
  if (!registry || !account) return null
  return draftKey({ chainId: CHAIN_ID, registry, account, giftId: 'new', action: 'gift' })
}

// ── MetaSave state label ──────────────────────────────────────────────────────

function metaStateText(state: MetaSaveState): string {
  switch (state) {
    case 'challenging': return 'Requesting challenge…'
    case 'signing':     return 'Sign in wallet to save details…'
    case 'saving':      return 'Saving gift details…'
    case 'done':        return 'Details saved.'
    default:            return ''
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface CreateGiftPageProps {
  onBack: () => void
  onGiftCreated: (giftId: string) => void
}

export function CreateGiftPage({ onBack, onGiftCreated }: CreateGiftPageProps) {
  const { address: account, isConnected, chainId } = useAccount()
  const registry = registryAddress()
  const { signTypedDataAsync } = useSignTypedData()

  // ── Bytecode validation ────────────────────────────────────────────────────
  const bytecodeStatus = useContractBytecode(registry)
  const writesEnabled  = bytecodeStatus === 'ok'

  // ── Metadata fields ────────────────────────────────────────────────────────

  const [metaFields, setMetaFields] = useState<GiftMetaFields>({ title: '', description: '', targetInput: '' })
  const [metaErrors, setMetaErrors] = useState<GiftMetaErrors>({ title: null, description: null, target: null })

  // ── Form fields ───────────────────────────────────────────────────────────

  const [recipient, setRecipient]           = useState('')
  const [recipientError, setRecipientError] = useState<string | null>(null)
  const [dateValue, setDateValue]           = useState('')
  const [dateError, setDateError]           = useState<string | null>(null)
  const [durationIdx, setDurationIdx]       = useState(DEFAULT_CLAIM_DURATION_IDX)
  const [step, setStep]                     = useState<'form' | 'review' | 'success'>('form')
  const [copiedUrl, setCopiedUrl]           = useState(false)

  const parsedRecipient = useMemo<`0x${string}` | null>(() => {
    if (!recipient.trim()) return null
    if (!isAddress(recipient.trim())) return null
    return getAddress(recipient.trim())
  }, [recipient])

  const giftAtUnix = useMemo<bigint | null>(() => localDateTimeToUnix(dateValue), [dateValue])
  const claimDuration = CLAIM_DURATIONS[durationIdx].seconds
  const claimDeadlineUnix = useMemo<bigint | null>(() =>
    giftAtUnix !== null ? giftAtUnix + claimDuration : null,
  [giftAtUnix, claimDuration])

  // ── Transaction state ─────────────────────────────────────────────────────

  const [txState, setTxState]                     = useState<TxState>('idle')
  const [txError, setTxError]                     = useState<string | null>(null)
  const [confirmedGiftId, setConfirmedGiftId]     = useState<string | null>(null)
  const [confirmedTxHash, setConfirmedTxHash]     = useState<`0x${string}` | null>(null)

  // ── Metadata save state ────────────────────────────────────────────────────

  const [metaSaveState, setMetaSaveState]         = useState<MetaSaveState>('idle')
  const [metaSaveError, setMetaSaveError]         = useState<string | null>(null)
  const [metaSavePayload, setMetaSavePayload]     = useState<SaveGiftPayload | null>(null)
  const [savedMeta, setSavedMeta]                 = useState<GiftMeta | null>(null)

  // ── Gas simulation ────────────────────────────────────────────────────────

  const [gasEstimate, setGasEstimate]   = useState<string | null>(null)
  const [simError, setSimError]         = useState<string | null>(null)
  const [isSimulating, setIsSimulating] = useState(false)

  // ── Pending tx ────────────────────────────────────────────────────────────

  const {
    pendingHash,
    setPending: setPendingHash,
    clearPending,
  } = usePendingTx(registry, account, 'new', 'createGift')

  const { writeContractAsync } = useWriteContract()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: pendingHash ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!pendingHash },
  })

  // ── Load persisted draft on mount ─────────────────────────────────────────

  useEffect(() => {
    const key = giftDraftKey(registry, account)
    if (!key) return
    const draft = loadDraft<GiftMetaFields>(key)
    if (draft) setMetaFields(draft)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, account])

  // ── Auto-save draft on change ─────────────────────────────────────────────

  useEffect(() => {
    const key = giftDraftKey(registry, account)
    if (!key) return
    saveDraft(key, metaFields)
  }, [registry, account, metaFields])

  // ── Parse GiftCreated event from receipt ──────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => {
    if (!receipt) return
    if (receipt.status !== 'success') {
      setTxState('failed')
      setTxError('Transaction was reverted on chain.')
      clearPending()
      return
    }
    const eventAbi = parseAbiItem(
      'event GiftCreated(uint256 indexed giftId, address indexed creator, address indexed recipient, uint256 giftAt, uint256 claimDeadline)'
    )
    let foundGiftId: string | null = null
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: [eventAbi], ...log })
        if (decoded.eventName === 'GiftCreated') {
          foundGiftId = String((decoded.args as { giftId: bigint }).giftId)
          break
        }
      } catch { /* not this log */ }
    }
    if (foundGiftId) {
      setTxState('confirmed')
      setConfirmedGiftId(foundGiftId)
      setConfirmedTxHash(receipt.transactionHash)
      clearPending()
      setStep('success')
    } else {
      setTxState('failed')
      setTxError('Transaction confirmed but gift ID could not be parsed. Check the explorer.')
      clearPending()
    }
  }, [receipt]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-save metadata after on-chain confirmation ────────────────────────

  useEffect(() => {
    if (step !== 'success' || !confirmedGiftId || !confirmedTxHash || !account || !registry) return
    if (metaSaveState !== 'idle') return  // already running/done/failed

    const metaPayload = metaFieldsToPayload(metaFields)
    const payload: SaveGiftPayload = {
      registry,
      giftId: confirmedGiftId,
      txHash: confirmedTxHash,
      title: metaPayload.title,
      description: metaPayload.description,
      targetAmountRaw: metaPayload.targetAmountRaw,
    }
    setMetaSavePayload(payload)
    setMetaSaveError(null)

    void metaSaveGift({
      wallet: account,
      registry: registry,
      payload,
      onStateChange: setMetaSaveState,
      signTypedData: async (data) => {
        return signTypedDataAsync({
          domain:      data.domain,
          types:       { MetadataAction: data.types.MetadataAction },
          primaryType: 'MetadataAction',
          message: {
            ...data.message,
            expiresAt: data.message.expiresAt,
          },
        })
      },
    }).then((result) => {
      if (result.ok) {
        setSavedMeta(result.gift ?? null)
        // Clear draft on successful save
        const key = giftDraftKey(registry, account)
        if (key) clearDraft(key)
      } else {
        setMetaSaveError(result.error)
        setMetaSaveState('idle')
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, confirmedGiftId, confirmedTxHash])

  // ── Simulate createGift when entering review step ─────────────────────────

  useEffect(() => {
    if (step !== 'review' || !account || !registry || !parsedRecipient || !giftAtUnix || !writesEnabled) return

    let cancelled = false
    setIsSimulating(true)
    setSimError(null)
    setGasEstimate(null)

    const createParams = {
      address: registry,
      abi: CHEERS_ABI,
      functionName: 'createGift' as const,
      args: [parsedRecipient, giftAtUnix, claimDuration] as const,
      chainId: CHAIN_ID,
    }
    simulateAndEstimate(createParams, account)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setGasEstimate(res.gasEstimateUsdc)
        else setSimError(res.error)
        setIsSimulating(false)
      }).catch(() => { if (!cancelled) setIsSimulating(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account, registry, parsedRecipient, giftAtUnix, claimDuration, writesEnabled])

  // ── Validation ────────────────────────────────────────────────────────────

  function validateForm(): boolean {
    let valid = true

    // Validate metadata first
    if (!validateMetadata(metaFields, setMetaErrors)) valid = false

    if (!recipient.trim()) {
      setRecipientError('Enter the recipient wallet address.')
      valid = false
    } else if (!isAddress(recipient.trim())) {
      setRecipientError('Not a valid EVM address.')
      valid = false
    } else if (account && getAddress(recipient.trim()) === getAddress(account)) {
      setRecipientError('Recipient cannot be your own address.')
      valid = false
    } else {
      setRecipientError(null)
    }

    if (!dateValue) {
      setDateError('Choose a gift date.')
      valid = false
    } else if (!giftAtUnix) {
      setDateError('Gift date must be in the future.')
      valid = false
    } else {
      setDateError(null)
    }

    return valid
  }

  function handleNext() {
    if (validateForm()) setStep('review')
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (!account || !registry || !parsedRecipient || !giftAtUnix || !writesEnabled) return
    setTxState('awaiting-wallet')
    setTxError(null)
    try {
      const hash = await writeContractAsync({
        address: registry,
        abi: CHEERS_ABI,
        functionName: 'createGift',
        args: [parsedRecipient, giftAtUnix, claimDuration],
        chainId: CHAIN_ID,
      })
      setPendingHash(hash)
      setTxState('pending')
    } catch (err) {
      setTxState(
        String(err).includes('rejected') || String(err).includes('cancel') ? 'rejected' : 'failed'
      )
      setTxError(decodeContractError(err))
    }
  }, [account, registry, parsedRecipient, giftAtUnix, claimDuration, writesEnabled, writeContractAsync, setPendingHash])

  // ── Share URL ─────────────────────────────────────────────────────────────

  const shareUrl = confirmedGiftId
    ? `${window.location.origin}${window.location.pathname}#/gift/${confirmedGiftId}`
    : null

  async function copyUrl() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 2000)
    } catch { /* fallback: do nothing */ }
  }

  const wrongNetwork = isConnected && chainId !== CHAIN_ID

  // ── Page shell ────────────────────────────────────────────────────────────

  const pageShell = (children: React.ReactNode) => (
    <div className="relative min-h-dvh overflow-x-hidden">
      <div className="fixed inset-0 pointer-events-none" aria-hidden>
        <div style={{
          position: 'absolute', top: '10%', right: '5%', width: 400, height: 400,
          borderRadius: '50%', filter: 'blur(80px)',
          background: 'radial-gradient(circle, rgba(217,119,6,0.05) 0%, transparent 65%)',
        }} />
      </div>
      <div className="relative z-10 mx-auto max-w-lg px-5 sm:px-8 pt-8 pb-16">
        {children}
      </div>
    </div>
  )

  if (!isRegistryConfigured()) return pageShell(
    <><BackButton onBack={onBack} /><div className="mt-6"><ContractPendingNotice /></div></>
  )

  // ── Success screen ────────────────────────────────────────────────────────

  if (step === 'success' && confirmedGiftId && shareUrl) {
    const metaBusy = metaSaveState === 'challenging' || metaSaveState === 'signing' || metaSaveState === 'saving'
    const metaDone = metaSaveState === 'done' || !!savedMeta
    const showRecovery = !metaBusy && !metaDone && metaSaveState !== 'idle' && !!metaSaveError && !!metaSavePayload

    return pageShell(
      <motion.div className="mt-6 space-y-4" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="glass-card rounded-2xl px-5 py-8 text-center">
          <CheckCircle2 size={40} strokeWidth={1.5} className="mx-auto mb-4" style={{ color: 'var(--success)' }} />
          <h1 className="display font-bold text-xl mb-2" style={{ color: 'var(--ink)' }}>
            Gift created!
          </h1>
          {savedMeta?.title && (
            <p className="text-base font-semibold mb-1" style={{ color: 'var(--accent)' }}>
              {savedMeta.title}
            </p>
          )}
          <p className="text-sm mb-1" style={{ color: 'var(--muted)' }}>
            Gift <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>#{confirmedGiftId}</span>
          </p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Share the link below so friends can contribute.
          </p>
        </div>

        {/* Metadata save status */}
        {metaBusy && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
            style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.15)' }}
          >
            <div className="w-3 h-3 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            <span style={{ color: 'var(--muted)' }}>{metaStateText(metaSaveState)}</span>
          </div>
        )}

        {metaDone && !showRecovery && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-3 text-xs"
            style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.18)' }}
          >
            <CheckCircle2 size={12} strokeWidth={2} style={{ color: 'var(--success)' }} />
            <span style={{ color: 'var(--muted)' }}>Title and details saved.</span>
          </div>
        )}

        {/* Recovery panel when metadata save failed */}
        {showRecovery && account && metaSavePayload && (
          <GiftMetaRecovery
            wallet={account}
            payload={metaSavePayload}
            onSaved={(meta) => { setSavedMeta(meta); setMetaSaveState('done') }}
          />
        )}

        {/* Share link */}
        <div className="glass-card rounded-2xl px-5 py-5 space-y-3">
          <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
            Share link
          </p>
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            <p className="mono text-xs flex-1 min-w-0 truncate" style={{ color: 'var(--ink-2)' }}>
              {shareUrl}
            </p>
            <button
              onClick={() => void copyUrl()}
              className="flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: copiedUrl ? 'rgba(34,197,94,0.12)' : 'var(--surface-raised)',
                color: copiedUrl ? 'var(--success)' : 'var(--ink-2)',
                border: `1px solid ${copiedUrl ? 'rgba(34,197,94,0.25)' : 'var(--border-strong)'}`,
              }}
            >
              <Copy size={12} strokeWidth={2} />
              {copiedUrl ? 'Copied' : 'Copy'}
            </button>
          </div>

          {confirmedTxHash && (
            <a
              href={buildTxExplorerUrl(CHAIN_ID, confirmedTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
              style={{ color: 'var(--subtle)', textDecoration: 'none' }}
            >
              <ExternalLink size={11} strokeWidth={2} />
              View on Arc explorer
            </a>
          )}
        </div>

        <button
          className="w-full rounded-xl py-3.5 text-sm font-semibold"
          style={{ background: 'var(--accent)', color: '#0d0e12', border: 'none', cursor: 'pointer', minHeight: 48 }}
          onClick={() => onGiftCreated(confirmedGiftId)}
        >
          View gift
          <ArrowRight size={14} strokeWidth={2.5} style={{ display: 'inline-block', marginLeft: 8 }} />
        </button>
      </motion.div>
    )
  }

  // ── Review screen ─────────────────────────────────────────────────────────

  if (step === 'review') {
    return pageShell(
      <motion.div className="mt-6 space-y-3" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <BackButton onBack={() => setStep('form')} label="Edit gift" />

        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.025)' }}>
            <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Review
            </p>
          </div>
          <div className="px-5 divide-y">
            {metaFields.title.trim() && (
              <ReviewRow label="Title">
                <span className="text-sm" style={{ color: 'var(--ink-2)' }}>{metaFields.title.trim()}</span>
              </ReviewRow>
            )}
            <ReviewRow label="Recipient">
              <span className="mono text-sm" style={{ color: 'var(--ink-2)' }}>
                {parsedRecipient ? fmtAddress(parsedRecipient) : '—'}
              </span>
            </ReviewRow>
            <ReviewRow label="Gift date">
              {giftAtUnix ? fmtDate(giftAtUnix) : '—'}
            </ReviewRow>
            <ReviewRow label="Claim window">
              {CLAIM_DURATIONS[durationIdx].label}
            </ReviewRow>
            <ReviewRow label="Claim deadline">
              {claimDeadlineUnix ? fmtDate(claimDeadlineUnix) : '—'}
            </ReviewRow>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 text-xs"
          style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.15)', color: 'var(--muted)' }}
        >
          Recipient and deadlines are written to the blockchain and cannot be changed.
          After creation, you will sign once to save the title and details — no extra transaction.
        </div>

        {wrongNetwork && <WrongNetwork inline />}

        {!wrongNetwork && isConnected && !writesEnabled && (
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }}>
            {bytecodeStatus === 'checking' ? 'Verifying contract…' :
             bytecodeStatus === 'empty'    ? 'No contract found at the configured address.' :
             bytecodeStatus === 'error'    ? 'Could not verify contract. Check your connection.' : ''}
          </p>
        )}

        {simError && (
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }} role="alert">
            {simError}
          </p>
        )}

        {gasEstimate && txState === 'idle' && !simError && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Estimated gas: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{gasEstimate}</span>
            <span style={{ color: 'var(--subtle)' }}> (estimate only)</span>
          </p>
        )}

        <TxButton
          label="Create gift"
          awaitingLabel="Confirm in wallet…"
          state={txState}
          txHash={pendingHash}
          errorMessage={txError}
          disabled={!isConnected || wrongNetwork || !writesEnabled || isSimulating || !!simError}
          onClick={() => void handleCreate()}
          variant="primary"
        />

        {!isConnected && (
          <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
            Connect your wallet to create a gift.
          </p>
        )}
        {isConnected && isSimulating && txState === 'idle' && (
          <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
            Estimating fee…
          </p>
        )}
      </motion.div>
    )
  }

  // ── Form screen ───────────────────────────────────────────────────────────

  return pageShell(
    <motion.div className="mt-6 space-y-4" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center gap-3 mb-2">
        <BackButton onBack={onBack} />
      </div>

      <div className="flex items-center gap-3">
        <div className="rounded-xl p-2.5" style={{ background: 'rgba(217,119,6,0.1)' }}>
          <Gift size={18} strokeWidth={2} style={{ color: 'var(--accent)' }} />
        </div>
        <h1 className="display font-bold text-xl" style={{ color: 'var(--ink)' }}>
          Create a gift
        </h1>
      </div>

      {/* Metadata fields */}
      <FormCard>
        <MetadataForm
          fields={metaFields}
          errors={metaErrors}
          onChange={setMetaFields}
          onErrorChange={setMetaErrors}
        />
      </FormCard>

      {/* Recipient */}
      <FormCard>
        <div>
          <FieldLabel>Recipient wallet address</FieldLabel>
          <input
            type="text"
            value={recipient}
            onChange={(e) => { setRecipient(e.target.value); setRecipientError(null) }}
            placeholder="0x…"
            className="w-full rounded-xl px-4 py-3 mono text-sm outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: `1px solid ${recipientError ? 'var(--danger)' : 'var(--border-strong)'}`,
              color: 'var(--ink)',
              caretColor: 'var(--accent)',
            }}
            onFocus={(e) => { if (!recipientError) e.currentTarget.style.borderColor = 'var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = recipientError ? 'var(--danger)' : 'var(--border-strong)' }}
          />
          <FieldError msg={recipientError} />
          <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
            The recipient must claim from this exact address.
          </p>
        </div>
      </FormCard>

      {/* Gift date and claim window */}
      <FormCard>
        <div>
          <FieldLabel>
            <span className="flex items-center gap-2">
              <Calendar size={14} strokeWidth={2} style={{ color: 'var(--accent)' }} />
              Gift date &amp; time
            </span>
          </FieldLabel>
          <input
            type="datetime-local"
            value={dateValue}
            min={minDateTimeLocal()}
            onChange={(e) => { setDateValue(e.target.value); setDateError(null) }}
            className="w-full rounded-xl px-4 py-3 text-sm outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: `1px solid ${dateError ? 'var(--danger)' : 'var(--border-strong)'}`,
              color: 'var(--ink)',
              colorScheme: 'dark',
            }}
          />
          <FieldError msg={dateError} />
          <div className="flex items-center gap-1.5 mt-1.5">
            <Clock size={11} strokeWidth={2} style={{ color: 'var(--subtle)' }} />
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>{localTzLabel()}</p>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            Contributions close when this date arrives.
          </p>
        </div>

        <div>
          <FieldLabel>Claim window</FieldLabel>
          <div className="flex gap-2">
            {CLAIM_DURATIONS.map((d, i) => (
              <button
                key={d.label}
                onClick={() => setDurationIdx(i)}
                className="flex-1 rounded-xl py-2.5 text-sm font-semibold transition-colors"
                style={{
                  background: durationIdx === i ? 'rgba(217,119,6,0.15)' : 'var(--surface-muted)',
                  border: `1px solid ${durationIdx === i ? 'rgba(217,119,6,0.4)' : 'var(--border)'}`,
                  color: durationIdx === i ? 'var(--accent)' : 'var(--ink-2)',
                  cursor: 'pointer',
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            How long the recipient has to claim after the gift date.
            {claimDeadlineUnix !== null && giftAtUnix !== null && (
              <> If unclaimed by{' '}
                <span className="font-medium" style={{ color: 'var(--ink-2)' }}>{fmtDate(claimDeadlineUnix)}</span>,
                contributors can withdraw their contributions.
              </>
            )}
          </p>
        </div>
      </FormCard>

      <button
        onClick={handleNext}
        className="w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold"
        style={{ background: 'var(--accent)', color: '#0d0e12', border: 'none', cursor: 'pointer', minHeight: 48 }}
      >
        Review &amp; create
        <ArrowRight size={15} strokeWidth={2.5} />
      </button>
    </motion.div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BackButton({ onBack, label = 'Back' }: { onBack: () => void; label?: string }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-2 text-sm font-medium transition-opacity hover:opacity-70"
      style={{ color: 'var(--muted)', minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
    >
      <ArrowLeft size={14} strokeWidth={2.5} />
      {label}
    </button>
  )
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-3 gap-4">
      <span className="text-sm shrink-0" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="text-sm font-semibold text-right" style={{ color: 'var(--ink)' }}>
        {children}
      </span>
    </div>
  )
}


