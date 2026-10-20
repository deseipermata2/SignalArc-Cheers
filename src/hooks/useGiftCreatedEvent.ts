/**
 * useGiftCreatedEvent — reads the GiftCreated log for a specific giftId
 * from the registry contract, bounded to the known deployment block.
 *
 * Returns the creator address and creation txHash from the canonical
 * on-chain event. Falls back to null when the log cannot be fetched.
 *
 * This hook is used by the metadata recovery flow to:
 * 1. Verify the connected wallet is the actual gift creator.
 * 2. Provide the canonical txHash for the save_gift payload without
 *    requiring the user to recall or type it.
 *
 * Never uses a user-supplied txHash as creator identity — the backend
 * independently verifies the receipt.
 */

import { useState, useEffect, useRef } from 'react'
import { arcPublicClient } from '../lib/cheers-contract'
import { CHEERS_ABI, registryAddress, CHAIN_ID } from '../lib/cheers-contract'
import { decodeEventLog } from 'viem'

/** Deployment block for CheersGiftRegistry on Arc Mainnet. */
const DEPLOYMENT_BLOCK = 26_623_210n

export interface GiftCreatedEventData {
  giftId: bigint
  creator: `0x${string}`
  recipient: `0x${string}`
  giftAt: bigint
  claimDeadline: bigint
  txHash: `0x${string}`
  logIndex: number
}

export type GiftCreatedState =
  | 'idle'
  | 'fetching'
  | 'ok'
  | 'not-found'
  | 'error'

export function useGiftCreatedEvent(giftId: string): {
  state: GiftCreatedState
  event: GiftCreatedEventData | null
  error: string | null
  refetch: () => void
} {
  const contractAddr = registryAddress()
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<GiftCreatedState>('idle')
  const [event, setEvent] = useState<GiftCreatedEventData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadedForRef = useRef<string | null>(null)

  // Derive loading state from tick vs loaded-for
  const loadingKey = contractAddr ? `${CHAIN_ID}:${contractAddr}:${giftId}:${tick}` : null

  useEffect(() => {
    if (!loadingKey || loadedForRef.current === loadingKey) return
    if (!contractAddr) return

    let cancelled = false
    loadedForRef.current = loadingKey
    setError(null)
    setState('fetching')

    const giftIdBig = BigInt(giftId)

    arcPublicClient.getLogs({
      address: contractAddr,
      event: {
        type: 'event',
        name: 'GiftCreated',
        inputs: [
          { type: 'uint256', name: 'giftId', indexed: true },
          { type: 'address', name: 'creator', indexed: true },
          { type: 'address', name: 'recipient', indexed: true },
          { type: 'uint256', name: 'giftAt', indexed: false },
          { type: 'uint256', name: 'claimDeadline', indexed: false },
        ],
      },
      args: { giftId: giftIdBig },
      fromBlock: DEPLOYMENT_BLOCK,
      toBlock: 'latest',
    }).then((logs) => {
      if (cancelled) return

      if (logs.length === 0) {
        setState('not-found')
        setEvent(null)
        return
      }

      // Use the first matching log (giftId is unique)
      const log = logs[0]
      if (!log.transactionHash || log.logIndex === null) {
        setState('error')
        setError('Log is missing transaction hash or index.')
        return
      }

      try {
        const decoded = decodeEventLog({
          abi: CHEERS_ABI,
          eventName: 'GiftCreated',
          data: log.data,
          topics: log.topics,
        })

        const args = decoded.args

        setEvent({
          giftId: args.giftId,
          creator: args.creator,
          recipient: args.recipient,
          giftAt: args.giftAt,
          claimDeadline: args.claimDeadline,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        })
        setState('ok')
      } catch (decodeErr) {
        setState('error')
        setError(decodeErr instanceof Error ? decodeErr.message : 'Failed to decode event.')
      }
    }).catch((fetchErr: unknown) => {
      if (cancelled) return
      setState('error')
      setError(fetchErr instanceof Error ? fetchErr.message : 'Failed to fetch event logs.')
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingKey])

  return {
    state,
    event,
    error,
    refetch: () => setTick(t => t + 1),
  }
}
