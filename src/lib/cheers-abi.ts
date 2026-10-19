/**
 * CheersGiftRegistry ABI — generated from contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json
 *
 * Do not edit by hand. Regenerate by running:
 *   forge build && node -e "const a=require('./contracts/out/CheersGiftRegistry.sol/CheersGiftRegistry.json').abi; require('fs').writeFileSync('./src/lib/cheers-abi.ts', 'export const CHEERS_ABI = '+JSON.stringify(a,null,2)+' as const\n')"
 */

export const CHEERS_ABI = [
  {
    "type": "constructor",
    "inputs": [{ "name": "_usdc", "type": "address", "internalType": "address" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "contribute",
    "inputs": [
      { "name": "giftId", "type": "uint256", "internalType": "uint256" },
      { "name": "amount", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "contributions",
    "inputs": [
      { "name": "", "type": "uint256", "internalType": "uint256" },
      { "name": "", "type": "address", "internalType": "address" }
    ],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "createGift",
    "inputs": [
      { "name": "recipient", "type": "address", "internalType": "address" },
      { "name": "giftAt", "type": "uint256", "internalType": "uint256" },
      { "name": "claimDuration", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getContribution",
    "inputs": [
      { "name": "giftId", "type": "uint256", "internalType": "uint256" },
      { "name": "contributor", "type": "address", "internalType": "address" }
    ],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getGift",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct CheersGiftRegistry.Gift",
        "components": [
          { "name": "recipient",        "type": "address", "internalType": "address" },
          { "name": "giftAt",           "type": "uint256", "internalType": "uint256" },
          { "name": "claimDeadline",    "type": "uint256", "internalType": "uint256" },
          { "name": "totalContributed", "type": "uint256", "internalType": "uint256" },
          { "name": "totalClaimed",     "type": "uint256", "internalType": "uint256" },
          { "name": "totalRefunded",    "type": "uint256", "internalType": "uint256" }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPhase",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [{ "name": "phase", "type": "uint8", "internalType": "uint8" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRemainingBalance",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "gifts",
    "inputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "outputs": [
      { "name": "recipient",        "type": "address", "internalType": "address" },
      { "name": "giftAt",           "type": "uint256", "internalType": "uint256" },
      { "name": "claimDeadline",    "type": "uint256", "internalType": "uint256" },
      { "name": "totalContributed", "type": "uint256", "internalType": "uint256" },
      { "name": "totalClaimed",     "type": "uint256", "internalType": "uint256" },
      { "name": "totalRefunded",    "type": "uint256", "internalType": "uint256" }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextGiftId",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "refund",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "refunded",
    "inputs": [
      { "name": "", "type": "uint256", "internalType": "uint256" },
      { "name": "", "type": "address", "internalType": "address" }
    ],
    "outputs": [{ "name": "", "type": "bool", "internalType": "bool" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdc",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "contract IERC20" }],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ContributionMade",
    "inputs": [
      { "name": "giftId",           "type": "uint256", "indexed": true,  "internalType": "uint256" },
      { "name": "contributor",      "type": "address", "indexed": true,  "internalType": "address" },
      { "name": "amount",           "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "totalContributed", "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ContributorRefunded",
    "inputs": [
      { "name": "giftId",      "type": "uint256", "indexed": true,  "internalType": "uint256" },
      { "name": "contributor", "type": "address", "indexed": true,  "internalType": "address" },
      { "name": "amount",      "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GiftClaimed",
    "inputs": [
      { "name": "giftId",    "type": "uint256", "indexed": true,  "internalType": "uint256" },
      { "name": "recipient", "type": "address", "indexed": true,  "internalType": "address" },
      { "name": "amount",    "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GiftCreated",
    "inputs": [
      { "name": "giftId",        "type": "uint256", "indexed": true,  "internalType": "uint256" },
      { "name": "creator",       "type": "address", "indexed": true,  "internalType": "address" },
      { "name": "recipient",     "type": "address", "indexed": true,  "internalType": "address" },
      { "name": "giftAt",        "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "claimDeadline", "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  { "type": "error", "name": "AlreadyClaimed",              "inputs": [] },
  { "type": "error", "name": "AlreadyRefunded",             "inputs": [] },
  { "type": "error", "name": "ClaimWindowClosed",           "inputs": [] },
  { "type": "error", "name": "ClaimWindowNotOpen",          "inputs": [] },
  { "type": "error", "name": "ContributionWindowClosed",    "inputs": [] },
  {
    "type": "error",
    "name": "GiftDoesNotExist",
    "inputs": [{ "name": "giftId", "type": "uint256", "internalType": "uint256" }]
  },
  { "type": "error", "name": "InvalidClaimDuration",        "inputs": [] },
  { "type": "error", "name": "InvalidGiftAt",               "inputs": [] },
  { "type": "error", "name": "InvalidRecipient",            "inputs": [] },
  { "type": "error", "name": "NotContributor",              "inputs": [] },
  { "type": "error", "name": "NotRecipient",                "inputs": [] },
  { "type": "error", "name": "ReentrancyGuardReentrantCall","inputs": [] },
  { "type": "error", "name": "RefundWindowNotOpen",         "inputs": [] },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }]
  },
  { "type": "error", "name": "ZeroAmount",                  "inputs": [] }
] as const
