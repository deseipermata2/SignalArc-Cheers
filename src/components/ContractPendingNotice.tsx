/**
 * ContractPendingNotice — shown when VITE_REGISTRY_ADDRESS is not set.
 * User-facing copy only; setup instructions are in developer docs.
 */

import { Sparkles } from 'lucide-react'

export function ContractPendingNotice() {
  return (
    <div
      className="flex items-center gap-3 rounded-2xl px-4 py-3 text-sm"
      style={{
        background: 'rgba(217,119,6,0.08)',
        border: '1px solid rgba(217,119,6,0.18)',
        color: 'var(--ink-2)',
      }}
    >
      <Sparkles size={15} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <span style={{ color: 'var(--ink-2)' }}>
        On-chain gifting is coming soon.
      </span>
    </div>
  )
}
