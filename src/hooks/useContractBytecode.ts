/**
 * useContractBytecode — verify that the configured registry address has
 * bytecode on Arc Mainnet before enabling write calls.
 *
 * Returns: 'idle' | 'checking' | 'ok' | 'empty' | 'error'
 *
 * This hook only fires an RPC call when a non-null address is provided.
 * The result is cached in state and re-checked if the address changes.
 */

import { useState, useEffect } from 'react'
import { createPublicClient, http } from 'viem'
import { arc } from 'viem/chains'

export type BytecodeStatus = 'idle' | 'checking' | 'ok' | 'empty' | 'error'

const client = createPublicClient({
  chain: arc,
  transport: http('https://rpc.mainnet.arc.io'),
})

type Result = { addr: string; status: 'ok' | 'empty' | 'error' }

export function useContractBytecode(address: `0x${string}` | null): BytecodeStatus {
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    // null address: nothing to check; prior result stays until next non-null address
    if (!address) return

    let cancelled = false

    client.getCode({ address })
      .then((code) => {
        if (!cancelled) {
          setResult({ addr: address, status: !code || code === '0x' || code.length < 6 ? 'empty' : 'ok' })
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ addr: address, status: 'error' })
      })

    return () => { cancelled = true }
  }, [address])

  if (!address) return 'idle'
  if (!result || result.addr !== address) return 'checking'
  return result.status
}
