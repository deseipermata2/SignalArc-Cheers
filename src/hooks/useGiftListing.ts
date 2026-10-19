/**
 * useGiftListing — discovers and loads all gifts from the registry.
 *
 * Discovery: reads nextGiftId() to find the ID range, then loads each
 * gift via getGift(). Limited to MAX_GIFTS most-recent gifts to avoid
 * unbounded RPC scans on a large registry.
 *
 * Metadata: fetches titles and descriptions from the Supabase API.
 * Missing metadata does not mean the gift is nonexistent — the contract
 * is authoritative.
 *
 * Account-scoped filters (createdBy / recipientOf) are derived from
 * on-chain data only — creator comes from GiftCreated event topics,
 * recipient from the stored Gift struct.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  arcPublicClient, GiftPhase, derivePhase, fmtUsdc,
  CHEERS_ABI, registryAddress, CHAIN_ID,
} from '../lib/cheers-contract'
import { apiGetGift, isApiConfigured, type GiftMeta } from '../lib/cheers-api'
import { parseAbiItem } from 'viem'

const MAX_GIFTS = 50 // never scan more than this many IDs at once

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GiftListItem {
  giftId: string
  /** Recipient address (from contract) */
  recipient: `0x${string}`
  /** Creator address (from GiftCreated event) */
  creator: `0x${string}` | null
  giftAt: bigint
  claimDeadline: bigint
  totalContributed: bigint
  phase: GiftPhase
  /** USDC formatted pooled amount */
  pooledDisplay: string
  /** Title from API metadata, or null if not saved */
  title: string | null
  /** Description from API metadata */
  description: string | null
}

export type ListingState = 'idle' | 'loading' | 'loaded' | 'error'

export interface UseGiftListingResult {
  gifts: GiftListItem[]
  state: ListingState
  error: string | null
  totalOnChain: number
  reload: () => void
}

// GiftCreated event ABI item for creator extraction
const GIFT_CREATED_ABI_ITEM = parseAbiItem(
  'event GiftCreated(uint256 indexed giftId, address indexed creator, address indexed recipient, uint256 giftAt, uint256 claimDeadline)'
)

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useGiftListing(): UseGiftListingResult {
  const [gifts, setGifts] = useState<GiftListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [totalOnChain, setTotalOnChain] = useState(0)
  const [tick, setTick] = useState(0)

  // loadingTick tracks which tick is currently being loaded.
  // Comparing it to tick lets the render derive `state` without setState in effects.
  const [loadingTick, setLoadingTick] = useState<number | null>(null)
  const [doneTick, setDoneTick] = useState<number | null>(null)
  const [errorTick, setErrorTick] = useState<number | null>(null)

  const cancelRef = useRef(false)

  const reload = useCallback(() => setTick(t => t + 1), [])

  // Derived state — no setState calls in the main effect
  const state: ListingState =
    !registryAddress()               ? 'idle'    :
    errorTick === tick               ? 'error'   :
    doneTick === tick                ? 'loaded'  :
    loadingTick === tick             ? 'loading' :
    'idle'

  // Signal which tick to load (synchronous, tiny effect — doesn't do async work)
  useEffect(() => {
    if (!registryAddress()) return
    setLoadingTick(tick)
  }, [tick])

  // Async load effect — fires when loadingTick changes
  useEffect(() => {
    if (loadingTick === null || !registryAddress()) return

    const addr = registryAddress()!
    cancelRef.current = false
    setError(null)

    async function load() {
      try {
        // Step 1: read nextGiftId
        const nextId = await arcPublicClient.readContract({
          address: addr,
          abi: CHEERS_ABI,
          functionName: 'nextGiftId',
        })

        if (cancelRef.current) return
        const total = Number(nextId) - 1
        setTotalOnChain(total)

        if (total === 0) {
          setGifts([])
          setDoneTick(loadingTick)
          return
        }

        // Step 2: most-recent MAX_GIFTS gifts (descending order)
        const firstId = Math.max(1, total - MAX_GIFTS + 1)
        const ids: bigint[] = []
        for (let id = total; id >= firstId; id--) {
          ids.push(BigInt(id))
        }

        // Step 3: batch getGift via multicall
        const giftCalls = ids.map(id => ({
          address: addr,
          abi: CHEERS_ABI,
          functionName: 'getGift' as const,
          args: [id] as const,
          chainId: CHAIN_ID,
        }))

        type GiftStruct = {
          recipient: `0x${string}`
          giftAt: bigint
          claimDeadline: bigint
          totalContributed: bigint
          totalClaimed: bigint
          totalRefunded: bigint
        }
        let giftResults: Array<GiftStruct | null> = []

        try {
          const multicallResults = await arcPublicClient.multicall({
            contracts: giftCalls,
            allowFailure: true,
          })
          giftResults = multicallResults.map(r =>
            r.status === 'success' ? r.result : null
          )
        } catch {
          // Sequential fallback
          giftResults = await Promise.all(
            ids.map(id =>
              arcPublicClient.readContract({
                address: addr,
                abi: CHEERS_ABI,
                functionName: 'getGift',
                args: [id],
              }).then(r => r).catch(() => null)
            )
          )
        }

        if (cancelRef.current) return

        // Step 4: fetch creator addresses from GiftCreated events
        const DEPLOYMENT_BLOCK = 26623210n
        const creatorMap: Map<string, `0x${string}`> = new Map()
        const firstIdBig = ids[ids.length - 1]
        const lastIdBig  = ids[0]
        try {
          const logs = await arcPublicClient.getLogs({
            address: addr,
            event: GIFT_CREATED_ABI_ITEM,
            fromBlock: DEPLOYMENT_BLOCK,
            toBlock: 'latest',
          })
          for (const log of logs) {
            const { giftId, creator } = log.args
            if (giftId !== undefined && creator !== undefined
                && giftId >= firstIdBig && giftId <= lastIdBig) {
              creatorMap.set(String(giftId), creator)
            }
          }
        } catch { /* creator map unavailable — continue */ }

        if (cancelRef.current) return

        // Step 5: fetch API metadata
        const metaMap: Map<string, GiftMeta> = new Map()
        if (isApiConfigured()) {
          await Promise.allSettled(
            ids.map(async (id) => {
              try {
                const resp = await apiGetGift(addr, String(id), 0)
                if (resp.gift) metaMap.set(String(id), resp.gift)
              } catch { /* metadata unavailable */ }
            })
          )
        }

        if (cancelRef.current) return

        // Step 6: assemble result
        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        const result: GiftListItem[] = []
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]
          const g = giftResults[i]
          if (!g || g.giftAt === 0n) continue

          const idStr = String(id)
          const meta = metaMap.get(idStr)
          result.push({
            giftId: idStr,
            recipient: g.recipient,
            creator: creatorMap.get(idStr) ?? null,
            giftAt: g.giftAt,
            claimDeadline: g.claimDeadline,
            totalContributed: g.totalContributed,
            phase: derivePhase(g, nowSec),
            pooledDisplay: fmtUsdc(g.totalContributed),
            title: meta?.title ?? null,
            description: meta?.description ?? null,
          })
        }

        if (!cancelRef.current) {
          setGifts(result)
          setDoneTick(loadingTick)
        }
      } catch (err) {
        if (!cancelRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load gifts.')
          setErrorTick(loadingTick)
        }
      }
    }

    void load()
    return () => { cancelRef.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTick])

  return { gifts, state, error, totalOnChain, reload }
}
