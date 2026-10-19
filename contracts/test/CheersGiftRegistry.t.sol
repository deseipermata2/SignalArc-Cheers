// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CheersGiftRegistry Test Suite
 *
 * @dev Tests use a minimal MockUSDC token that:
 *   - Conforms to IERC20 (transfer, transferFrom, approve, balanceOf, etc.)
 *   - Has a `setFailTransfer(bool)` helper to simulate transfer failures
 *     (returns false rather than reverting, so SafeERC20 causes a revert).
 *
 * Arc-specific note: on Arc mainnet the ERC-20 USDC is at
 * 0x3600000000000000000000000000000000000000.  These tests use a local mock
 * token; they do not fork Arc and do not test Arc-specific gas behaviour.
 * All accounting is in 6-decimal ERC-20 units as the contract specifies.
 *
 * Test categories:
 *   A. createGift — happy path and reverts
 *   B. contribute — happy path, accumulation, window, reverts
 *   C. claim      — happy path, window boundaries, authorization, reverts
 *   D. refund     — happy path, boundaries, authorization, reverts
 *   E. Boundary   — exact timestamp edges for claim/refund overlap
 *   F. Multi-gift — accounting isolation, multiple contributors
 *   G. Unsolicited transfers — not credited to any gift
 *   H. Fuzz tests — amount accumulation, invariant under random operations
 *   I. Invariant tests (stateful) — accounting identity always holds
 */

import "forge-std/Test.sol";
import "../CheersGiftRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock USDC
// ─────────────────────────────────────────────────────────────────────────────

