/**
 * useGiftCreatedEvent — scans the registry for the GiftCreated log of a specific
 * giftId, using bounded block-range pagination to stay within the Arc RPC limit.
 *
 * - Starts at DEPLOYMENT_BLOCK (26 623 210).
 * - Steps forward in PAGE_SIZE-block windows (≤ 500 blocks per request).
 * - Stops as soon as the matching event is found.
 * - Falls back gracefully when the RPC rejects a range or is unreachable.
 *
 * Never uses a user-supplied txHash as creator identity — the backend
 * independently verifies the receipt.
 */

import { useState, useEffect, useRef } from 'react'
import { arcPublicClient, CHEERS_ABI, registryAddress, CHAIN_ID } from '../lib/cheers-contract'
import { decodeEventLog } from 'viem'

/** Deployment block for CheersGiftRegistry on Arc Mainnet. */
const DEPLOYMENT_BLOCK = 26_623_210n

/**
 * Maximum blocks per getLogs request.
 * Arc RPC rejects ranges larger than ~500 blocks.
 */
const PAGE_SIZE = 500n

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

/** True when the error is the Arc "requested range too large" response. */
function isRangeTooLargeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.toLowerCase().includes('range too large') ||
         msg.toLowerCase().includes('too large') ||
         (typeof err === 'object' && err !== null && 'code' in err && (err).code === -32012)
}

/** Concise message shown to users — strips raw RPC details. */
function friendlyError(err: unknown): string {
  if (isRangeTooLargeError(err)) {
    return 'Could not scan the full block range (RPC limit). Enter the creation transaction hash manually.'
  }
  if (err instanceof Error) {
    // Keep only the first sentence; RPC errors can be very long.
    const first = err.message.split('\n')[0].split('.')[0]
    return first.length > 120 ? first.slice(0, 120) + '…' : first
  }
  return 'Failed to fetch creation event.'
}

/**
 * Scan for a GiftCreated log for the given giftId, paginating in PAGE_SIZE
 * windows from DEPLOYMENT_BLOCK to the current head.
 *
 * Resolves with the matching log's decoded args + metadata, or null when not
 * found after scanning the full chain.
 *
 * Throws with a concise error message on RPC failure (including range-too-large
 * after automatic page-size reduction).
 */
async function scanForGiftCreated(
  contractAddr: `0x${string}`,
  giftIdBig: bigint,
  signal: { cancelled: boolean },
): Promise<GiftCreatedEventData | null> {
  const eventDescriptor = {
    type: 'event' as const,
    name: 'GiftCreated',
    inputs: [
      { type: 'uint256', name: 'giftId',        indexed: true  },
      { type: 'address', name: 'creator',        indexed: true  },
      { type: 'address', name: 'recipient',      indexed: true  },
      { type: 'uint256', name: 'giftAt',         indexed: false },
      { type: 'uint256', name: 'claimDeadline',  indexed: false },
    ],
  }

  // Fetch current block number first so we know when to stop.
  let headBlock: bigint
  try {
    headBlock = await arcPublicClient.getBlockNumber()
  } catch (err: unknown) {
    throw new Error(friendlyError(err))
  }
  if (signal.cancelled) return null

  let from = DEPLOYMENT_BLOCK
  let pageSize = PAGE_SIZE

  while (from <= headBlock) {
    if (signal.cancelled) return null

    const to = from + pageSize - 1n < headBlock ? from + pageSize - 1n : headBlock

    let logs: Awaited<ReturnType<typeof arcPublicClient.getLogs>>
    try {
      logs = await arcPublicClient.getLogs({
        address: contractAddr,
        event: eventDescriptor,
        args: { giftId: giftIdBig },
        fromBlock: from,
        toBlock: to,
      })
    } catch (err: unknown) {
      if (isRangeTooLargeError(err) && pageSize > 50n) {
        // Halve page size and retry the same window
        pageSize = pageSize / 2n
        continue
      }
      throw new Error(friendlyError(err))
    }

    if (signal.cancelled) return null

    if (logs.length > 0) {
      const log = logs[0]
      if (!log.transactionHash || log.logIndex === null) {
        throw new Error('Creation event found but is missing transaction hash or log index.')
      }

      const decoded = decodeEventLog({
        abi: CHEERS_ABI,
        eventName: 'GiftCreated',
        data: log.data,
        topics: log.topics,
      })
      const args = decoded.args

      return {
        giftId:        args.giftId,
        creator:       args.creator,
        recipient:     args.recipient,
        giftAt:        args.giftAt,
        claimDeadline: args.claimDeadline,
        txHash:        log.transactionHash,
        logIndex:      log.logIndex,
      }
    }

    from = to + 1n
  }

  return null  // scanned entire chain, event not found
}

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

  const loadingKey = contractAddr ? `${CHAIN_ID}:${contractAddr}:${giftId}:${tick}` : null

  useEffect(() => {
    if (!loadingKey || loadedForRef.current === loadingKey) return
    if (!contractAddr) return

    const signal = { cancelled: false }
    loadedForRef.current = loadingKey
    setError(null)
    setState('fetching')

    const giftIdBig = BigInt(giftId)

    scanForGiftCreated(contractAddr, giftIdBig, signal)
      .then((found) => {
        if (signal.cancelled) return
        if (found === null) {
          setState('not-found')
          setEvent(null)
        } else {
          setEvent(found)
          setState('ok')
        }
      })
      .catch((err: unknown) => {
        if (signal.cancelled) return
        setState('error')
        setError(err instanceof Error ? err.message : 'Failed to fetch creation event.')
      })

    return () => { signal.cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingKey])

  return {
    state,
    event,
    error,
    refetch: () => setTick(t => t + 1),
  }
}
