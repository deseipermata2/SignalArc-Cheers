/**
 * usePendingTx — persist a pending transaction hash across page reloads,
 * scoped to (chainId, registryAddress, accountAddress, giftId, action).
 *
 * Stored in localStorage under a deterministic key. The entry is cleared
 * when the component calls `clearPending()` (on confirmation or explicit reset).
 *
 * Actions: 'contribute' | 'approve' | 'claim' | 'refund' | 'createGift'
 */

import { useState, useCallback } from 'react'
import { CHAIN_ID } from '../lib/cheers-contract'

export type TxAction = 'approve' | 'contribute' | 'claim' | 'refund' | 'createGift'

function storageKey(
  registryAddr: string,
  account: string,
  giftId: string,
  action: TxAction,
): string {
  return `cheers:tx:${CHAIN_ID}:${registryAddr.toLowerCase()}:${account.toLowerCase()}:${giftId}:${action}`
}

export function usePendingTx(
  registryAddr: string | null,
  account: string | undefined,
  giftId: string,
  action: TxAction,
): {
  pendingHash: `0x${string}` | null
  setPending: (hash: `0x${string}`) => void
  clearPending: () => void
} {
  const key = registryAddr && account
    ? storageKey(registryAddr, account, giftId, action)
    : null

  const [pendingHash, setPendingState] = useState<`0x${string}` | null>(() => {
    if (!key) return null
    try {
      return (localStorage.getItem(key) as `0x${string}`) || null
    } catch {
      return null
    }
  })

  const setPending = useCallback((hash: `0x${string}`) => {
    setPendingState(hash)
    if (key) {
      try { localStorage.setItem(key, hash) } catch { /* quota */ }
    }
  }, [key])

  const clearPending = useCallback(() => {
    setPendingState(null)
    if (key) {
      try { localStorage.removeItem(key) } catch { /* quota */ }
    }
  }, [key])

  return { pendingHash, setPending, clearPending }
}
