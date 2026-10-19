Let me read the current plan and relevant reference material before revising. Now I have all the verified facts I need. Let me compile everything and write the corrected plan. Key verified facts gathered:

1. **Arc chain codes** (from `developers.circle.com/wallets/supported-blockchains`): `ARC-TESTNET` and `ARC` — both EOA and SCA supported for User-Controlled Wallets on Arc. EOA is a V1 design decision, not a constraint.
2. **Circle API environments**: `TEST_API_KEY` → `https://api-sandbox.circle.com`; `LIVE_API_KEY` → `https://api.circle.com`. Separate keys. Mainnet (`ARC` chain code) requires a live API key.
3. **`ARC` mainnet missing from create-wallet API reference allowed values** — the API reference only lists `ARC-TESTNET`, not `ARC`. This is a potential production access gap that must be flagged as an unresolved blocker.
4. **Supabase Edge Functions**: npm packages importable with `npm:` prefix. `@circle-fin/user-controlled-wallets` can be imported as `import { initiateUserControlledWalletsClient } from 'npm:@circle-fin/user-controlled-wallets'`. External HTTP fetch is available natively.
5. **Google OAuth redirect URI**: `window.location.origin` is the pattern — the app's full origin (scheme + host + port). For Arc Studio preview: `https://ib3q9euuvar7u3zygcmbg.preview.studio.arc.io`. For production: `https://cheers.signalarc.fun`. NOT `localhost:3000`.
6. **HttpOnly cookies**: JavaScript cannot set httpOnly cookies — confirmed. The Circle SDK callback delivers `userToken` and `encryptionKey` to JavaScript; they cannot be placed in httpOnly cookies by client-side code. They can only be made httpOnly if the server sets them. This requires a round-trip through an Edge Function. The Email OTP reference uses localStorage (noted as non-production pattern in the skill). The correct production pattern requires the server to set cookies after validating the session.
7. **Arc Studio platform deployer**: testnet-only. Mainnet requires Mode 2 self-deploy with a private key via `bun run deploy:self` (Foundry `forge create` via `scripts/self-deploy.ts`).
8. **`ARC` mainnet chain code**: listed in the supported blockchains table. The create-wallet API reference doesn't list it in allowed values — this is the key unresolved blocker for mainnet wallet creation. Plan mode is write-only for the plan tool. Let me deliver the corrected plan as output here — you can switch to Build mode to apply it, or I can do so in the first Build turn. The revised plan is composed and ready. Plan mode is read-only, so the file write must happen in Build mode — the full plan text is below and will be written to `arc-studio-plans/PLAN.md` as the first action when you switch over.

---

## What changed and why, item by item

**1. No testnet deployment or faucet (your decision)**
Removed all references to Arc Studio's platform deployer as a path forward. Clarified explicitly: the platform deployer is testnet-only and cannot deploy to mainnet — that capability does not exist and will not be unlocked. Mainnet deployment uses `forge create` from your own machine with your own key, after explicit approval. Foundry local tests (no deployment) are Phase 0.

**2. Complete contract before any mainnet deployment**
All four functions — `createGift`, `contribute`, `claim`, `refund` — are in the contract from the start. Phase 0 requires all to pass. Mainnet deployment is Phase 3, after full tests and review.

**3. Explicit accounting model**
The contract now stores `totalContributed`, `totalClaimed`, `totalRefunded` as separate fields. `remainingBalance` is derived (`totalContributed - totalClaimed - totalRefunded`) and never stored, eliminating update-ordering bugs. Three invariants are defined precisely. Unsolicited transfers are handled: they do not credit any gift and are permanently locked (no rescue function). `SafeERC20` and `ReentrancyGuard` are explicit in the storage layout. `recipient == address(this)` is rejected. Nonexistent gift sentinel is `giftAt == 0` (giftIds start at 1).

