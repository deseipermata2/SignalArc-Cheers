/**
 * PhaseBadge — compact status pill for a gift's current phase (dark theme).
 *
 * Pass `totalContributed` when the balance is known so the badge can show
 * balance-aware labels:
 *   CLAIMABLE  + 0n → "No funds"
 *   REFUNDABLE + 0n → "Claim expired · No funds"
 *
 * When `totalContributed` is undefined (still loading) the standard phase
 * label is shown — never a misleading "No funds" during a load.
 */

import { GiftPhase, displayLabel, displayColor } from '../lib/cheers-contract'

interface PhaseBadgeProps {
  phase: GiftPhase
  /** When provided and equals 0n, renders balance-aware label and color. */
  totalContributed?: bigint
  size?: 'sm' | 'md'
}

export function PhaseBadge({ phase, totalContributed, size = 'md' }: PhaseBadgeProps) {
  const color = displayColor(phase, totalContributed)
  const label = displayLabel(phase, totalContributed)

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'
      }`}
      style={{
        background: color + '18',
        color,
        border: '1px solid ' + color + '28',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block', width: 5, height: 5,
          borderRadius: '50%', background: color, flexShrink: 0,
        }}
      />
      {label}
    </span>
  )
}
