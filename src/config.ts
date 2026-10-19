/**
 * wagmi configuration — SignalArc Cheers
 * Target: Arc Mainnet (chain ID 5042) only.
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URL so trace events show the correct chain name immediately.
registerChain(arc.id, arc.rpcUrls.default.http[0])

export const ARC_MAINNET_ID = arc.id

export const config = createConfig({
  chains: [arc, mainnet], // mainnet kept for ENS resolution only
  connectors: [
    injected(),                                    // MetaMask, Rabby, any injected wallet
    coinbaseWallet({ appName: 'SignalArc Cheers' }), // Coinbase Wallet (no WalletConnect needed)
  ],
  transports: {
    [arc.id]: http('https://rpc.mainnet.arc.io'),
    [mainnet.id]: http(), // ENS resolution
  },
})
