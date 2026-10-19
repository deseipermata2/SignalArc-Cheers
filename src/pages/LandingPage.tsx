/**
 * LandingPage — live registry listing with filter tabs, hero, and navigation.
 * No demo content. All gift cards are real on-chain data.
 */

import { useState, useRef } from 'react'
import { useAccount } from 'wagmi'
import { motion } from 'framer-motion'
import { Users, Gift, ShieldCheck, ArrowRight, Sparkles, Hash } from 'lucide-react'
import { ContractPendingNotice } from '../components/ContractPendingNotice'
import { GiftsListing, type GiftFilter } from '../components/GiftsListing'
import { isRegistryConfigured } from '../lib/cheers-contract'

// ── Features ──────────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Users,
    title: 'Pool contributions',
    body: 'Anyone can send USDC to a gift before the reveal date. No limit on contributors.',
    color: '#22c55e',
  },
  {
    icon: Gift,
    title: 'One moment, one claim',
    body: 'The recipient claims the full pooled amount in a single transaction at the right time.',
    color: '#D97706',
  },
  {
    icon: ShieldCheck,
    title: 'Safe refunds built in',
    body: 'If the gift is never claimed, every contributor can withdraw their own USDC — no one else controls it.',
    color: '#7C3AED',
  },
]

// ── Ambient blobs (restrained) ────────────────────────────────────────────────

function AmbientBlobs() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
      <div style={{
        position: 'absolute', top: '5%', right: '8%', width: 500, height: 500,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(217,119,6,0.07) 0%, transparent 65%)',
        filter: 'blur(80px)',
      }} />
      <div style={{
        position: 'absolute', bottom: '15%', left: '0%', width: 450, height: 450,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(124,58,237,0.06) 0%, transparent 65%)',
        filter: 'blur(80px)',
      }} />
    </div>
  )
}

// ── Feature card ──────────────────────────────────────────────────────────────

