/**
 * GiftsListing — live registry gift cards with filtering.
 *
 * Shows real on-chain gifts with titles from Supabase.
 * Never shows demo content or fabricated data.
 *
 * Filters:
 *   all       — all known gifts (most recent first)
 *   mine      — gifts created by the connected wallet
 *   for-me    — gifts addressed to the connected wallet
 */

import { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { motion, AnimatePresence } from 'framer-motion'
import { Gift, RefreshCw, AlertCircle } from 'lucide-react'
import { PhaseBadge } from './PhaseBadge'
import { GiftPhase } from '../lib/cheers-contract'
import { useGiftListing, type GiftListItem } from '../hooks/useGiftListing'

// ── Filter type ───────────────────────────────────────────────────────────────

export type GiftFilter = 'all' | 'mine' | 'for-me'

interface GiftsListingProps {
  filter: GiftFilter
  onOpenGift: (giftId: string) => void
  onReloadRef?: (reload: () => void) => void
}

// ── Individual live gift card ─────────────────────────────────────────────────

// Returns the correct pooled-amount label for a gift card.
// Null balance is treated as loading/unknown, never as zero.
function poolLabel(item: GiftListItem): string {
  if (item.phase === GiftPhase.CLOSED)   return 'Claimed'
  if (item.totalContributed === 0n) {
    // Contributions closed (past giftAt) with confirmed zero balance.
    if (item.phase === GiftPhase.CLAIMABLE || item.phase === GiftPhase.REFUNDABLE) {
      return 'Claim window open · No funds'
    }
    return 'No contributions yet'   // OPEN: still accepting
  }
  return 'Pooled'
}

function LiveGiftCard({ item, onClick }: { item: GiftListItem; onClick: () => void }) {
  const noFunds = item.totalContributed === 0n
  const isClaimed = item.phase === GiftPhase.CLOSED
  const label = poolLabel(item)

  return (
    <motion.button
      onClick={onClick}
      className="w-full text-left glass-card rounded-2xl p-5 flex flex-col gap-4 focus-visible:outline-none"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      whileHover={{ borderColor: 'rgba(217,119,6,0.25)', transition: { duration: 0.12 } }}
      style={{ cursor: 'pointer', minHeight: 120 }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="display font-semibold text-base leading-tight truncate" style={{ color: 'var(--ink)' }}>
            {item.title ?? `Gift #${item.giftId}`}
          </p>
          {!item.title && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>
              No title saved · Gift #{item.giftId}
            </p>
          )}
        </div>
        <PhaseBadge phase={item.phase} totalContributed={item.totalContributed} size="sm" />
      </div>

      {/* Pooled amount */}
      <div>
        <p className="text-xs mb-1" style={{ color: 'var(--muted)', letterSpacing: '0.04em' }}>
          {label}
        </p>
        <p
          className="display tabular font-bold text-2xl"
          style={{
            color: isClaimed ? 'var(--ink-2)' : noFunds ? 'var(--subtle)' : 'var(--accent)',
            lineHeight: 1,
          }}
        >
          {noFunds ? '—' : item.pooledDisplay}
        </p>
      </div>

      {/* Meta row */}
      <div
        className="flex items-center gap-3 rounded-xl px-3 py-2 text-xs flex-wrap"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        <span className="mono" style={{ color: 'var(--subtle)' }}>
          #{item.giftId}
        </span>
        <span style={{ color: 'var(--subtle)' }}>·</span>
        <span style={{ color: 'var(--muted)' }}>
          {new Date(Number(item.giftAt) * 1000).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
          })}
        </span>
        {item.phase === GiftPhase.OPEN && (
          <>
            <span style={{ color: 'var(--subtle)' }}>·</span>
            <span style={{ color: 'var(--muted)' }}>Accepting contributions</span>
          </>
        )}
      </div>
    </motion.button>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ filter }: { filter: GiftFilter }) {
  const messages: Record<GiftFilter, { heading: string; body: string }> = {
    all:      { heading: 'No gifts yet',      body: 'Create the first community gift on SignalArc Cheers.' },
    mine:     { heading: 'No gifts created',  body: 'Gifts you create will appear here.' },
    'for-me': { heading: 'No gifts for you',  body: 'Gifts addressed to your wallet will appear here.' },
  }
  const m = messages[filter]
  return (
    <div
      className="rounded-2xl px-6 py-10 text-center"
      style={{ border: '1px dashed var(--border-strong)' }}
    >
      <Gift size={28} strokeWidth={1.5} className="mx-auto mb-3" style={{ color: 'var(--subtle)' }} />
      <p className="font-semibold mb-1 text-sm" style={{ color: 'var(--ink-2)' }}>{m.heading}</p>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>{m.body}</p>
    </div>
  )
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="glass-card rounded-2xl p-5 space-y-3 animate-pulse" style={{ opacity: 0.45 }}>
      <div className="flex justify-between">
        <div className="h-4 rounded" style={{ width: '60%', background: 'var(--surface-raised)' }} />
        <div className="h-5 w-16 rounded-full" style={{ background: 'var(--surface-raised)' }} />
      </div>
      <div className="h-7 rounded" style={{ width: '35%', background: 'var(--surface-raised)' }} />
      <div className="h-8 rounded-xl" style={{ background: 'var(--surface-muted)' }} />
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function GiftsListing({ filter, onOpenGift, onReloadRef }: GiftsListingProps) {
  const { address: walletAddress } = useAccount()
  const { gifts, state, error, totalOnChain, reload } = useGiftListing()

  // Expose reload to parent (for post-creation refresh)
  if (onReloadRef) onReloadRef(reload)

  // Apply filter
  const filtered = useMemo(() => {
    if (!walletAddress) return filter === 'all' ? gifts : []
    if (filter === 'mine') {
      return gifts.filter(g =>
        g.creator !== null && g.creator.toLowerCase() === walletAddress.toLowerCase()
      )
    }
    if (filter === 'for-me') {
      return gifts.filter(g =>
        g.recipient.toLowerCase() === walletAddress.toLowerCase()
      )
    }
    return gifts
  }, [gifts, filter, walletAddress])

  // Wallet required for scoped filters
  const needsWallet = (filter === 'mine' || filter === 'for-me') && !walletAddress

  return (
    <div>
      {/* Header row with reload */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs font-semibold" style={{ color: 'var(--subtle)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {state === 'loaded'
            ? (filter === 'all'
                ? `${totalOnChain} gift${totalOnChain !== 1 ? 's' : ''} on-chain`
                : `${filtered.length} gift${filtered.length !== 1 ? 's' : ''}`)
            : 'Gifts'}
        </p>
        <button
          onClick={reload}
          disabled={state === 'loading'}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            color: 'var(--ink-2)',
            cursor: state === 'loading' ? 'default' : 'pointer',
            opacity: state === 'loading' ? 0.5 : 1,
          }}
          aria-label="Refresh gift list"
        >
          <RefreshCw size={11} strokeWidth={2} className={state === 'loading' ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error */}
      {state === 'error' && (
        <div
          className="rounded-2xl px-4 py-3 flex items-start gap-3 mb-3 text-sm"
          style={{ background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)' }}
        >
          <AlertCircle size={15} strokeWidth={2} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p className="font-medium" style={{ color: 'var(--danger)' }}>Could not load gifts</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              {error ?? 'Check your connection and try again.'}
            </p>
          </div>
        </div>
      )}

      {/* Wallet required notice */}
      {needsWallet && (
        <div
          className="rounded-2xl px-4 py-3 text-sm text-center"
          style={{ border: '1px dashed var(--border-strong)', color: 'var(--muted)' }}
        >
          Connect your wallet to see {filter === 'mine' ? 'gifts you created' : 'gifts addressed to you'}.
        </div>
      )}

      {/* Skeletons while loading */}
      {state === 'loading' && (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {/* Live gift cards */}
      {state === 'loaded' && !needsWallet && (
        <AnimatePresence mode="wait">
          {filtered.length === 0
            ? <EmptyState filter={filter} />
            : (
              <div className="space-y-3">
                {filtered.map(item => (
                  <LiveGiftCard
                    key={item.giftId}
                    item={item}
                    onClick={() => onOpenGift(item.giftId)}
                  />
                ))}
              </div>
            )
          }
        </AnimatePresence>
      )}
    </div>
  )
}
