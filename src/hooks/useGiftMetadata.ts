/**
 * useGiftMetadata — fetch gift metadata and contributions from the backend.
 *
 * Loads once on mount (and on registry/giftId change or manual reload).
 * Returns the GiftMeta record (title, description, target) and all
 * contributions (paginated internally).
 *
 * Missing metadata (404) does NOT mean the on-chain gift is nonexistent.
 * The hook returns { meta: null, metaMissing: true } in that case; callers
 * continue showing contract data and offer creator recovery.
 *
 * Amounts are kept as raw strings; callers use BigInt() to convert.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  apiGetAllContributions,
  isApiConfigured,
  ApiError,
  type GiftMeta,
  type ContributionMeta,
} from '../lib/cheers-api'

export type MetaLoadState = 'idle' | 'loading' | 'loaded' | 'error'

interface FetchResult {
  meta: GiftMeta | null
  contributions: ContributionMeta[]
  metaMissing: boolean
  errorMessage: string | null
  tick: number
}

export interface GiftMetadataResult {
  meta: GiftMeta | null
  contributions: ContributionMeta[]
  state: MetaLoadState
  errorMessage: string | null
  /** true when the API returned 404 gift_metadata_missing */
  metaMissing: boolean
  reload: () => void
}

export function useGiftMetadata(
  registry: string | null,
  giftId: string,
): GiftMetadataResult {
  const [tick, setTick]             = useState(0)
  const [loadingTick, setLoadingTick] = useState<number | null>(null)
  const [result, setResult]         = useState<FetchResult | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)

  const reload = useCallback(() => setTick(t => t + 1), [])

  // Start a fetch whenever tick changes and API is configured
  useEffect(() => {
    if (!registry || !isApiConfigured()) return
    setLoadingTick(tick)  // marks that this tick is being loaded
  }, [registry, giftId, tick])

  // Perform the actual async fetch when loadingTick is set
  useEffect(() => {
    if (loadingTick === null || !registry || !isApiConfigured()) return

    let cancelled = false

    const run = async () => {
      try {
        const { gift, contributions: contribs } = await apiGetAllContributions(registry, giftId)
        if (cancelled) return
        setFatalError(null)
        setResult({
          meta: gift,
          contributions: contribs,
          metaMissing: gift === null,
          errorMessage: null,
          tick: loadingTick,
        })
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          setFatalError(null)
          setResult({ meta: null, contributions: [], metaMissing: true, errorMessage: null, tick: loadingTick })
          return
        }
        const msg = err instanceof ApiError ? err.message
          : err instanceof Error ? err.message
          : 'Failed to load gift details.'
        setFatalError(msg)
        setResult(null)
      }
    }

    void run()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTick])

  // Derive state from the loading/result relationship
  const isLoading = loadingTick !== null && (result === null || result.tick !== loadingTick) && fatalError === null
  const state: MetaLoadState =
    !registry || !isApiConfigured()  ? 'idle'
    : fatalError                     ? 'error'
    : isLoading                      ? 'loading'
    : result !== null                ? 'loaded'
    :                                  'idle'

  return {
    meta:         result?.meta         ?? null,
    contributions: result?.contributions ?? [],
    state,
    errorMessage: fatalError,
    metaMissing:  result?.metaMissing  ?? false,
    reload,
  }
}
