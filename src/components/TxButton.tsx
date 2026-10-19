/**
 * TxButton — reusable button covering the full transaction lifecycle.
 *
 * States: idle → awaiting-wallet → pending → confirmed | rejected | failed
 *
 * Shows an Arc mainnet explorer link on confirmation.
 * Prevents duplicate submissions via the `submitting` prop.
 */

import { ExternalLink, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { buildTxExplorerUrl } from '../onchain-facts'
import { CHAIN_ID } from '../lib/cheers-contract'

export type TxState =
  | 'idle'
  | 'awaiting-wallet'   // wallet prompt open, not yet signed
  | 'pending'           // signed; waiting for receipt
  | 'confirmed'
  | 'rejected'          // user rejected in wallet
  | 'failed'            // on-chain revert or RPC error

interface TxButtonProps {
  label: string
  /** Label shown while awaiting wallet prompt. Defaults to "Confirm in wallet…" */
  awaitingLabel?: string
  state: TxState
  txHash?: `0x${string}` | null
  errorMessage?: string | null
  disabled?: boolean
  onClick: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  fullWidth?: boolean
}

const VARIANT_STYLES: Record<string, React.CSSProperties> = {
  primary: {
    background: 'var(--accent)',
    color: '#0d0e12',
    border: 'none',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--ink-2)',
    border: '1px solid var(--border-strong)',
  },
  danger: {
    background: 'rgba(248,113,113,0.12)',
    color: 'var(--danger)',
    border: '1px solid rgba(248,113,113,0.25)',
  },
}

export function TxButton({
  label,
  awaitingLabel = 'Confirm in wallet…',
  state,
  txHash,
  errorMessage,
  disabled = false,
  onClick,
  variant = 'primary',
  fullWidth = true,
}: TxButtonProps) {
  const isActive = state === 'awaiting-wallet' || state === 'pending'
  const isConfirmed = state === 'confirmed'
  const isFailed = state === 'rejected' || state === 'failed'

  const effectiveDisabled = disabled || isActive || isConfirmed

  const explorerUrl = txHash ? buildTxExplorerUrl(CHAIN_ID, txHash) : null

  const buttonLabel = (() => {
    switch (state) {
      case 'awaiting-wallet': return awaitingLabel
      case 'pending':         return 'Transaction pending…'
      case 'confirmed':       return 'Confirmed'
      case 'rejected':        return 'Cancelled — try again'
      case 'failed':          return 'Failed — try again'
      default:                return label
    }
  })()

  const baseStyle: React.CSSProperties = {
    ...(isConfirmed
      ? { background: 'rgba(34,197,94,0.12)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.25)' }
      : isFailed
        ? { background: 'rgba(248,113,113,0.08)', color: 'var(--danger)', border: '1px solid rgba(248,113,113,0.2)' }
        : VARIANT_STYLES[variant]),
    cursor: effectiveDisabled ? 'not-allowed' : 'pointer',
    opacity: effectiveDisabled && !isActive && !isConfirmed ? 0.5 : 1,
    minHeight: 48,
    width: fullWidth ? '100%' : undefined,
    borderRadius: 12,
    padding: '0 20px',
    fontSize: 14,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    transition: 'opacity 0.15s, background 0.15s',
  }

  return (
    <div style={{ width: fullWidth ? '100%' : undefined }}>
      <button
        style={baseStyle}
        disabled={effectiveDisabled}
        onClick={onClick}
        aria-busy={isActive}
        aria-live="polite"
      >
        {isActive && <Loader2 size={15} strokeWidth={2} className="animate-spin" />}
        {isConfirmed && <CheckCircle2 size={15} strokeWidth={2} />}
        {isFailed && state === 'rejected' && <XCircle size={15} strokeWidth={2} />}
        {buttonLabel}
      </button>

      {/* Explorer link */}
      {explorerUrl && (state === 'pending' || state === 'confirmed') && (
        <div className="mt-2 text-center">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
            style={{ color: 'var(--subtle)', textDecoration: 'none' }}
          >
            View on explorer
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        </div>
      )}

      {/* Error message */}
      {isFailed && errorMessage && (
        <p
          className="mt-2 text-xs text-center"
          style={{ color: 'var(--danger)' }}
          role="alert"
        >
          {errorMessage}
        </p>
      )}
    </div>
  )
}
