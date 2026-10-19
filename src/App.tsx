/**
 * App — SignalArc Cheers root shell (dark theme).
 * Hash routing: #/ → Landing, #/create → CreateGift, #/gift/:id → GiftDetail
 */

import { useState, useEffect } from 'react'
import { WalletButton } from './components/WalletButton'
import { WrongNetwork } from './components/WrongNetwork'
import { LandingPage } from './pages/LandingPage'
import { GiftDetailPage } from './pages/GiftDetailPage'
import { CreateGiftPage } from './pages/CreateGiftPage'

// ── Hash router ───────────────────────────────────────────────────────────────

type Route =
  | { name: 'landing' }
  | { name: 'create' }
  | { name: 'gift'; id: string }

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const giftMatch = path.match(/^gift\/(\d+)$/)
  if (giftMatch) return { name: 'gift', id: giftMatch[1] }
  if (path === 'create') return { name: 'create' }
  return { name: 'landing' }
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRouteState] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const handler = () => setRouteState(parseHash(window.location.hash))
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  function setRoute(r: Route) {
    const hash =
      r.name === 'gift'   ? `/gift/${r.id}` :
      r.name === 'create' ? '/create' :
      '/'
    window.location.hash = hash
    setRouteState(r)
  }

  return [route, setRoute]
}

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  const [route, setRoute] = useHashRoute()

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* ── Top nav ──────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-5 sm:px-8"
        style={{
          height: 60,
          background: 'rgba(13,14,18,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        {/* Brand */}
        <button
          onClick={() => setRoute({ name: 'landing' })}
          className="flex items-center gap-2.5 transition-opacity hover:opacity-80 focus-visible:rounded"
          style={{ background: 'none', border: 'none', cursor: 'pointer', minHeight: 44, padding: 0 }}
          aria-label="SignalArc Cheers home"
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 8px rgba(217,119,6,0.7)',
              flexShrink: 0,
            }}
          />
          <span
            className="display font-bold text-sm tracking-tight"
            style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}
          >
            SignalArc<span style={{ color: 'var(--accent)' }}> Cheers</span>
          </span>
        </button>

        {/* Right side: nav + wallet */}
        <div className="flex items-center gap-2">
          {/* Create gift nav link */}
          <button
            onClick={() => setRoute({ name: 'create' })}
            className="hidden sm:flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
            style={{
              background: route.name === 'create' ? 'rgba(217,119,6,0.15)' : 'transparent',
              color:      route.name === 'create' ? 'var(--accent)' : 'var(--ink-2)',
              border:     `1px solid ${route.name === 'create' ? 'rgba(217,119,6,0.3)' : 'transparent'}`,
              cursor: 'pointer',
              minHeight: 36,
            }}
          >
            + Create
          </button>
          <WalletButton />
        </div>
      </header>

      {/* ── Wrong-network banner ─────────────────────────────── */}
      <WrongNetwork />

      {/* ── Page ─────────────────────────────────────────────── */}
      <main>
        {route.name === 'landing' && (
          <LandingPage
            onCreateGift={() => setRoute({ name: 'create' })}
            onOpenGift={(id) => setRoute({ name: 'gift', id })}
          />
        )}
        {route.name === 'create' && (
          <CreateGiftPage
            onBack={() => setRoute({ name: 'landing' })}
            onGiftCreated={(id) => setRoute({ name: 'gift', id })}
          />
        )}
        {route.name === 'gift' && (
          <GiftDetailPage
            giftId={route.id}
            onBack={() => setRoute({ name: 'landing' })}
          />
        )}
      </main>
    </div>
  )
}