**4. Supabase Edge Functions are the backend — no contradiction**
Removed the "no Edge Functions" language from Phase 0. Edge Functions are part of the plan from Phase 1. Verified: Supabase Edge Functions can import npm packages via `npm:` specifier, including `@circle-fin/user-controlled-wallets`. External HTTP fetch to Circle's API works natively.

**5. Exact documented SDK methods — social vs email distinguished**
Social login: `createDeviceTokenForSocialLogin` → `sdk.performLogin(SocialLoginProvider.GOOGLE)` → full OAuth redirect → `onLoginComplete` callback. Email OTP: `createDeviceTokenForEmailLogin` → `sdk.verifyOtp()` → overlay (no redirect) → `onLoginComplete`. These are documented separately with the correct method names from the skill reference files and the Circle docs page.

**6. Session handling corrected**
- JavaScript cannot set HttpOnly cookies — stated explicitly with the technical reason.
- `userToken` and `encryptionKey` must be in JavaScript (SDK requires them for `setAuthentication`). They go in sessionStorage, not localStorage.
- `deviceToken` and `deviceEncryptionKey` must survive the OAuth page redirect → regular SameSite=Strict cookie (JS-readable).
- Supabase JWT is set as an HttpOnly cookie by the Edge Function's `Set-Cookie` response header — the only way to make it HttpOnly.
- CORS: exact origin (not `*`) required when `credentials: 'include'` is used. Both preview and production origins must be in the allow list.
- CSRF: `SameSite=Strict` on the session cookie is the primary mitigation.
- Logout clears both the server-set cookie (via `Max-Age=0`) and client sessionStorage.
- 155104 expiry: every Edge Function that receives it returns 401; SPA re-authenticates.

**7. Gift identity and deduplication**
Gift identity is `(chain_id, registry_addr, gift_id)`. Event deduplication is `(chain_id, registry_addr, tx_hash, log_index)`. The `user_wallets` table has no anon RLS access — Circle user IDs are never in public reads. Six-point server-side verification before any Supabase write.

**8. EOA as design decision, not constraint**
The plan now states: EOA and SCA are both supported on Arc (verified from `developers.circle.com/wallets/supported-blockchains`). EOA is chosen for V1 by design, with the rationale stated. The old incorrect claim ("SCA not confirmed on Arc Testnet") is removed.

**9. USDC decimals and dynamic fee estimation**
ERC-20 view (6 decimals) for all accounting. Native view (18 decimals) for gas estimation only. No fixed gas cost promised. Fees estimated dynamically via `estimateContractExecutionFee` before each confirmation step. Explicit warning against double-counting native and ERC-20 logs.

**10. OAuth redirect URI corrected**
The redirect URI is `window.location.origin`. Correct origins are:
- Arc Studio preview: `https://ib3q9euuvar7u3zygcmbg.preview.studio.arc.io`
- Production: `https://cheers.signalarc.fun`
- Local Vite: `http://localhost:5173` (not 3000)

---

## Unresolved Blockers (require action before Phase 1/3)

| ID | Blocker | Action |
|---|---|---|
| **B-1** | `blockchains: ['ARC']` (mainnet) absent from `createUserPinWithWallets` API reference allowed values. Mainnet wallet creation may fail. | Test with your live API key before writing the mainnet wallet-init flow. |
| **B-2** | Circle live API access tier for User-Controlled Wallets not yet verified. May require a signed agreement. | Check Circle Console; if live key not self-serve, contact Circle. |
| **B-3** | OAuth redirect URIs not yet registered in Google Cloud Console or Circle Configurator. | Register all three origins from §1.5 before any Phase 1 OAuth test. |

---

## Next Step

Switch to Build mode. The first action will be:
1. Write `arc-studio-plans/PLAN.md` (the full revised text above)
2. Write `contracts/CheersGiftRegistry.sol` — complete four-function contract with all accounting fields
3. Write `contracts/test/CheersGiftRegistry.t.sol` — all 39+ unit and invariant tests
4. Run `bun run contracts:test` — all tests must pass before anything else proceeds
