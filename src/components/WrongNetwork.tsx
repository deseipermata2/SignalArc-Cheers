/**
 * WrongNetwork — banner when connected wallet is on the wrong chain.
 */

import { useAccount, useSwitchChain } from 'wagmi'
import { AlertTriangle } from 'lucide-react'
import { CHAIN_ID } from '../lib/cheers-contract'

interface WrongNetworkProps {
  /** When true, renders as an inline card rather than a full-width banner. */
  inline?: boolean
}

export function WrongNetwork({ inline = false }: WrongNetworkProps) {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  if (!isConnected || chainId === CHAIN_ID) return null

  if (inline) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium"
        style={{
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.2)',
          color: 'var(--danger)',
        }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <AlertTriangle size={13} strokeWidth={2.5} style={{ flexShrink: 0 }} />
          <span className="text-xs truncate">Switch to Arc Mainnet to continue</span>
        </span>
        <button
          onClick={() => switchChain({ chainId: CHAIN_ID })}
          disabled={isPending}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0"
          style={{
            background: 'rgba(248,113,113,0.18)',
            color: 'var(--danger)',
            border: '1px solid rgba(248,113,113,0.28)',
            opacity: isPending ? 0.6 : 1,
          }}
        >
          {isPending ? 'Switching…' : 'Switch'}
        </button>
      </div>
    )
  }

  return (
    <div
      className="w-full flex items-center justify-between gap-3 px-5 sm:px-8 py-2.5 text-sm font-medium"
      style={{
        background: 'rgba(248,113,113,0.08)',
        borderBottom: '1px solid rgba(248,113,113,0.15)',
        color: 'var(--danger)',
      }}
    >
      <span className="flex items-center gap-2 min-w-0">
        <AlertTriangle size={14} strokeWidth={2.5} style={{ flexShrink: 0 }} />
        <span className="truncate">Wrong network — SignalArc Cheers runs on Arc Mainnet</span>
      </span>
      <button
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        disabled={isPending}
        className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity shrink-0"
        style={{
          background: 'rgba(248,113,113,0.18)',
          color: 'var(--danger)',
          border: '1px solid rgba(248,113,113,0.28)',
          opacity: isPending ? 0.6 : 1,
          minHeight: 30,
        }}
      >
        {isPending ? 'Switching…' : 'Switch to Arc'}
      </button>
    </div>
  )
}