function FeatureCard({ icon: Icon, title, body, color }: typeof FEATURES[0]) {
  return (
    <div
      className="glass-card rounded-2xl px-5 py-4 flex items-start gap-4"
      style={{ transition: 'border-color 0.15s' }}
    >
      <div className="flex-shrink-0 rounded-xl p-2.5" style={{ background: color + '14' }}>
        <Icon size={17} strokeWidth={2} style={{ color }} />
      </div>
      <div>
        <p className="font-semibold text-sm mb-1" style={{ color: 'var(--ink)' }}>
          {title}
        </p>
        <p className="text-sm text-pretty leading-relaxed" style={{ color: 'var(--muted)' }}>
          {body}
        </p>
      </div>
    </div>
  )
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

const FILTER_TABS: { id: GiftFilter; label: string; requiresWallet?: boolean }[] = [
  { id: 'all',    label: 'All gifts' },
  { id: 'mine',   label: 'Created by me', requiresWallet: true },
  { id: 'for-me', label: 'For me',        requiresWallet: true },
]

interface FilterTabsProps {
  active: GiftFilter
  onChange: (f: GiftFilter) => void
}

function FilterTabs({ active, onChange }: FilterTabsProps) {
  const { isConnected } = useAccount()
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {FILTER_TABS.map(tab => {
        const disabled = tab.requiresWallet && !isConnected
        const isActive = active === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => !disabled && onChange(tab.id)}
            disabled={disabled}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
            style={{
              background: isActive ? 'rgba(217,119,6,0.15)' : 'var(--surface-raised)',
              color:      isActive ? 'var(--accent)'         : disabled ? 'var(--subtle)' : 'var(--ink-2)',
              border:     `1px solid ${isActive ? 'rgba(217,119,6,0.3)' : 'var(--border-strong)'}`,
              cursor:     disabled ? 'not-allowed' : 'pointer',
              minHeight: 32,
            }}
            title={disabled ? 'Connect your wallet to use this filter' : undefined}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface LandingPageProps {
  onCreateGift: () => void
  onOpenGift: (giftId: string) => void
}

export function LandingPage({ onCreateGift, onOpenGift }: LandingPageProps) {
  const contractReady = isRegistryConfigured()
  const [giftIdInput, setGiftIdInput] = useState('')
  const [giftIdError, setGiftIdError] = useState<string | null>(null)
  const [showIdInput, setShowIdInput] = useState(false)
  const [filter, setFilter] = useState<GiftFilter>('all')
  const reloadListingRef = useRef<(() => void) | null>(null)

  function handleGiftIdSubmit() {
    const raw = giftIdInput.trim()
    const match =
      raw.match(/#\/gift\/(\d+)/) ||
      raw.match(/\/gift\/(\d+)/) ||
      raw.match(/^(\d+)$/)
    if (match) {
      onOpenGift(match[1])
    } else {
      setGiftIdError('Paste a gift link or enter a gift number.')
    }
  }

  return (
    <div className="relative overflow-x-hidden">
      <AmbientBlobs />

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 sm:px-8 pt-14 pb-10">

        {/* Coming-soon notice */}
        {!contractReady && (
          <motion.div
            className="mb-10 max-w-xl"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <ContractPendingNotice />
          </motion.div>
        )}

        {/* Two-column hero on md+, stacked on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 lg:gap-16 items-start">

          {/* Left — copy + CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {/* Eyebrow */}
            <div className="flex items-center gap-2 mb-5">
              <Sparkles size={14} strokeWidth={2} style={{ color: 'var(--accent)' }} />
              <span
                className="text-xs font-semibold"
                style={{ color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                Community gifts on Arc
              </span>
            </div>

            <h1
              className="display font-bold text-balance mb-5"
              style={{
                fontSize: 'clamp(2.25rem, 5vw, 3.25rem)',
                lineHeight: 1.1,
                color: 'var(--ink)',
                letterSpacing: '-0.03em',
              }}
            >
              Group gifting<br />
              <span style={{ color: 'var(--accent)' }}>in USDC</span>
            </h1>

            <p
              className="text-pretty leading-relaxed mb-8"
              style={{ color: 'var(--muted)', maxWidth: '42ch', fontSize: '1.0625rem' }}
            >
              Pool contributions for one recipient.
              Share a link, let friends add to the pool, and the recipient
              claims the total when the gift date arrives.
            </p>

            {/* CTAs */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                disabled={!contractReady}
                onClick={contractReady ? onCreateGift : undefined}
                className="flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all"
                style={{
                  background: contractReady ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
                  color: contractReady ? '#0d0e12' : 'var(--subtle)',
                  cursor: contractReady ? 'pointer' : 'not-allowed',
                  minHeight: 48,
                  border: contractReady ? 'none' : '1px solid var(--border)',
                }}
                title={contractReady ? undefined : 'On-chain gifting is coming soon'}
              >
                Create a gift
                <ArrowRight size={15} strokeWidth={2.5} />
              </button>

              <button
                onClick={() => setShowIdInput(v => !v)}
                className="flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--ink-2)',
                  cursor: 'pointer',
                  minHeight: 48,
                }}
              >
                <Hash size={14} strokeWidth={2} />
                Open by ID
              </button>
            </div>

            {/* Gift ID input */}
            {showIdInput && (
              <motion.div
                className="mt-3 flex gap-2"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <input
                  type="text"
                  value={giftIdInput}
                  onChange={(e) => { setGiftIdInput(e.target.value); setGiftIdError(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleGiftIdSubmit() }}
                  placeholder="Gift number or link…"
                  className="flex-1 rounded-xl px-4 py-2.5 text-sm outline-none mono"
                  style={{
                    background: 'var(--surface-card)',
                    border: `1px solid ${giftIdError ? 'var(--danger)' : 'var(--border-strong)'}`,
                    color: 'var(--ink)',
                    caretColor: 'var(--accent)',
                  }}
                  autoFocus
                />
                <button
                  onClick={handleGiftIdSubmit}
                  className="rounded-xl px-4 py-2.5 text-sm font-semibold"
                  style={{ background: 'var(--accent)', color: '#0d0e12', border: 'none', cursor: 'pointer' }}
                >
                  Go
                </button>
              </motion.div>
            )}
            {giftIdError && (
              <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{giftIdError}</p>
            )}
          </motion.div>

          {/* Right — How it works (desktop) */}
          <motion.div
            className="flex flex-col gap-3"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Live gifts listing ─────────────────────────────────── */}
      {contractReady && (
        <section className="relative z-10 mx-auto max-w-6xl px-5 sm:px-8 pb-16">
          {/* Section header + filter tabs */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
            <p
              className="text-xs font-semibold"
              style={{ color: 'var(--subtle)', letterSpacing: '0.09em', textTransform: 'uppercase', flexShrink: 0 }}
            >
              Gifts
            </p>
            <div className="flex-1" />
            <FilterTabs active={filter} onChange={setFilter} />
          </div>

          <GiftsListing
            filter={filter}
            onOpenGift={onOpenGift}
            onReloadRef={(fn) => { reloadListingRef.current = fn }}
          />
        </section>
      )}

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer
        className="relative z-10 border-t px-5 sm:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--subtle)' }}
      >
        <span>SignalArc Cheers</span>
        <span>Powered by <span style={{ color: 'var(--ink-2)' }}>Arc Mainnet</span> · USDC</span>
      </footer>
    </div>
  )
}
