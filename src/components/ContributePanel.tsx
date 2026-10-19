/**
 * ContributePanel — approve + contribute two-step flow.
 *
 * Steps:
 *   1. User enters USDC amount + optional greeting (display name + message).
 *   2. Read existing allowance.
 *   3. If allowance < amount: simulate approval, show gas estimate, request exact-amount approval.
 *      Wait for receipt. Approval success ≠ contribution success.
 *   4. Simulate contribute call; show gas estimate.
 *   5. User explicitly confirms contribution; wait for receipt.
 *   6. Verify ContributionMade event in receipt before showing success.
 *   7. On success: sign and save greeting via API (single EIP-712 signature, no new transaction).
 *   8. If greeting save fails, show recovery notice with retry.
 *
 * Contributions and gas share the same USDC balance on Arc — we show the
 * ERC-20 balance and note that gas is also paid from it.
 *
 * Bytecode gate: the parent passes bytecodeStatus from useContractBytecode.
 * Writes are disabled when status is not 'ok'.
 */

import { useState, useCallback, useEffect } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSignTypedData } from 'wagmi'
import { erc20Abi, parseAbi } from 'viem'
import { TxButton, type TxState } from './TxButton'
import { GreetingForm, validateGreeting, type GreetingFields, type GreetingErrors } from './GreetingForm'
import { ContribGreetingRecovery } from './MetadataRecovery'
import { usePendingTx } from '../hooks/usePendingTx'
import { type BytecodeStatus } from '../hooks/useContractBytecode'
import {
  registryAddress,
  CHAIN_ID,
  USDC_ADDRESS,
  parseContributionAmount,
  decodeContractError,
  simulateAndEstimate,
  verifyContributedEvent,
  fmtUsdc,
  CHEERS_ABI,
} from '../lib/cheers-contract'
import {
  metaSaveContribution,
  saveDraft,
  loadDraft,
  clearDraft,
  draftKey,
  type MetaSaveState,
  type SaveContributionPayload,
  type ContributionMeta,
} from '../lib/cheers-api'

// Minimal ERC-20 allowance ABI
const ERC20_ALLOW_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
])

interface ContributePanelProps {
  giftId: string
  /** bytecodeStatus from useContractBytecode — disables writes when not 'ok'. */
  bytecodeStatus: BytecodeStatus
  /** Called after a confirmed contribution so the parent can refetch. */
  onConfirmed: () => void
}

function metaStateLabel(state: MetaSaveState): string {
  switch (state) {
    case 'challenging': return 'Requesting challenge…'
    case 'signing':     return 'Sign in wallet to save greeting…'
    case 'saving':      return 'Saving greeting…'
    case 'done':        return 'Greeting saved.'
    default:            return ''
  }
}