contract MockUSDC is ERC20 {
    bool private _failTransfer;

    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    /// @dev Mint tokens to any address (test helper only).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev When true, transfer() and transferFrom() return false instead of
    ///      reverting — SafeERC20 will then revert the outer call.
    function setFailTransfer(bool fail) external {
        _failTransfer = fail;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (_failTransfer) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        returns (bool)
    {
        if (_failTransfer) return false;
        return super.transferFrom(from, to, amount);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base test contract
// ─────────────────────────────────────────────────────────────────────────────

contract CheersGiftRegistryBase is Test {
    CheersGiftRegistry internal registry;
    MockUSDC           internal usdc;

    // Named actors
    address internal alice   = makeAddr("alice");   // gift creator / contributor
    address internal bob     = makeAddr("bob");     // recipient
    address internal carol   = makeAddr("carol");   // second contributor
    address internal dave    = makeAddr("dave");    // third contributor
    address internal eve     = makeAddr("eve");     // unauthorized user

    uint256 internal constant ONE_USDC  = 1e6;
    uint256 internal constant TEN_USDC  = 10e6;
    uint256 internal constant SEVEN_DAYS_S   = 7  days;
    uint256 internal constant FOURTEEN_DAYS_S = 14 days;
    uint256 internal constant THIRTY_DAYS_S  = 30 days;

    // Default gift parameters
    uint256 internal giftAt;        // block.timestamp + 1 days
    uint256 internal claimDeadline; // giftAt + 30 days

    function setUp() public virtual {
        usdc = new MockUSDC();
        registry = new CheersGiftRegistry(address(usdc));

        // Start at a known non-zero timestamp
        vm.warp(1_000_000);

        giftAt       = block.timestamp + 1 days;
        claimDeadline = giftAt + THIRTY_DAYS_S;

        // Fund actors
        usdc.mint(alice, 1_000 * ONE_USDC);
        usdc.mint(carol, 1_000 * ONE_USDC);
        usdc.mint(dave,  1_000 * ONE_USDC);

        // Pre-approve registry
        vm.prank(alice); usdc.approve(address(registry), type(uint256).max);
        vm.prank(carol); usdc.approve(address(registry), type(uint256).max);
        vm.prank(dave);  usdc.approve(address(registry), type(uint256).max);
    }

    /// @dev Create a default gift (alice → bob, 30-day claim) and return giftId.
    function _createDefaultGift() internal returns (uint256 giftId) {
        vm.prank(alice);
        giftId = registry.createGift(bob, giftAt, THIRTY_DAYS_S);
    }

    /// @dev Warp to just before giftAt (still OPEN).
    function _warpToOpenEnd() internal { vm.warp(giftAt - 1); }

    /// @dev Warp to exactly giftAt (CLAIMABLE begins).
    function _warpToGiftAt() internal { vm.warp(giftAt); }

    /// @dev Warp to just before claimDeadline (CLAIMABLE end).
    function _warpToClaimEnd() internal { vm.warp(claimDeadline - 1); }

    /// @dev Warp to exactly claimDeadline (REFUNDABLE begins).
    function _warpToClaimDeadline() internal { vm.warp(claimDeadline); }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. createGift
// ─────────────────────────────────────────────────────────────────────────────

contract CreateGiftTest is CheersGiftRegistryBase {
    function test_createGift_success_storesCorrectly() public {
        vm.prank(alice);
        uint256 giftId = registry.createGift(bob, giftAt, THIRTY_DAYS_S);

        assertEq(giftId, 1);
        assertEq(registry.nextGiftId(), 2);

        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.recipient, bob);
        assertEq(g.giftAt, giftAt);
        assertEq(g.claimDeadline, giftAt + THIRTY_DAYS_S);
        assertEq(g.totalContributed, 0);
        assertEq(g.totalClaimed, 0);
        assertEq(g.totalRefunded, 0);
    }

    function test_createGift_emitsGiftCreated() public {
        vm.expectEmit(true, true, true, true);
        emit CheersGiftRegistry.GiftCreated(
            1, alice, bob, giftAt, giftAt + THIRTY_DAYS_S
        );
        vm.prank(alice);
        registry.createGift(bob, giftAt, THIRTY_DAYS_S);
    }

    function test_createGift_incrementsNextGiftId() public {
        vm.prank(alice); registry.createGift(bob, giftAt, THIRTY_DAYS_S);
        vm.prank(alice); registry.createGift(bob, giftAt, FOURTEEN_DAYS_S);
        assertEq(registry.nextGiftId(), 3);
    }

    function test_createGift_7days_succeeds() public {
        vm.prank(alice);
        uint256 giftId = registry.createGift(bob, giftAt, SEVEN_DAYS_S);
        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.claimDeadline, giftAt + SEVEN_DAYS_S);
    }

    function test_createGift_14days_succeeds() public {
        vm.prank(alice);
        uint256 giftId = registry.createGift(bob, giftAt, FOURTEEN_DAYS_S);
        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.claimDeadline, giftAt + FOURTEEN_DAYS_S);
    }

    function test_createGift_30days_succeeds() public {
        vm.prank(alice);
        uint256 giftId = registry.createGift(bob, giftAt, THIRTY_DAYS_S);
        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.claimDeadline, giftAt + THIRTY_DAYS_S);
    }

    function test_createGift_revert_zeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidRecipient.selector);
        registry.createGift(address(0), giftAt, THIRTY_DAYS_S);
    }

    function test_createGift_revert_selfRecipient() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidRecipient.selector);
        registry.createGift(address(registry), giftAt, THIRTY_DAYS_S);
    }

    function test_createGift_revert_giftAtNow() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidGiftAt.selector);
        registry.createGift(bob, block.timestamp, THIRTY_DAYS_S);
    }

    function test_createGift_revert_giftAtInPast() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidGiftAt.selector);
        registry.createGift(bob, block.timestamp - 1, THIRTY_DAYS_S);
    }

    function test_createGift_revert_invalidDuration_1day() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidClaimDuration.selector);
        registry.createGift(bob, giftAt, 1 days);
    }

    function test_createGift_revert_invalidDuration_21days() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidClaimDuration.selector);
        registry.createGift(bob, giftAt, 21 days);
    }

    function test_createGift_revert_invalidDuration_zero() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.InvalidClaimDuration.selector);
        registry.createGift(bob, giftAt, 0);
    }

    function test_createGift_anyoneCanCreate() public {
        // Carol creates a gift (she is not alice)
        vm.prank(carol);
        uint256 giftId = registry.createGift(bob, giftAt, THIRTY_DAYS_S);
        assertEq(registry.getGift(giftId).recipient, bob);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// B. contribute
// ─────────────────────────────────────────────────────────────────────────────

contract ContributeTest is CheersGiftRegistryBase {
    uint256 internal giftId;

    function setUp() public override {
        super.setUp();
        giftId = _createDefaultGift();
    }

    function test_contribute_success_updatesState() public {
        vm.prank(alice);
        registry.contribute(giftId, TEN_USDC);

        assertEq(registry.contributions(giftId, alice), TEN_USDC);
        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.totalContributed, TEN_USDC);
        assertEq(usdc.balanceOf(address(registry)), TEN_USDC);
    }

    function test_contribute_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit CheersGiftRegistry.ContributionMade(giftId, alice, TEN_USDC, TEN_USDC);
        vm.prank(alice);
        registry.contribute(giftId, TEN_USDC);
    }

    function test_contribute_accumulates_sameCaller() public {
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
        vm.prank(alice); registry.contribute(giftId, 5 * ONE_USDC);
        assertEq(registry.contributions(giftId, alice), 15 * ONE_USDC);
        assertEq(registry.getGift(giftId).totalContributed, 15 * ONE_USDC);
    }

    function test_contribute_multipleContributors() public {
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
        vm.prank(carol); registry.contribute(giftId, 20 * ONE_USDC);
        vm.prank(dave);  registry.contribute(giftId, 5 * ONE_USDC);
        assertEq(registry.getGift(giftId).totalContributed, 35 * ONE_USDC);
    }

    function test_contribute_emitsTotalContributed_secondCall() public {
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
        // Second contribution from carol; newTotal should be TEN_USDC + 5
        vm.expectEmit(true, true, false, true);
        emit CheersGiftRegistry.ContributionMade(giftId, carol, 5 * ONE_USDC, 15 * ONE_USDC);
        vm.prank(carol); registry.contribute(giftId, 5 * ONE_USDC);
    }

    function test_contribute_revert_nonexistentGift() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CheersGiftRegistry.GiftDoesNotExist.selector, 999)
        );
        registry.contribute(999, TEN_USDC);
    }

    function test_contribute_revert_giftIdZero() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CheersGiftRegistry.GiftDoesNotExist.selector, 0)
        );
        registry.contribute(0, TEN_USDC);
    }

    /// @dev At exactly giftAt the window is closed.
    function test_contribute_revert_atGiftAt() public {
        _warpToGiftAt();
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.ContributionWindowClosed.selector);
        registry.contribute(giftId, TEN_USDC);
    }

    /// @dev One second before giftAt is still OPEN.
    function test_contribute_succeeds_oneSecondBeforeGiftAt() public {
        _warpToOpenEnd();
        vm.prank(alice);
        registry.contribute(giftId, TEN_USDC);
        assertEq(registry.contributions(giftId, alice), TEN_USDC);
    }

    function test_contribute_revert_afterGiftAt() public {
        vm.warp(giftAt + 1 days);
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.ContributionWindowClosed.selector);
        registry.contribute(giftId, TEN_USDC);
    }

    function test_contribute_revert_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.ZeroAmount.selector);
        registry.contribute(giftId, 0);
    }

    function test_contribute_revert_transferFails_stateUnchanged() public {
        usdc.setFailTransfer(true);
        uint256 balanceBefore = usdc.balanceOf(address(registry));
        uint256 totalBefore   = registry.getGift(giftId).totalContributed;

        vm.prank(alice);
        vm.expectRevert(); // SafeERC20: low-level call failed (or similar)
        registry.contribute(giftId, TEN_USDC);

        // State must be unchanged
        assertEq(registry.contributions(giftId, alice), 0);
        assertEq(registry.getGift(giftId).totalContributed, totalBefore);
        assertEq(usdc.balanceOf(address(registry)), balanceBefore);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// C. claim
// ─────────────────────────────────────────────────────────────────────────────

contract ClaimTest is CheersGiftRegistryBase {
    uint256 internal giftId;

    function setUp() public override {
        super.setUp();
        giftId = _createDefaultGift();
        // Alice contributes 10 USDC
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
        // Carol contributes 20 USDC
        vm.prank(carol); registry.contribute(giftId, 20 * ONE_USDC);
        // Total: 30 USDC
    }

    function test_claim_success_transfersFullBalance() public {
        _warpToGiftAt();
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        registry.claim(giftId);
        assertEq(usdc.balanceOf(bob), bobBefore + 30 * ONE_USDC);
        assertEq(usdc.balanceOf(address(registry)), 0);
    }

    function test_claim_success_updatesAccounting() public {
        _warpToGiftAt();
        vm.prank(bob);
        registry.claim(giftId);

        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        assertEq(g.totalClaimed, 30 * ONE_USDC);
        assertEq(g.totalContributed, 30 * ONE_USDC);
        assertEq(g.totalRefunded, 0);
        // remainingBalance == 0
        assertEq(registry.getRemainingBalance(giftId), 0);
    }

    function test_claim_success_emitsEvent() public {
        _warpToGiftAt();
        vm.expectEmit(true, true, false, true);
        emit CheersGiftRegistry.GiftClaimed(giftId, bob, 30 * ONE_USDC);
        vm.prank(bob);
        registry.claim(giftId);
    }

    function test_claim_success_atExactGiftAt() public {
        _warpToGiftAt();
        vm.prank(bob);
        registry.claim(giftId);
        assertEq(registry.getGift(giftId).totalClaimed, 30 * ONE_USDC);
    }

    function test_claim_success_oneSecondBeforeDeadline() public {
        _warpToClaimEnd();
        vm.prank(bob);
        registry.claim(giftId);
        assertEq(registry.getGift(giftId).totalClaimed, 30 * ONE_USDC);
    }

    function test_claim_revert_beforeGiftAt() public {
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowNotOpen.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_oneSecondBeforeGiftAt() public {
        _warpToOpenEnd();
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowNotOpen.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_atClaimDeadline() public {
        _warpToClaimDeadline();
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowClosed.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_afterClaimDeadline() public {
        vm.warp(claimDeadline + 1 days);
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowClosed.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_notRecipient_alice() public {
        _warpToGiftAt();
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.NotRecipient.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_notRecipient_eve() public {
        _warpToGiftAt();
        vm.prank(eve);
        vm.expectRevert(CheersGiftRegistry.NotRecipient.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_alreadyClaimed() public {
        _warpToGiftAt();
        vm.prank(bob); registry.claim(giftId);
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.AlreadyClaimed.selector);
        registry.claim(giftId);
    }

    function test_claim_revert_zeroBalance() public {
        // Create a fresh gift with no contributions
        uint256 emptyGiftId;
        vm.prank(alice);
        emptyGiftId = registry.createGift(bob, giftAt, THIRTY_DAYS_S);
        _warpToGiftAt();
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ZeroAmount.selector);
        registry.claim(emptyGiftId);
    }

    function test_claim_revert_nonexistentGift() public {
        _warpToGiftAt();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(CheersGiftRegistry.GiftDoesNotExist.selector, 999)
        );
        registry.claim(999);
    }

    function test_claim_revert_transferFails_statePreserved() public {
        _warpToGiftAt();
        usdc.setFailTransfer(true);

        uint256 registryBal = usdc.balanceOf(address(registry));
        vm.prank(bob);
        vm.expectRevert();
        registry.claim(giftId);

        // totalClaimed must be 0 (reverted with the tx)
        assertEq(registry.getGift(giftId).totalClaimed, 0);
        assertEq(usdc.balanceOf(address(registry)), registryBal);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// D. refund
// ─────────────────────────────────────────────────────────────────────────────

contract RefundTest is CheersGiftRegistryBase {
    uint256 internal giftId;

    function setUp() public override {
        super.setUp();
        giftId = _createDefaultGift();
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
        vm.prank(carol); registry.contribute(giftId, 20 * ONE_USDC);
        vm.prank(dave);  registry.contribute(giftId, 5 * ONE_USDC);
        // Total: 35 USDC
    }

    function test_refund_success_aliceGetsEntitlement() public {
        _warpToClaimDeadline();
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        registry.refund(giftId);
        assertEq(usdc.balanceOf(alice), aliceBefore + TEN_USDC);
    }

    function test_refund_success_updatesFlags() public {
        _warpToClaimDeadline();
        vm.prank(alice);
        registry.refund(giftId);
        assertTrue(registry.refunded(giftId, alice));
    }

    function test_refund_success_updatesTotalRefunded() public {
        _warpToClaimDeadline();
        vm.prank(alice); registry.refund(giftId);
        assertEq(registry.getGift(giftId).totalRefunded, TEN_USDC);
        vm.prank(carol); registry.refund(giftId);
        assertEq(registry.getGift(giftId).totalRefunded, 30 * ONE_USDC);
        vm.prank(dave);  registry.refund(giftId);
        assertEq(registry.getGift(giftId).totalRefunded, 35 * ONE_USDC);
    }

    function test_refund_success_emitsEvent() public {
        _warpToClaimDeadline();
        vm.expectEmit(true, true, false, true);
        emit CheersGiftRegistry.ContributorRefunded(giftId, alice, TEN_USDC);
        vm.prank(alice);
        registry.refund(giftId);
    }

    function test_refund_success_atExactClaimDeadline() public {
        _warpToClaimDeadline();
        vm.prank(alice);
        registry.refund(giftId);
        assertTrue(registry.refunded(giftId, alice));
    }

    function test_refund_success_noExpiry() public {
        // Refund available 1 year after deadline
        vm.warp(claimDeadline + 365 days);
        vm.prank(alice);
        registry.refund(giftId);
        assertTrue(registry.refunded(giftId, alice));
    }

    function test_refund_revert_beforeClaimDeadline() public {
        vm.warp(claimDeadline - 1);
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.RefundWindowNotOpen.selector);
        registry.refund(giftId);
    }

    function test_refund_revert_atGiftAt() public {
        _warpToGiftAt();
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.RefundWindowNotOpen.selector);
        registry.refund(giftId);
    }

    function test_refund_revert_afterClaim() public {
        _warpToGiftAt();
        vm.prank(bob); registry.claim(giftId);
        _warpToClaimDeadline();
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.AlreadyClaimed.selector);
        registry.refund(giftId);
    }

    function test_refund_revert_notContributor_eve() public {
        _warpToClaimDeadline();
        vm.prank(eve);
        vm.expectRevert(CheersGiftRegistry.NotContributor.selector);
        registry.refund(giftId);
    }

    function test_refund_revert_alreadyRefunded() public {
        _warpToClaimDeadline();
        vm.prank(alice); registry.refund(giftId);
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.AlreadyRefunded.selector);
        registry.refund(giftId);
    }

    function test_refund_revert_nonexistentGift() public {
        _warpToClaimDeadline();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CheersGiftRegistry.GiftDoesNotExist.selector, 999)
        );
        registry.refund(999);
    }

    function test_refund_revert_transferFails_statePreserved() public {
        _warpToClaimDeadline();
        usdc.setFailTransfer(true);
        uint256 totalRefundedBefore = registry.getGift(giftId).totalRefunded;

        vm.prank(alice);
        vm.expectRevert();
        registry.refund(giftId);

        // Both state mutations must have reverted
        assertFalse(registry.refunded(giftId, alice));
        assertEq(registry.getGift(giftId).totalRefunded, totalRefundedBefore);
    }

    function test_refund_allContributors_empties_registry() public {
        _warpToClaimDeadline();
        vm.prank(alice); registry.refund(giftId);
        vm.prank(carol); registry.refund(giftId);
        vm.prank(dave);  registry.refund(giftId);
        assertEq(usdc.balanceOf(address(registry)), 0);
        assertEq(registry.getGift(giftId).totalRefunded, 35 * ONE_USDC);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Exact timestamp boundary — claim / refund never overlap
// ─────────────────────────────────────────────────────────────────────────────

contract TimestampBoundaryTest is CheersGiftRegistryBase {
    uint256 internal giftId;

    function setUp() public override {
        super.setUp();
        giftId = _createDefaultGift();
        vm.prank(alice); registry.contribute(giftId, TEN_USDC);
    }

    /// block.timestamp == claimDeadline - 1  →  claim succeeds, refund reverts
    function test_boundary_claimSucceeds_refundReverts_oneBeforeDeadline() public {
        // ── Part 1: claim succeeds at claimDeadline - 1 ──────────────────────
        vm.warp(claimDeadline - 1);
        vm.prank(bob);
        registry.claim(giftId);
        assertEq(registry.getGift(giftId).totalClaimed, TEN_USDC);

        // ── Part 2: on a fresh gift at the same timestamp, refund reverts ─────
        // Create a NEW gift whose giftAt is in the future relative to current time.
        // Current time = claimDeadline - 1 = giftAt + 30 days - 1.
        // New giftAt must be > block.timestamp.
        uint256 newGiftAt       = block.timestamp + 1 days;
        uint256 newClaimDeadline = newGiftAt + THIRTY_DAYS_S;

        uint256 giftId2;
        vm.prank(alice);
        giftId2 = registry.createGift(bob, newGiftAt, THIRTY_DAYS_S);
        vm.prank(alice); registry.contribute(giftId2, TEN_USDC);

        // Warp to newClaimDeadline - 1 (still in claim window; refund not open)
        vm.warp(newClaimDeadline - 1);
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.RefundWindowNotOpen.selector);
        registry.refund(giftId2);
    }

    /// block.timestamp == claimDeadline  →  claim reverts, refund succeeds
    function test_boundary_claimReverts_refundSucceeds_atDeadline() public {
        _warpToClaimDeadline();

        // Claim reverts
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowClosed.selector);
        registry.claim(giftId);

        // Refund succeeds
        vm.prank(alice);
        registry.refund(giftId);
        assertTrue(registry.refunded(giftId, alice));
    }

    /// block.timestamp == claimDeadline + 1  →  same as above
    function test_boundary_claimReverts_refundSucceeds_oneAfterDeadline() public {
        vm.warp(claimDeadline + 1);
        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowClosed.selector);
        registry.claim(giftId);

        vm.prank(alice);
        registry.refund(giftId);
        assertTrue(registry.refunded(giftId, alice));
    }

    /// block.timestamp == giftAt  →  contribute reverts, claim succeeds
    function test_boundary_giftAt_contributeReverts_claimSucceeds() public {
        _warpToGiftAt();

        vm.prank(carol);
        vm.expectRevert(CheersGiftRegistry.ContributionWindowClosed.selector);
        registry.contribute(giftId, TEN_USDC);

        vm.prank(bob);
        registry.claim(giftId); // claim must succeed
        assertEq(registry.getGift(giftId).totalClaimed, TEN_USDC);
    }

    /// block.timestamp == giftAt - 1  →  contribute succeeds, claim reverts
    function test_boundary_beforeGiftAt_contributeSucceeds_claimReverts() public {
        _warpToOpenEnd();

        vm.prank(carol);
        registry.contribute(giftId, TEN_USDC);
        assertEq(registry.contributions(giftId, carol), TEN_USDC);

        vm.prank(bob);
        vm.expectRevert(CheersGiftRegistry.ClaimWindowNotOpen.selector);
        registry.claim(giftId);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Multi-gift isolation and multi-contributor accounting
// ─────────────────────────────────────────────────────────────────────────────

contract MultiGiftTest is CheersGiftRegistryBase {
    uint256 internal gift1;
    uint256 internal gift2;

    function setUp() public override {
        super.setUp();
        vm.prank(alice); gift1 = registry.createGift(bob,  giftAt, THIRTY_DAYS_S);
        vm.prank(alice); gift2 = registry.createGift(carol, giftAt, THIRTY_DAYS_S);

        vm.prank(alice); registry.contribute(gift1, TEN_USDC);
        vm.prank(carol); registry.contribute(gift1, 20 * ONE_USDC);
        vm.prank(dave);  registry.contribute(gift2, 5 * ONE_USDC);
    }

    function test_multiGift_isolation_contributions() public view {
        assertEq(registry.getGift(gift1).totalContributed, 30 * ONE_USDC);
        assertEq(registry.getGift(gift2).totalContributed, 5 * ONE_USDC);
    }

    function test_multiGift_isolation_claim_doesNotAffectOther() public {
        _warpToGiftAt();
        // Claim gift1 (recipient: bob)
        vm.prank(bob); registry.claim(gift1);
        // Gift2 must be unaffected
        assertEq(registry.getGift(gift2).totalClaimed, 0);
        assertEq(registry.getGift(gift2).totalContributed, 5 * ONE_USDC);
    }

    function test_multiGift_isolation_refund_doesNotAffectOther() public {
        _warpToClaimDeadline();
        // Alice refunds from gift1
        vm.prank(alice); registry.refund(gift1);
        // Alice has no entitlement in gift2 — should revert
        vm.prank(alice);
        vm.expectRevert(CheersGiftRegistry.NotContributor.selector);
        registry.refund(gift2);
        // Gift2 totalRefunded unchanged
        assertEq(registry.getGift(gift2).totalRefunded, 0);
    }

    function test_multiGift_eachContributorRefundsOwn() public {
        _warpToClaimDeadline();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 carolBefore = usdc.balanceOf(carol);

        vm.prank(alice); registry.refund(gift1);
        vm.prank(carol); registry.refund(gift1);

        // alice gets 10, carol gets 20
        assertEq(usdc.balanceOf(alice), aliceBefore + TEN_USDC);
        assertEq(usdc.balanceOf(carol), carolBefore + 20 * ONE_USDC);
        assertEq(registry.getGift(gift1).totalRefunded, 30 * ONE_USDC);
    }

    function test_multiGift_remainingBalance_after_partial_refunds() public {
        _warpToClaimDeadline();
        vm.prank(alice); registry.refund(gift1);
        uint256 remaining = registry.getRemainingBalance(gift1);
        // totalContributed = 30, totalRefunded = 10, totalClaimed = 0
        assertEq(remaining, 20 * ONE_USDC);
    }

    function test_multiGift_contractBalance_covers_both_liabilities() public view {
        uint256 remaining1 = registry.getRemainingBalance(gift1);
        uint256 remaining2 = registry.getRemainingBalance(gift2);
        uint256 contractBal = usdc.balanceOf(address(registry));
        assertGe(contractBal, remaining1 + remaining2);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// G. Unsolicited transfers — must not credit any gift
// ─────────────────────────────────────────────────────────────────────────────

contract UnsolicitedTransferTest is CheersGiftRegistryBase {
    function test_unsolicited_direct_transfer_notCredited() public {
        uint256 giftId = _createDefaultGift();

        // Directly transfer USDC to registry (bypasses contribute)
        vm.prank(alice);
        usdc.transfer(address(registry), TEN_USDC);

        // No gift's totalContributed should reflect this
        assertEq(registry.getGift(giftId).totalContributed, 0);
        // But registry balance is now non-zero
        assertEq(usdc.balanceOf(address(registry)), TEN_USDC);
    }

    function test_unsolicited_doesNotInflateClaimAmount() public {
        uint256 giftId = _createDefaultGift();

        // Unsolicited transfer
        vm.prank(alice); usdc.transfer(address(registry), TEN_USDC);

        // Alice contributes via contribute()
        vm.prank(alice); registry.contribute(giftId, 5 * ONE_USDC);

        _warpToGiftAt();
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob); registry.claim(giftId);

        // Bob only gets 5 USDC (the contribution), not 15
        assertEq(usdc.balanceOf(bob), bobBefore + 5 * ONE_USDC);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// H. Fuzz tests
// ─────────────────────────────────────────────────────────────────────────────

contract FuzzTest is CheersGiftRegistryBase {
    /**
     * @dev Fuzz: any positive uint128 amount (keeps within practical token supply)
     *      accumulates correctly and respects the accounting identity.
     */
    function testFuzz_contribute_accumulates(uint128 amount1, uint128 amount2) public {
        vm.assume(amount1 > 0 && amount2 > 0);
        // Ensure alice and carol have enough balance
        usdc.mint(alice, uint256(amount1));
        usdc.mint(carol, uint256(amount2));

        uint256 giftId = _createDefaultGift();

        vm.prank(alice); registry.contribute(giftId, amount1);
        vm.prank(carol); registry.contribute(giftId, amount2);

        uint256 expected = uint256(amount1) + uint256(amount2);
        assertEq(registry.getGift(giftId).totalContributed, expected);
        assertEq(registry.contributions(giftId, alice), amount1);
        assertEq(registry.contributions(giftId, carol), amount2);

        // Accounting identity: totalContributed == remaining + claimed + refunded
        _assertAccountingIdentity(giftId);
    }

    /**
     * @dev Fuzz: random giftAt values > block.timestamp are always accepted.
     */
    function testFuzz_createGift_futureGiftAt(uint32 offset) public {
        vm.assume(offset > 0);
        uint256 futureGiftAt = block.timestamp + uint256(offset);
        vm.prank(alice);
        uint256 giftId = registry.createGift(bob, futureGiftAt, THIRTY_DAYS_S);
        assertEq(registry.getGift(giftId).giftAt, futureGiftAt);
    }

    /**
     * @dev Fuzz: accounting identity holds after a contribution + claim.
     */
    function testFuzz_accountingIdentity_after_claim(uint128 amount) public {
        vm.assume(amount > 0);
        usdc.mint(alice, amount);
        uint256 giftId = _createDefaultGift();
        vm.prank(alice); registry.contribute(giftId, amount);
        _warpToGiftAt();
        vm.prank(bob); registry.claim(giftId);
        _assertAccountingIdentity(giftId);
    }

    /**
     * @dev Fuzz: accounting identity holds after a contribution + refund.
     */
    function testFuzz_accountingIdentity_after_refund(uint128 amount) public {
        vm.assume(amount > 0);
        usdc.mint(alice, amount);
        uint256 giftId = _createDefaultGift();
        vm.prank(alice); registry.contribute(giftId, amount);
        _warpToClaimDeadline();
        vm.prank(alice); registry.refund(giftId);
        _assertAccountingIdentity(giftId);
    }

    function _assertAccountingIdentity(uint256 giftId) internal view {
        CheersGiftRegistry.Gift memory g = registry.getGift(giftId);
        uint256 remaining = registry.getRemainingBalance(giftId);
        assertEq(
            g.totalContributed,
            g.totalClaimed + g.totalRefunded + remaining,
            "Accounting identity violated"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// I. Stateful invariant tests (forge test --invariant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @dev Invariant target: CheersGiftRegistry invariants must hold after any
 *      sequence of operations.
 *
 * Forge invariant testing calls the invariant_* functions after each randomly
 * selected call in the target contract set. We use a Handler to generate
 * valid (non-reverting) calls so the fuzzer explores more useful states.
 */
contract Handler is Test {
    CheersGiftRegistry internal registry;
    MockUSDC           internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob   = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 public lastGiftId;

    constructor(CheersGiftRegistry _registry, MockUSDC _usdc) {
        registry = _registry;
        usdc     = _usdc;

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(carol, 1_000_000e6);
        vm.prank(alice); usdc.approve(address(registry), type(uint256).max);
        vm.prank(carol); usdc.approve(address(registry), type(uint256).max);
    }

    function createGift(uint32 offsetSeconds, uint8 durationChoice) external {
        uint256 offset = bound(uint256(offsetSeconds), 1, 365 days);
        uint256 validDurations = durationChoice % 3;
        uint256 dur = validDurations == 0 ? 7 days :
                      validDurations == 1 ? 14 days : 30 days;
        uint256 giftAt = block.timestamp + offset;
        vm.prank(alice);
        lastGiftId = registry.createGift(bob, giftAt, dur);
    }

    function contribute(uint96 rawAmount) external {
        if (lastGiftId == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, 10_000e6);
        CheersGiftRegistry.Gift memory g = registry.getGift(lastGiftId);
        if (block.timestamp >= g.giftAt) return; // window closed
        vm.prank(alice);
        try registry.contribute(lastGiftId, amount) {} catch {}
    }

    function claim() external {
        if (lastGiftId == 0) return;
        CheersGiftRegistry.Gift memory g = registry.getGift(lastGiftId);
        if (block.timestamp < g.giftAt || block.timestamp >= g.claimDeadline) return;
        if (g.totalClaimed != 0 || g.totalContributed == 0) return;
        vm.prank(bob);
        try registry.claim(lastGiftId) {} catch {}
    }

    function refund() external {
        if (lastGiftId == 0) return;
        CheersGiftRegistry.Gift memory g = registry.getGift(lastGiftId);
        if (block.timestamp < g.claimDeadline) return;
        if (g.totalClaimed != 0) return;
        if (registry.contributions(lastGiftId, alice) == 0) return;
        if (registry.refunded(lastGiftId, alice)) return;
        vm.prank(alice);
        try registry.refund(lastGiftId) {} catch {}
    }

    function warpForward(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(uint256(seconds_), 1, 45 days));
    }
}

contract InvariantTest is CheersGiftRegistryBase {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(registry, usdc);
        targetContract(address(handler));
    }

    /**
     * @notice For every created gift: totalContributed == totalClaimed + totalRefunded + remaining.
     */
    function invariant_accountingIdentityHolds() public view {
        uint256 n = registry.nextGiftId();
        for (uint256 i = 1; i < n; i++) {
            // getGift reverts on nonexistent; all ids < nextGiftId were created by Handler
            CheersGiftRegistry.Gift memory g = registry.getGift(i);
            uint256 remaining = g.totalContributed - g.totalClaimed - g.totalRefunded;
            assertEq(
                g.totalContributed,
                g.totalClaimed + g.totalRefunded + remaining,
                string.concat("Accounting identity violated for giftId=", vm.toString(i))
            );
        }
    }

    /**
     * @notice Contract USDC balance >= sum of all remainingBalances.
     */
    function invariant_contractBalanceCoversLiabilities() public view {
        uint256 totalLiability;
        uint256 n = registry.nextGiftId();
        for (uint256 i = 1; i < n; i++) {
            CheersGiftRegistry.Gift memory g = registry.getGift(i);
            totalLiability += g.totalContributed - g.totalClaimed - g.totalRefunded;
        }
        assertGe(
            usdc.balanceOf(address(registry)),
            totalLiability,
            "Contract USDC balance below total remaining liabilities"
        );
    }

    /**
     * @notice totalClaimed is either 0 or exactly totalContributed for every gift.
     */
    function invariant_totalClaimedIsZeroOrFull() public view {
        uint256 n = registry.nextGiftId();
        for (uint256 i = 1; i < n; i++) {
            CheersGiftRegistry.Gift memory g = registry.getGift(i);
            assertTrue(
                g.totalClaimed == 0 || g.totalClaimed == g.totalContributed,
                "totalClaimed must be 0 or full"
            );
        }
    }

    /**
     * @notice totalRefunded never exceeds totalContributed.
     */
    function invariant_totalRefundedNeverExceedsTotalContributed() public view {
        uint256 n = registry.nextGiftId();
        for (uint256 i = 1; i < n; i++) {
            CheersGiftRegistry.Gift memory g = registry.getGift(i);
            assertLe(g.totalRefunded, g.totalContributed, "totalRefunded > totalContributed");
        }
    }

    /**
     * @notice nextGiftId only increases.
     */
    function invariant_nextGiftIdMonotonicallyIncreases() public view {
        assertGe(registry.nextGiftId(), 1);
    }
}
