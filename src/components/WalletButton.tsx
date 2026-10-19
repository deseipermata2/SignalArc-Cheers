/**
 * WalletButton — dark-themed ConnectKit wallet connector.
 * Shows connected address + ERC-20 USDC balance.
 * On Arc, native balance and ERC-20 USDC are the same pool — only the
 * ERC-20 view is shown to avoid double-counting.
 */

import { ConnectKitButton } from 'connectkit'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { Wallet } from 'lucide-react'
import { getUsdc } from '../onchain-facts'
import { Amount, usdcDecimalsFor } from '../onchain-money'
import { CHAIN_ID, fmtAddress } from '../lib/cheers-contract'

const usdcFact = getUsdc(CHAIN_ID)!

function ConnectedPill() {
  const { address } = useAccount()

  const { data: rawBalance } = useReadContract({
    address: usdcFact.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

  const formatted = rawBalance !== undefined
    ? Amount.fromRaw(rawBalance, usdcDecimalsFor(CHAIN_ID)).toFixed(2)
    : null

  return (
    <ConnectKitButton.Custom>
      {({ show }) => (
        <button
          onClick={show}
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            color: 'var(--ink)',
            minHeight: 40,
          }}
        >
          <span
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: 'var(--success)',
              flexShrink: 0,
              boxShadow: '0 0 6px rgba(34,197,94,0.6)',
            }}
            aria-hidden
          />
          <span className="mono text-xs" style={{ color: 'var(--ink-2)', letterSpacing: 0 }}>
            {address ? fmtAddress(address) : '—'}
          </span>
          {formatted !== null && (
            <>
              <span style={{ color: 'var(--subtle)', userSelect: 'none', fontSize: 10 }}>|</span>
              <span className="tabular text-xs" style={{ color: 'var(--accent)' }}>
                ${formatted}
              </span>
            </>
          )}
        </button>
      )}
    </ConnectKitButton.Custom>
  )
}

export function WalletButton() {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, isConnecting, show }) => {
        if (isConnected) return <ConnectedPill />

        return (
          <button
            onClick={show}
            disabled={isConnecting}
            className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all"
            style={{
              background: 'var(--accent)',
              color: '#0d0e12',
              minHeight: 40,
              opacity: isConnecting ? 0.7 : 1,
            }}
          >
            <Wallet size={14} strokeWidth={2.5} />
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