export function ContributePanel({ giftId, bytecodeStatus, onConfirmed }: ContributePanelProps) {
  const { address: account } = useAccount()
  const registry = registryAddress()
  const giftIdBig = BigInt(giftId)
  const { signTypedDataAsync } = useSignTypedData()

  // ── Amount input ──────────────────────────────────────────────────────────

  const [inputValue, setInputValue] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [parsedAmount, setParsedAmount] = useState<bigint | null>(null)

  function handleAmountChange(val: string) {
    setInputValue(val)
    const result = parseContributionAmount(val)
    if (result.ok) {
      setParsedAmount(result.raw)
      setInputError(null)
    } else {
      setParsedAmount(null)
      if (val.trim()) setInputError(result.error)
      else setInputError(null)
    }
  }

  // ── Greeting fields ────────────────────────────────────────────────────────

  const [greetingFields, setGreetingFields] = useState<GreetingFields>({ displayName: '', message: '' })
  const [greetingErrors, setGreetingErrors] = useState<GreetingErrors>({ displayName: null, message: null })

  // Load draft on mount
  useEffect(() => {
    if (!registry || !account) return
    const key = draftKey({ chainId: CHAIN_ID, registry, account, giftId, action: 'contribution' })
    const draft = loadDraft<GreetingFields>(key)
    if (draft) setGreetingFields(draft)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, account, giftId])

  // Persist draft on change
  useEffect(() => {
    if (!registry || !account) return
    const key = draftKey({ chainId: CHAIN_ID, registry, account, giftId, action: 'contribution' })
    saveDraft(key, greetingFields)
  }, [registry, account, giftId, greetingFields])

  // ── ERC-20 balance ────────────────────────────────────────────────────────

  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account!],
    chainId: CHAIN_ID,
    query: { enabled: !!account, refetchInterval: 15_000 },
  })

  const balanceDisplay = rawBalance !== undefined ? fmtUsdc(rawBalance) : null

  // ── Allowance check ───────────────────────────────────────────────────────

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ALLOW_ABI,
    functionName: 'allowance',
    args: [account!, registry as `0x${string}`],
    chainId: CHAIN_ID,
    query: { enabled: !!account && !!registry, refetchInterval: 10_000 },
  })

  const needsApproval = parsedAmount !== null && (allowance === undefined || allowance < parsedAmount)

  // ── Gas estimate state ────────────────────────────────────────────────────

  const [approveGasEstimate, setApproveGasEstimate] = useState<string | null>(null)
  const [contribGasEstimate, setContribGasEstimate] = useState<string | null>(null)
  const [simulateError, setSimulateError]           = useState<string | null>(null)
  const [isSimulating, setIsSimulating]             = useState(false)

  // ── Step state ────────────────────────────────────────────────────────────

  const [step, setStep] = useState<'amount' | 'review' | 'done'>('amount')

  // ── Simulation effects ────────────────────────────────────────────────────
  //
  // Approval and contribution are simulated separately:
  //
  //   Effect A — runs on review step entry (or when parsedAmount changes).
  //     • When approval is needed: simulate approve() only.
  //       Contribution simulation is SKIPPED here because the allowance does
  //       not yet exist — simulateContract for contribute() would revert with
  //       "transfer amount exceeds allowance", which is a misleading error.
  //     • When no approval is needed (sufficient allowance): simulate
  //       contribute() immediately.
  //
  //   Effect B — runs when approvalConfirmed becomes true.
  //     • Simulates contribute() now that the allowance is in place.
  //     • A fresh allowance read is triggered by the approve-receipt effect;
  //       this effect runs after that, so needsApproval reflects the new state.
  //
  // This guarantees: the contribution Confirm button never shows a simulation
  // error caused by a missing approval.

  // Effect A: approval (and contribute when no approval needed)
  useEffect(() => {
    if (step !== 'review' || !account || !registry || parsedAmount === null) return

    let cancelled = false
    setIsSimulating(true)
    setSimulateError(null)
    setApproveGasEstimate(null)
    setContribGasEstimate(null)

    async function runApproveSimulation() {
      if (!account || !registry || parsedAmount === null) return

      if (needsApproval) {
        // Only simulate approval — skip contribution until allowance is set.
        const approveParams = {
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve' as const,
          args: [registry, parsedAmount] as const,
          chainId: CHAIN_ID,
        }
        const approveResult = await simulateAndEstimate(approveParams, account)
        if (cancelled) return
        if (!approveResult.ok) {
          setSimulateError(`Approval simulation failed: ${approveResult.error}`)
          setIsSimulating(false)
          return
        }
        setApproveGasEstimate(approveResult.gasEstimateUsdc)
        // Contribution simulation will fire in Effect B after approval confirms.
        if (!cancelled) setIsSimulating(false)
        return
      }

      // No approval needed — simulate contribution directly.
      const contribParams = {
        address: registry,
        abi: CHEERS_ABI,
        functionName: 'contribute' as const,
        args: [giftIdBig, parsedAmount] as const,
        chainId: CHAIN_ID,
      }
      const contribResult = await simulateAndEstimate(contribParams, account)
      if (cancelled) return
      if (!contribResult.ok) {
        setSimulateError(`Contribution simulation failed: ${contribResult.error}`)
        setIsSimulating(false)
        return
      }
      setContribGasEstimate(contribResult.gasEstimateUsdc)
      if (!cancelled) setIsSimulating(false)
    }

    void runApproveSimulation()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account, registry, parsedAmount, needsApproval])

  // ── Approve flow ──────────────────────────────────────────────────────────

  const {
    pendingHash: pendingApproveHash,
    setPending: setApproveHash,
    clearPending: clearApprovePending,
  } = usePendingTx(registry, account, giftId, 'approve')

  const [approveState, setApproveState]   = useState<TxState>('idle')
  const [approveError, setApproveError]   = useState<string | null>(null)
  const [approvalConfirmed, setApprovalConfirmed] = useState(false)

  const { writeContractAsync: writeApprove } = useWriteContract()

  const { data: approveReceipt } = useWaitForTransactionReceipt({
    hash: pendingApproveHash ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!pendingApproveHash },
  })

  useEffect(() => {
    if (!approveReceipt) return
    if (approveReceipt.status === 'success') {
      setApproveState('confirmed')
      setApprovalConfirmed(true)
      clearApprovePending()
      void refetchAllowance()
    } else {
      setApproveState('failed')
      setApproveError('Approval was reverted on chain.')
      clearApprovePending()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt])

  useEffect(() => {
    if (pendingApproveHash && approveState === 'idle') setApproveState('pending')
  }, [pendingApproveHash, approveState])

  const handleApprove = useCallback(async () => {
    if (!account || !registry || parsedAmount === null || bytecodeStatus !== 'ok') return
    setApproveState('awaiting-wallet')
    setApproveError(null)
    try {
      const hash = await writeApprove({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [registry, parsedAmount],
        chainId: CHAIN_ID,
      })
      setApproveHash(hash)
      setApproveState('pending')
    } catch (err) {
      setApproveState(
        String(err).includes('rejected') || String(err).includes('cancel') ? 'rejected' : 'failed'
      )
      setApproveError(decodeContractError(err))
    }
  }, [account, registry, parsedAmount, bytecodeStatus, writeApprove, setApproveHash])

  // Effect B: simulate contribute() after approval is confirmed.
  // Runs after the approve-receipt effect sets approvalConfirmed=true and
  // triggers a fresh allowance read, so the contribution call will succeed.
  useEffect(() => {
    if (!approvalConfirmed || !account || !registry || parsedAmount === null) return
    if (step !== 'review') return

    let cancelled = false
    setIsSimulating(true)
    setSimulateError(null)
    setContribGasEstimate(null)

    async function runContribSimulation() {
      if (!account || !registry || parsedAmount === null) return
      const contribParams = {
        address: registry,
        abi: CHEERS_ABI,
        functionName: 'contribute' as const,
        args: [giftIdBig, parsedAmount] as const,
        chainId: CHAIN_ID,
      }
      const contribResult = await simulateAndEstimate(contribParams, account)
      if (cancelled) return
      if (!contribResult.ok) {
        setSimulateError(`Contribution simulation failed: ${contribResult.error}`)
        setIsSimulating(false)
        return
      }
      setContribGasEstimate(contribResult.gasEstimateUsdc)
      if (!cancelled) setIsSimulating(false)
    }

    void runContribSimulation()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalConfirmed, account, registry, parsedAmount, step])

  // ── Contribute flow ───────────────────────────────────────────────────────

  const {
    pendingHash: pendingContribHash,
    setPending: setContribHash,
    clearPending: clearContribPending,
  } = usePendingTx(registry, account, giftId, 'contribute')

  const [contribState, setContribState]   = useState<TxState>('idle')
  const [contribError, setContribError]   = useState<string | null>(null)
  const [confirmedTxHash, setConfirmedTxHash] = useState<`0x${string}` | null>(null)
  const [confirmedLogIndex, setConfirmedLogIndex] = useState<number | null>(null)

  const { writeContractAsync: writeContrib } = useWriteContract()

  const { data: contribReceipt } = useWaitForTransactionReceipt({
    hash: pendingContribHash ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!pendingContribHash },
  })

  useEffect(() => {
    if (!contribReceipt || !account || parsedAmount === null) return
    // verifyContributedEvent checks: emitter == registry, giftId, contributor, amount.
    // It returns the canonical on-chain logIndex from the matched log.
    const verify = verifyContributedEvent(
      contribReceipt,
      giftIdBig,
      account,
      parsedAmount,
      registry ?? undefined,
    )
    if (verify.ok) {
      setContribState('confirmed')
      clearContribPending()
      setConfirmedTxHash(contribReceipt.transactionHash)

      // Use the canonical logIndex from the matched log.
      // If the RPC omitted logIndex (null), we keep confirmedLogIndex as null.
      // The greeting-save effect will only proceed when logIndex is non-null.
      // When null, the recovery panel retains the tx hash so the user can
      // retry metadata without any new payment.
      setConfirmedLogIndex(verify.logIndex)

      setStep('done')
      void refetchBalance()
      onConfirmed()
    } else {
      setContribState('failed')
      setContribError(verify.error)
      clearContribPending()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contribReceipt])

  useEffect(() => {
    if (pendingContribHash && contribState === 'idle') setContribState('pending')
  }, [pendingContribHash, contribState])

  const handleContribute = useCallback(async () => {
    if (!account || !registry || parsedAmount === null || bytecodeStatus !== 'ok') return
    // Validate greeting before sending tx (non-blocking — greeting is optional)
    validateGreeting(greetingFields, setGreetingErrors)
    setContribState('awaiting-wallet')
    setContribError(null)
    try {
      const hash = await writeContrib({
        address: registry,
        abi: CHEERS_ABI,
        functionName: 'contribute',
        args: [giftIdBig, parsedAmount],
        chainId: CHAIN_ID,
      })
      setContribHash(hash)
      setContribState('pending')
    } catch (err) {
      setContribState(
        String(err).includes('rejected') || String(err).includes('cancel') ? 'rejected' : 'failed'
      )
      setContribError(decodeContractError(err))
    }
  }, [account, registry, parsedAmount, giftIdBig, bytecodeStatus, greetingFields, writeContrib, setContribHash])

  // ── Greeting sign-and-save after confirmed contribution ───────────────────

  const [metaSaveState, setMetaSaveState]   = useState<MetaSaveState>('idle')
  const [metaSaveError, setMetaSaveError]   = useState<string | null>(null)
  const [greetingPayload, setGreetingPayload] = useState<SaveContributionPayload | null>(null)
  const [savedGreeting, setSavedGreeting]   = useState<ContributionMeta | null>(null)

  useEffect(() => {
    if (step !== 'done' || !account || !registry || !confirmedTxHash) return
    if (metaSaveState !== 'idle') return

    // Skip saving greeting if both fields are empty
    if (!greetingFields.displayName.trim() && !greetingFields.message.trim()) return

    // If the RPC omitted logIndex, we cannot submit metadata — retain the tx hash
    // for recovery. The recovery panel will let the user retry after logIndex
    // becomes available (e.g. by fetching the receipt again), without any new payment.
    if (confirmedLogIndex === null) {
      const key = draftKey({ chainId: CHAIN_ID, registry, account, giftId, action: 'contribution' })
      saveDraft(key, greetingFields)
      setMetaSaveError('Log index unavailable from RPC. Use the recovery option to save your greeting — no new payment needed.')
      return
    }

    const payload: SaveContributionPayload = {
      registry,
      giftId,
      txHash: confirmedTxHash,
      logIndex: confirmedLogIndex,
      displayName: greetingFields.displayName.trim() || null,
      message: greetingFields.message.trim() || null,
    }
    setGreetingPayload(payload)
    setMetaSaveError(null)

    void metaSaveContribution({
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
        setSavedGreeting(result.contribution ?? null)
        // Clear draft
        const key = draftKey({ chainId: CHAIN_ID, registry: registry, account, giftId, action: 'contribution' })
        clearDraft(key)
      } else {
        setMetaSaveError(result.error)
        setMetaSaveState('idle')
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, confirmedTxHash, confirmedLogIndex])

  // ── Bytecode gate ─────────────────────────────────────────────────────────

  const bytecodeBlocked = bytecodeStatus !== 'ok'
  const bytecodeMessage: string | null =
    bytecodeStatus === 'checking' ? 'Verifying contract…' :
    bytecodeStatus === 'empty'    ? 'No contract found at the configured address. Transactions disabled.' :
    bytecodeStatus === 'error'    ? 'Could not verify contract. Check your connection.' :
    bytecodeStatus === 'idle'     ? 'Registry not configured.' :
    null

  // ── Success state ─────────────────────────────────────────────────────────

  if (step === 'done') {
    const hasGreeting = greetingFields.displayName.trim() || greetingFields.message.trim()
    const greetingBusy = metaSaveState === 'challenging' || metaSaveState === 'signing' || metaSaveState === 'saving'
    const greetingDone = metaSaveState === 'done' || !!savedGreeting
    const showRecovery = !greetingBusy && !greetingDone && !!metaSaveError && !!greetingPayload

    return (
      <div className="space-y-3">
        <div
          className="rounded-xl px-5 py-4 text-center"
          style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          <p className="font-semibold text-sm" style={{ color: 'var(--success)' }}>
            Contribution confirmed!
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            {parsedAmount !== null ? fmtUsdc(parsedAmount) : ''} added to the gift pool.
          </p>
        </div>

        {/* Greeting save status */}
        {hasGreeting && greetingBusy && (
          <div className="flex items-center gap-2 text-xs px-1" style={{ color: 'var(--muted)' }}>
            <div className="w-3 h-3 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            {metaStateLabel(metaSaveState)}
          </div>
        )}

        {hasGreeting && greetingDone && (
          <p className="text-xs px-1" style={{ color: 'var(--success)' }}>Greeting saved.</p>
        )}

        {/* Recovery when greeting save failed */}
        {showRecovery && account && greetingPayload && confirmedLogIndex !== null && (
          <ContribGreetingRecovery
            wallet={account}
            payload={greetingPayload}
            onSaved={(g) => { setSavedGreeting(g); setMetaSaveState('done') }}
          />
        )}

        {/* Edge case: RPC omitted logIndex — show tx hash for manual recovery */}
        {showRecovery && confirmedLogIndex === null && confirmedTxHash && (
          <div
            className="rounded-xl px-4 py-3 space-y-1"
            style={{ background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)' }}
          >
            <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>Greeting not saved</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              The RPC response did not include a log index. Your contribution is confirmed on-chain.
              No new payment is needed — please try again later or contact support with your transaction hash.
            </p>
            <p className="text-xs font-mono break-all" style={{ color: 'var(--subtle)', userSelect: 'all' }}>
              {confirmedTxHash}
            </p>
          </div>
        )}
      </div>
    )
  }

  // ── Amount step ───────────────────────────────────────────────────────────

  if (step === 'amount') {
    const isValid = parsedAmount !== null && !inputError
    return (
      <div className="space-y-3">
        {bytecodeBlocked && bytecodeMessage && (
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }}>
            {bytecodeMessage}
          </p>
        )}

        {balanceDisplay !== null && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Available: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{balanceDisplay} USDC</span>
            <span style={{ color: 'var(--subtle)' }}> · Gas also paid in USDC</span>
          </p>
        )}

        <div className="relative">
          <span
            className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold pointer-events-none select-none"
            style={{ color: 'var(--ink-2)' }}
          >
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={inputValue}
            onChange={(e) => handleAmountChange(e.target.value)}
            placeholder="0.00"
            disabled={bytecodeBlocked}
            className="w-full rounded-xl pl-8 pr-4 py-3 text-sm font-semibold tabular outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: `1px solid ${inputError ? 'var(--danger)' : 'var(--border-strong)'}`,
              color: 'var(--ink)',
              caretColor: 'var(--accent)',
              opacity: bytecodeBlocked ? 0.5 : 1,
            }}
            onFocus={(e) => { if (!inputError && !bytecodeBlocked) e.currentTarget.style.borderColor = 'var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = inputError ? 'var(--danger)' : 'var(--border-strong)' }}
          />
        </div>

        {inputError && (
          <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">{inputError}</p>
        )}

        {/* Greeting form (in amount step so it persists draft before sending tx) */}
        <div
          className="rounded-xl px-4 py-4 space-y-3"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Greeting (optional)
          </p>
          <GreetingForm
            fields={greetingFields}
            errors={greetingErrors}
            onChange={setGreetingFields}
            onErrorChange={setGreetingErrors}
          />
        </div>

        <TxButton
          label="Review contribution"
          state="idle"
          disabled={!isValid || !account || bytecodeBlocked}
          onClick={() => {
            if (validateGreeting(greetingFields, setGreetingErrors)) {
              setStep('review')
            }
          }}
          variant="primary"
        />
      </div>
    )
  }

  // ── Review step ───────────────────────────────────────────────────────────

  const approvalDone = !needsApproval || approvalConfirmed
  const approveInFlight = approveState === 'awaiting-wallet' || approveState === 'pending'

  return (
    <div className="space-y-3">
      {bytecodeBlocked && bytecodeMessage && (
        <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }}>
          {bytecodeMessage}
        </p>
      )}

      <div
        className="flex items-center justify-between rounded-xl px-4 py-3"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        <span className="text-sm" style={{ color: 'var(--muted)' }}>Contributing</span>
        <span className="tabular font-bold text-sm" style={{ color: 'var(--accent)' }}>
          {parsedAmount !== null ? fmtUsdc(parsedAmount) : ''}
        </span>
      </div>

      {simulateError && (
        <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: 'var(--danger)' }} role="alert">
          {simulateError}
        </p>
      )}

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Gas is paid in USDC from the same balance.
        {isSimulating && ' Estimating fees…'}
      </p>

      {/* Greeting preview */}
      {(greetingFields.displayName.trim() || greetingFields.message.trim()) && (
        <div
          className="rounded-xl px-4 py-3 space-y-1"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Your greeting
          </p>
          {greetingFields.displayName.trim() && (
            <p className="text-xs font-medium" style={{ color: 'var(--ink-2)' }}>{greetingFields.displayName.trim()}</p>
          )}
          {greetingFields.message.trim() && (
            <p className="text-xs" style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {greetingFields.message.trim()}
            </p>
          )}
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            Saved after contribution confirms — no extra transaction.
          </p>
        </div>
      )}

      {/* Step 1: approval */}
      {needsApproval && (
        <div>
          <p
            className="text-xs font-semibold mb-1"
            style={{ color: approvalDone ? 'var(--success)' : 'var(--subtle)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
          >
            Step 1 — Approve USDC
          </p>
          {approveGasEstimate && !approvalDone && (
            <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
              Estimated fee: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{approveGasEstimate}</span>
              <span style={{ color: 'var(--subtle)' }}> (estimate only)</span>
            </p>
          )}
          <TxButton
            label="Approve USDC spend"
            awaitingLabel="Approve in wallet…"
            state={approveState}
            txHash={pendingApproveHash}
            errorMessage={approveError}
            disabled={approvalDone || approveInFlight || bytecodeBlocked || isSimulating || !!simulateError}
            onClick={() => void handleApprove()}
            variant="ghost"
          />
        </div>
      )}

      {/* Step 2: contribute */}
      <div>
        {needsApproval && (
          <p
            className="text-xs font-semibold mb-1"
            style={{ color: 'var(--subtle)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
          >
            Step 2 — Confirm contribution
          </p>
        )}
        {contribGasEstimate && (
          <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
            Estimated fee: <span className="tabular font-medium" style={{ color: 'var(--ink-2)' }}>{contribGasEstimate}</span>
            <span style={{ color: 'var(--subtle)' }}> (estimate only)</span>
          </p>
        )}
        <TxButton
          label={`Contribute ${parsedAmount !== null ? fmtUsdc(parsedAmount) : ''}`}
          awaitingLabel="Confirm contribution in wallet…"
          state={contribState}
          txHash={pendingContribHash}
          errorMessage={contribError}
          disabled={
            (needsApproval && !approvalDone) ||
            bytecodeBlocked ||
            isSimulating ||
            !!simulateError
          }
          onClick={() => void handleContribute()}
          variant="primary"
        />
      </div>

      {contribState === 'idle' && approveState === 'idle' && (
        <button
          className="w-full text-xs text-center py-2"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--subtle)' }}
          onClick={() => {
            setStep('amount')
            setApproveState('idle')
            setContribState('idle')
            setApprovalConfirmed(false)
            setSimulateError(null)
            setApproveGasEstimate(null)
            setContribGasEstimate(null)
          }}
        >
          ← Change amount
        </button>
      )}
    </div>
  )
}
