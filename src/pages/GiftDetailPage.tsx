/**
 * GiftDetailPage — read + write view for a single gift.
 * Route: /#/gift/:giftId
 *
 * Reads:  getGift, getRemainingBalance, contributions, refunded
 * Writes: contribute (via ContributePanel), claim, refund
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { motion } from 'framer-motion'
import { ArrowLeft, ExternalLink, User, Plus, MessageSquare, Target } from 'lucide-react'
import {
  registryAddress,
  isRegistryConfigured,
  CHAIN_ID,
  GiftPhase,
  derivePhase,
  remainingBalance,
  fmtUsdc,
  fmtDate,
  fmtCountdown,
  fmtAddress,
  decodeContractError,
  simulateAndEstimate,
  verifyClaimedEvent,
  verifyRefundedEvent,
  CHEERS_ABI,
} from '../lib/cheers-contract'
import { PhaseBadge } from '../components/PhaseBadge'
import { ContractPendingNotice } from '../components/ContractPendingNotice'
import { ContributePanel } from '../components/ContributePanel'
import { TxButton, type TxState } from '../components/TxButton'
import { usePendingTx } from '../hooks/usePendingTx'
import { useLiveTime } from '../hooks/useLiveTime'
import { useContractBytecode } from '../hooks/useContractBytecode'
import { useGiftMetadata } from '../hooks/useGiftMetadata'
import { buildAddressExplorerUrl } from '../onchain-facts'
import { isApiConfigured } from '../lib/cheers-api'
import { GiftMetadataRecoveryPanel } from '../components/GiftMetadataRecoveryPanel'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GiftDetailPageProps {
  giftId: string
  onBack: () => void
}

// ── Stat row ──────────────────────────────────────────────────────────────────

function StatRow({ label, value, mono = false, accent = false }: {
  label: string; value: string; mono?: boolean; accent?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <span className="text-sm min-w-0 shrink-0" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span
        className={`text-sm font-semibold min-w-0 text-right break-all ${mono ? 'mono' : 'tabular'}`}
        style={{ color: accent ? 'var(--accent)' : 'var(--ink)' }}
      >
        {value}
      </span>
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div
        className="px-5 py-3 text-xs font-semibold"
        style={{
          color: 'var(--subtle)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.025)',
        }}
      >
        {label}
      </div>
      <div className="px-5 divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
        {children}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function GiftDetailPage({ giftId, onBack }: GiftDetailPageProps) {
  const { address: walletAddress, isConnected, chainId: connectedChain } = useAccount()
  const contractAddr = registryAddress()
  const giftIdBig = BigInt(giftId)

  // ── Bytecode validation ────────────────────────────────────────────────────
  // Must be 'ok' before any write is enabled

  const bytecodeStatus = useContractBytecode(contractAddr)
  const writesEnabled = bytecodeStatus === 'ok'

  // ── Backend metadata ───────────────────────────────────────────────────────
  // Missing metadata (404) does not mean the on-chain gift is nonexistent.
  // Auto-retry once on arrival when metadata is absent for a recently created gift
  // (within 60 seconds) — covers the race between metadata save and page navigation.

  const { meta, contributions: contribMeta, state: metaState, metaMissing, reload: reloadMeta } =
    useGiftMetadata(contractAddr, giftId)

  // Auto-reload once when metadata is missing for a fresh gift
  useEffect(() => {
    if (!metaMissing || meta) return
    // Reload after 4 seconds — gives the metadata save time to propagate
    const timer = setTimeout(() => void reloadMeta(), 4000)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaMissing, meta])

  // ── Live clock (1s tick, updates countdowns and phase boundary crossing) ──

  const [refetchTick, setRefetchTick] = useState(0)
  const triggerRefetch = useCallback(() => setRefetchTick(t => t + 1), [])

  // ── Core gift data ─────────────────────────────────────────────────────────

  const { data: giftData, isLoading: giftLoading, isError: giftError, error: giftRawError, refetch: refetchGift } =
    useReadContract({
      address: contractAddr ?? undefined,
      abi: CHEERS_ABI,
      functionName: 'getGift',
      args: [giftIdBig],
      chainId: CHAIN_ID,
      query: { enabled: isRegistryConfigured(), refetchInterval: 30_000 },
    })

  const { data: remainingRaw, isLoading: remainingLoading, refetch: refetchRemaining } =
    useReadContract({
      address: contractAddr ?? undefined,
      abi: CHEERS_ABI,
      functionName: 'getRemainingBalance',
      args: [giftIdBig],
      chainId: CHAIN_ID,
      query: { enabled: isRegistryConfigured(), refetchInterval: 30_000 },
    })

  // Boundaries at which we should refetch contract state
  const phaseBoundaries = useMemo(() =>
    giftData ? [giftData.giftAt, giftData.claimDeadline] : undefined,
  [giftData])

  const nowSec = useLiveTime(1_000, phaseBoundaries, triggerRefetch)

  // Refetch when a boundary is crossed
  useEffect(() => {
    if (refetchTick > 0) {
      void refetchGift()
      void refetchRemaining()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetchTick])

  // ── Per-wallet data ────────────────────────────────────────────────────────

  const walletContracts = useMemo(() => {
    if (!isConnected || !walletAddress || !contractAddr) return []
    return [
      {
        address: contractAddr, abi: CHEERS_ABI,
        functionName: 'contributions' as const,
        args: [giftIdBig, walletAddress] as const, chainId: CHAIN_ID,
      },
      {
        address: contractAddr, abi: CHEERS_ABI,
        functionName: 'refunded' as const,
        args: [giftIdBig, walletAddress] as const, chainId: CHAIN_ID,
      },
    ]
  }, [isConnected, walletAddress, contractAddr, giftIdBig])

  const { data: walletData, isLoading: walletLoading, refetch: refetchWallet } = useReadContracts({
    contracts: walletContracts,
    query: { enabled: walletContracts.length > 0, refetchInterval: 30_000 },
  })

  const myContribution = walletData?.[0]?.result as bigint | undefined
  const myRefunded = walletData?.[1]?.result as boolean | undefined

  // Refetch wallet data on account change
  useEffect(() => { void refetchWallet() }, [walletAddress, connectedChain, refetchWallet])

  // ── Derived state ──────────────────────────────────────────────────────────

  const phase = useMemo(() => giftData ? derivePhase(giftData, nowSec) : null, [giftData, nowSec])

  const remaining = useMemo(() => {
    if (remainingRaw !== undefined) return remainingRaw
    if (giftData) return remainingBalance(giftData)
    return null
  }, [remainingRaw, giftData])

  const canContribute = useMemo(() =>
    !!(giftData && phase === GiftPhase.OPEN),
  [giftData, phase])

  // Recipient is in the claim window but there may be no funds yet.
  const isRecipientInClaimWindow = useMemo(() =>
    !!(giftData && walletAddress &&
      phase === GiftPhase.CLAIMABLE &&
      giftData.recipient.toLowerCase() === walletAddress.toLowerCase()),
    [giftData, walletAddress, phase])

  // canClaim requires funds. contract claim() reverts with ZeroAmount when
  // totalContributed == 0, so never enable the button for a zero-balance gift.
  const canClaim = useMemo(() =>
    isRecipientInClaimWindow && remaining !== null && remaining > 0n,
    [isRecipientInClaimWindow, remaining])

  const canRefund = useMemo(() =>
    !!(giftData && walletAddress &&
      phase === GiftPhase.REFUNDABLE &&
      (myContribution ?? 0n) > 0n &&
      myRefunded === false),
    [giftData, walletAddress, phase, myContribution, myRefunded])

  // ── Contribute panel toggle ────────────────────────────────────────────────
  const [showContribute, setShowContribute] = useState(false)

  // ── Claim flow ────────────────────────────────────────────────────────────

  const {
    pendingHash: pendingClaimHash,
    setPending: setClaimHash,
    clearPending: clearClaimPending,
  } = usePendingTx(contractAddr, walletAddress, giftId, 'claim')

  const [claimState, setClaimState]           = useState<TxState>('idle')
  const [claimError, setClaimError]           = useState<string | null>(null)
  const [claimGasEstimate, setClaimGasEst]    = useState<string | null>(null)
  const [claimSimError, setClaimSimError]     = useState<string | null>(null)
  const [claimSimulating, setClaimSimulating] = useState(false)
  const { writeContractAsync: writeClaim } = useWriteContract()

  const { data: claimReceipt } = useWaitForTransactionReceipt({
    hash: pendingClaimHash ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!pendingClaimHash },
  })

  // Verify GiftClaimed event before showing success
  useEffect(() => {
    if (!claimReceipt || !walletAddress || !giftData) return
    const verify = verifyClaimedEvent(claimReceipt, giftIdBig, giftData.recipient)
    if (verify.ok) {
      setClaimState('confirmed')
      clearClaimPending()
      void refetchGift(); void refetchRemaining(); void refetchWallet()
    } else {
      setClaimState('failed')
      setClaimError(verify.error)
      clearClaimPending()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimReceipt])

  useEffect(() => {
    if (pendingClaimHash && claimState === 'idle') setClaimState('pending')
  }, [pendingClaimHash, claimState])

  // Simulate claim and estimate gas when canClaim becomes true and writes are enabled
  useEffect(() => {
    if (!canClaim || !walletAddress || !contractAddr || !writesEnabled) return
    let cancelled = false
    setClaimSimulating(true)
    setClaimSimError(null)
    const claimParams = {
      address: contractAddr,
      abi: CHEERS_ABI,
      functionName: 'claim' as const,
      args: [giftIdBig] as const,
      chainId: CHAIN_ID,
    }
    simulateAndEstimate(claimParams, walletAddress)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setClaimGasEst(res.gasEstimateUsdc)
        else setClaimSimError(res.error)
        setClaimSimulating(false)
      }).catch(() => { if (!cancelled) setClaimSimulating(false) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canClaim, walletAddress, contractAddr, writesEnabled])

  const handleClaim = useCallback(async () => {
    if (!walletAddress || !contractAddr || !writesEnabled) return
    setClaimState('awaiting-wallet')
    setClaimError(null)
    try {
      const hash = await writeClaim({
        address: contractAddr,
        abi: CHEERS_ABI,
        functionName: 'claim',
        args: [giftIdBig],
        chainId: CHAIN_ID,
      })
      setClaimHash(hash)
      setClaimState('pending')
    } catch (err) {
      setClaimState(String(err).includes('rejected') ? 'rejected' : 'failed')
      setClaimError(decodeContractError(err))
    }
  }, [walletAddress, contractAddr, giftIdBig, writesEnabled, writeClaim, setClaimHash])

  // ── Refund flow ────────────────────────────────────────────────────────────

  const {
    pendingHash: pendingRefundHash,
    setPending: setRefundHash,
    clearPending: clearRefundPending,
  } = usePendingTx(contractAddr, walletAddress, giftId, 'refund')

  const [refundState, setRefundState]            = useState<TxState>('idle')
  const [refundError, setRefundError]            = useState<string | null>(null)
  const [refundGasEstimate, setRefundGasEst]     = useState<string | null>(null)
  const [refundSimError, setRefundSimError]      = useState<string | null>(null)
  const [refundSimulating, setRefundSimulating]  = useState(false)
  const { writeContractAsync: writeRefund } = useWriteContract()

  const { data: refundReceipt } = useWaitForTransactionReceipt({
    hash: pendingRefundHash ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!pendingRefundHash },
  })

  // Verify ContributorRefunded event before showing success
  useEffect(() => {
    if (!refundReceipt || !walletAddress) return
    const verify = verifyRefundedEvent(refundReceipt, giftIdBig, walletAddress)
    if (verify.ok) {
      setRefundState('confirmed')
      clearRefundPending()
      void refetchGift(); void refetchRemaining(); void refetchWallet()
    } else {
      setRefundState('failed')
      setRefundError(verify.error)
      clearRefundPending()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refundReceipt])

  useEffect(() => {
    if (pendingRefundHash && refundState === 'idle') setRefundState('pending')
  }, [pendingRefundHash, refundState])

  // Simulate refund and estimate gas when canRefund becomes true and writes are enabled
  useEffect(() => {
    if (!canRefund || !walletAddress || !contractAddr || !writesEnabled) return
    let cancelled = false
    setRefundSimulating(true)
    setRefundSimError(null)
    const refundParams = {
      address: contractAddr,
      abi: CHEERS_ABI,
      functionName: 'refund' as const,
      args: [giftIdBig] as const,
      chainId: CHAIN_ID,
    }
    simulateAndEstimate(refundParams, walletAddress)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setRefundGasEst(res.gasEstimateUsdc)
        else setRefundSimError(res.error)
        setRefundSimulating(false)
      }).catch(() => { if (!cancelled) setRefundSimulating(false) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRefund, walletAddress, contractAddr, writesEnabled])

  const handleRefund = useCallback(async () => {
    if (!walletAddress || !contractAddr || !writesEnabled) return
    setRefundState('awaiting-wallet')
    setRefundError(null)
    try {
      const hash = await writeRefund({
        address: contractAddr,
        abi: CHEERS_ABI,
        functionName: 'refund',
        args: [giftIdBig],
        chainId: CHAIN_ID,
      })
      setRefundHash(hash)
      setRefundState('pending')
    } catch (err) {
      setRefundState(String(err).includes('rejected') ? 'rejected' : 'failed')
      setRefundError(decodeContractError(err))
    }
  }, [walletAddress, contractAddr, giftIdBig, writesEnabled, writeRefund, setRefundHash])

  // ── Loading / error states ─────────────────────────────────────────────────

  const pageShell = (children: React.ReactNode) => (
    <div className="relative min-h-dvh overflow-x-hidden">
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{
          position: 'absolute', top: '10%', right: '5%', width: 400, height: 400,
          borderRadius: '50%', filter: 'blur(80px)',
          background: 'radial-gradient(circle, rgba(217,119,6,0.06) 0%, transparent 65%)',
        }} />
      </div>
      <div className="relative z-10 mx-auto max-w-xl px-5 sm:px-8 pt-8 pb-16">
        {children}
      </div>
    </div>
  )

  if (!isRegistryConfigured()) return pageShell(
    <><BackButton onBack={onBack} /><div className="mt-6"><ContractPendingNotice /></div></>
  )

  if (giftLoading || remainingLoading) return pageShell(
    <><BackButton onBack={onBack} /><SkeletonCards /></>
  )

  if (giftError) {
    const msg = giftRawError?.message ?? ''
    const notFound = msg.includes('GiftDoesNotExist') || msg.includes('revert')
    return pageShell(
      <><BackButton onBack={onBack} />
        <ErrorCard
          title={notFound ? 'Gift not found' : 'Unable to load gift'}
          body={notFound
            ? `No gift with ID ${giftId} exists on this contract.`
            : 'There was a problem reading the contract. Check your connection and try again.'}
        /></>
    )
  }

  if (!giftData || giftData.giftAt === 0n) return pageShell(
    <><BackButton onBack={onBack} />
      <ErrorCard title="Gift not found" body={`No gift with ID ${giftId} exists on this contract.`} /></>
  )

  const recipientUrl = buildAddressExplorerUrl(CHAIN_ID, giftData.recipient)
  const isClaimed = phase === GiftPhase.CLOSED
  const isEmpty = giftData.totalContributed === 0n

  return pageShell(
    <>
      <BackButton onBack={onBack} />

      <motion.div
        className="mt-6 space-y-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {/* ── Hero card ────────────────────────────────────────── */}
        <div className="glass-card rounded-2xl overflow-hidden">
          {/* Amber top strip */}
          <div style={{ height: 3, background: 'var(--accent)', opacity: isClaimed ? 0.35 : 1 }} />

          <div className="px-5 py-5">
            {/* Title + phase */}
            <div className="flex items-start justify-between gap-3 mb-5">
              <h1 className="display font-bold text-xl" style={{ color: 'var(--ink)' }}>
                Gift #{giftId}
              </h1>
              {phase !== null && (
                <PhaseBadge
                  phase={phase}
                  totalContributed={giftData?.totalContributed}
                />
              )}
            </div>

            {/* Dominant amount */}
            <div className="mb-5">
              <p
                className="text-xs font-semibold mb-1.5"
                style={{ color: 'var(--muted)', letterSpacing: '0.07em', textTransform: 'uppercase' }}
              >
                {isClaimed ? 'Claimed amount' : isEmpty ? 'No contributions yet' : 'Pooled'}
              </p>
              <p
                className="display tabular font-bold amber-glow"
                style={{
                  fontSize: 'clamp(2rem,7vw,2.75rem)',
                  color: isClaimed ? 'var(--ink-2)' : 'var(--accent)',
                  lineHeight: 1.1,
                }}
              >
                {fmtUsdc(giftData.totalContributed)}
              </p>
              {remaining !== null && !isClaimed && !isEmpty && (
                <p className="text-sm mt-1 tabular" style={{ color: 'var(--muted)' }}>
                  {fmtUsdc(remaining)} unclaimed
                </p>
              )}
            </div>

            {/* Recipient link */}
            <a
              href={recipientUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl px-4 py-3 transition-colors"
              style={{
                background: 'var(--surface-muted)',
                border: '1px solid var(--border)',
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <User size={16} strokeWidth={1.5} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <div className="flex-1 min-w-0">
                <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>Recipient</p>
                <p className="mono text-sm font-medium truncate" style={{ color: 'var(--ink-2)' }}>
                  {fmtAddress(giftData.recipient)}
                </p>
              </div>
              <ExternalLink size={12} strokeWidth={2} style={{ color: 'var(--subtle)', flexShrink: 0 }} />
            </a>
          </div>
        </div>

        {/* ── Metadata: title + description ────────────────────── */}
        {meta?.title && (
          <div className="glass-card rounded-2xl px-5 py-4 space-y-1">
            <h2 className="display font-bold text-lg" style={{ color: 'var(--ink)' }}>
              {meta.title}
            </h2>
            {meta.description && (
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {meta.description}
              </p>
            )}
            {meta.target_amount_raw && (
              <div className="flex items-center gap-1.5 pt-1">
                <Target size={11} strokeWidth={2} style={{ color: 'var(--subtle)' }} />
                <p className="text-xs tabular" style={{ color: 'var(--subtle)' }}>
                  Target: {fmtUsdc(BigInt(meta.target_amount_raw))}
                  <span> · visual only</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Creator recovery: metadata missing but on-chain gift exists */}
        {isApiConfigured() && metaMissing && !meta && metaState === 'loaded' && (
          isConnected && walletAddress
            ? (
              <div
                className="glass-card rounded-2xl overflow-hidden"
              >
                <div
                  className="px-5 py-3 text-xs font-semibold"
                  style={{
                    color: 'var(--subtle)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    borderBottom: '1px solid var(--border)',
                    background: 'rgba(255,255,255,0.025)',
                  }}
                >
                  Save gift details
                </div>
                <div className="px-5 py-4">
                  <GiftMetadataRecoveryPanel
                    giftId={giftId}
                    connectedWallet={walletAddress}
                    onSaved={(_savedMeta) => {
                      void reloadMeta()
                    }}
                  />
                </div>
              </div>
            )
            : (
              <div
                className="rounded-2xl px-5 py-4"
                style={{ background: 'rgba(217,119,6,0.05)', border: '1px dashed rgba(217,119,6,0.25)' }}
              >
                <p className="text-sm font-medium mb-1" style={{ color: 'var(--ink-2)' }}>
                  Title not saved
                </p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  This gift exists on-chain but no title has been saved.
                  Connect the creator wallet to add a title — no new payment needed.
                </p>
              </div>
            )
        )}

        {/* ── Accounting ────────────────────────────────────────── */}
        <SectionCard label="Accounting">
          <StatRow label="Total contributed" value={fmtUsdc(giftData.totalContributed)} accent />
          <StatRow label="Claimed" value={fmtUsdc(giftData.totalClaimed)} />
          <StatRow label="Refunded to contributors" value={fmtUsdc(giftData.totalRefunded)} />
          {remaining !== null && (
            <StatRow label="Remaining liability" value={fmtUsdc(remaining)} />
          )}
        </SectionCard>

        {/* ── Timeline ──────────────────────────────────────────── */}
        <SectionCard label="Timeline">
          <StatRow
            label="Contributions close"
            value={nowSec < giftData.giftAt
              ? `${fmtDate(giftData.giftAt)} · ${fmtCountdown(giftData.giftAt, nowSec)}`
              : fmtDate(giftData.giftAt)}
          />
          <StatRow
            label="Claim deadline"
            value={nowSec < giftData.claimDeadline
              ? `${fmtDate(giftData.claimDeadline)} · ${fmtCountdown(giftData.claimDeadline, nowSec)}`
              : fmtDate(giftData.claimDeadline)}
          />
        </SectionCard>

        {/* ── Greetings from contributors ───────────────────────── */}
        {contribMeta.length > 0 && (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div
              className="px-5 py-3 flex items-center gap-2 text-xs font-semibold"
              style={{
                color: 'var(--subtle)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.025)',
              }}
            >
              <MessageSquare size={12} strokeWidth={2} />
              Greetings · {contribMeta.length}
            </div>
            <div className="divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
              {contribMeta.map((c) => (
                <div key={`${c.tx_hash}-${c.log_index}`} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <p className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
                      {c.display_name
                        ? c.display_name
                        : <span className="mono text-xs" style={{ color: 'var(--subtle)' }}>{fmtAddress(c.contributor_address)}</span>}
                    </p>
                    <span className="tabular text-xs font-medium shrink-0" style={{ color: 'var(--accent)' }}>
                      {fmtUsdc(BigInt(c.amount_raw))}
                    </span>
                  </div>
                  {c.message && (
                    <p
                      className="text-sm leading-relaxed"
                      style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    >
                      {c.message}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Contribute (OPEN phase, any connected wallet) ─────── */}
        {isConnected && canContribute && (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div
              className="px-5 py-3 flex items-center justify-between"
              style={{ borderBottom: showContribute ? '1px solid var(--border)' : 'none', background: 'rgba(255,255,255,0.025)' }}
            >
              <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Contribute
              </p>
              <button
                onClick={() => setShowContribute(v => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: showContribute ? 'rgba(217,119,6,0.12)' : 'var(--surface-raised)',
                  color: showContribute ? 'var(--accent)' : 'var(--ink-2)',
                  border: `1px solid ${showContribute ? 'rgba(217,119,6,0.3)' : 'var(--border-strong)'}`,
                }}
              >
                <Plus size={12} strokeWidth={2.5} />
                {showContribute ? 'Cancel' : 'Add USDC'}
              </button>
            </div>
            {showContribute && (
              <div className="px-5 py-4">
                <ContributePanel
                  giftId={giftId}
                  bytecodeStatus={bytecodeStatus}
                  onConfirmed={() => {
                    setShowContribute(false)
                    void refetchGift(); void refetchRemaining(); void refetchWallet()
                    // Reload metadata to pick up new greeting after save
                    setTimeout(() => reloadMeta(), 3000)
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Wallet position ───────────────────────────────────── */}
        {isConnected && !walletLoading && (myContribution !== undefined) && (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div
              className="px-5 py-3 text-xs font-semibold"
              style={{
                color: 'var(--subtle)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.025)',
              }}
            >
              Your position
            </div>
            <div className="px-5 divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
              <StatRow
                label="Your contribution"
                value={fmtUsdc(myContribution)}
                accent={myContribution > 0n}
              />
              {myRefunded && (
                <StatRow label="Status" value="Withdrawn" />
              )}
            </div>

            {/* Claim window open — balance loading or read failure */}
            {isRecipientInClaimWindow && remaining === null && (
              <div className="px-5 pb-5 pt-3">
                <p
                  className="text-sm px-4 py-3 rounded-xl"
                  style={{
                    background: 'rgba(217,119,6,0.06)',
                    border: '1px solid rgba(217,119,6,0.15)',
                    color: 'var(--muted)',
                    lineHeight: 1.55,
                  }}
                >
                  Checking available balance…
                </p>
              </div>
            )}

            {/* Claim window open — confirmed zero balance */}
            {isRecipientInClaimWindow && remaining === 0n && (
              <div className="px-5 pb-5 pt-3">
                <p
                  className="text-sm px-4 py-3 rounded-xl"
                  style={{
                    background: 'rgba(217,119,6,0.08)',
                    border: '1px solid rgba(217,119,6,0.2)',
                    color: 'var(--accent)',
                    lineHeight: 1.55,
                  }}
                >
                  <span className="font-semibold">Claim window open · No funds.</span>
                  {' '}Contributions have closed. This gift received no contributions,
                  so there are no funds to claim.
                </p>
              </div>
            )}

            {/* Claim */}
            {canClaim && (
              <div className="px-5 pb-5 pt-3 space-y-2">
                {/* Bytecode gate notice */}
                {!writesEnabled && (
                  <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }}>
                    {bytecodeStatus === 'checking' ? 'Verifying contract…' :
                     bytecodeStatus === 'empty'    ? 'No contract found at the configured address.' :
                     bytecodeStatus === 'error'    ? 'Could not verify contract.' : ''}
                  </p>
                )}
                {/* Simulation error */}
                {claimSimError && (
                  <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }} role="alert">
                    {claimSimError}
                  </p>
                )}
                {/* Gas estimate */}
                {claimGasEstimate && claimState === 'idle' && (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Estimated gas: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{claimGasEstimate}</span>
                    <span style={{ color: 'var(--subtle)' }}> (estimate only)</span>
                  </p>
                )}
                <TxButton
                  label="Claim gift"
                  awaitingLabel="Confirm claim in wallet…"
                  state={claimState}
                  txHash={pendingClaimHash}
                  errorMessage={claimError}
                  disabled={claimState === 'confirmed' || !writesEnabled || claimSimulating || !!claimSimError}
                  onClick={() => void handleClaim()}
                  variant="primary"
                />
                {claimState === 'idle' && !claimSimError && (
                  <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
                    {claimSimulating ? 'Estimating fee…' : 'Claim the full pooled amount to your wallet.'}
                  </p>
                )}
              </div>
            )}

            {/* Refund */}
            {canRefund && (
              <div className="px-5 pb-5 pt-3 space-y-2">
                {/* Bytecode gate notice */}
                {!writesEnabled && (
                  <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }}>
                    {bytecodeStatus === 'checking' ? 'Verifying contract…' :
                     bytecodeStatus === 'empty'    ? 'No contract found at the configured address.' :
                     bytecodeStatus === 'error'    ? 'Could not verify contract.' : ''}
                  </p>
                )}
                {/* Simulation error */}
                {refundSimError && (
                  <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }} role="alert">
                    {refundSimError}
                  </p>
                )}
                {/* Gas estimate */}
                {refundGasEstimate && refundState === 'idle' && (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Estimated gas: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{refundGasEstimate}</span>
                    <span style={{ color: 'var(--subtle)' }}> (estimate only)</span>
                  </p>
                )}
                <TxButton
                  label="Withdraw my contribution"
                  awaitingLabel="Confirm withdrawal in wallet…"
                  state={refundState}
                  txHash={pendingRefundHash}
                  errorMessage={refundError}
                  disabled={refundState === 'confirmed' || !writesEnabled || refundSimulating || !!refundSimError}
                  onClick={() => void handleRefund()}
                  variant="ghost"
                />
                {refundState === 'idle' && !refundSimError && (
                  <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
                    {refundSimulating
                      ? 'Estimating fee…'
                      : `The claim window has expired. You can withdraw your ${fmtUsdc(myContribution ?? 0n)} contribution.`}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Connect prompt */}
        {!isConnected && (
          <div
            className="rounded-2xl px-5 py-4 text-sm text-center"
            style={{
              border: '1px dashed var(--border-strong)',
              color: 'var(--muted)',
            }}
          >
            Connect your wallet to see your contribution and eligibility.
          </div>
        )}
      </motion.div>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-2 text-sm font-medium transition-opacity hover:opacity-70"
      style={{ color: 'var(--muted)', minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
    >
      <ArrowLeft size={14} strokeWidth={2.5} />
      All gifts
    </button>
  )
}

function SkeletonCards() {
  return (
    <div className="mt-6 space-y-3">
      {[180, 140, 110].map((h, i) => (
        <div
          key={i}
          className="glass-card rounded-2xl animate-pulse"
          style={{ height: h, opacity: 0.5 }}
        />
      ))}
    </div>
  )
}

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 glass-card rounded-2xl px-6 py-8 text-center">
      <p className="display font-semibold text-lg mb-2" style={{ color: 'var(--ink)' }}>
        {title}
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{body}</p>
    </div>
  )
}
