/**
 * useLiveTime — returns the current Unix timestamp in seconds, updated every tick.
 *
 * Default tick: 1 second. Components that only need minute-level precision should
 * pass tickMs=60_000 to reduce re-renders.
 *
 * Also accepts an optional array of boundary timestamps (Unix seconds). When the
 * clock crosses a boundary the consumer typically wants to re-fetch contract state;
 * pass an `onBoundaryCross` callback to be notified once per crossing.
 *
 * Cleanup: the interval is cleared on unmount.
 */

import { useState, useEffect, useRef } from 'react'

export function useLiveTime(
  tickMs: number = 1_000,
  boundaries?: bigint[],
  onBoundaryCross?: (boundary: bigint) => void,
): bigint {
  const [nowSec, setNowSec] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)))
  const crossedRef = useRef<Set<bigint>>(new Set())

  useEffect(() => {
    const id = setInterval(() => {
      const now = BigInt(Math.floor(Date.now() / 1000))
      setNowSec(now)

      if (boundaries && onBoundaryCross) {
        for (const b of boundaries) {
          if (now >= b && !crossedRef.current.has(b)) {
            crossedRef.current.add(b)
            onBoundaryCross(b)
          }
        }
      }
    }, tickMs)

    return () => clearInterval(id)
  }, [tickMs, boundaries, onBoundaryCross])

  return nowSec
}
