// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CheersGiftRegistry
 * @notice Community USDC gifting registry for SignalArc Cheers (cheers.signalarc.fun).
 *
 * @dev Each gift is identified by an auto-incrementing giftId (starts at 1; 0 is the
 *      nonexistent-gift sentinel). Contributors pool USDC for a single, immutable
 *      recipient. The recipient claims the full balance during a defined window. If
 *      unclaimed, each contributor can withdraw their own aggregated contribution.
 *
 * Accounting invariant (must hold at all times per gift):
 *   totalContributed == totalClaimed + totalRefunded + remainingBalance
 *
 * where remainingBalance is the derived quantity (not stored):
 *   remainingBalance = totalContributed - totalClaimed - totalRefunded
 *
 * USDC amounts use the ERC-20 view (6 decimals). The native-view (18 decimals) is the
 * same underlying asset on Arc and is only relevant for gas — never used here.
 *
 * OpenZeppelin 5.1.0 is pinned in this sandbox. Do not upgrade: >=5.2.0 introduces
 * utils/Bytes.sol which uses the Cancun `mcopy` opcode, incompatible with the
 * paris EVM target required for Arc.
 */

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CheersGiftRegistry is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    /// @dev Allowed claim durations in seconds.
    uint256 private constant SEVEN_DAYS   = 7  days;
    uint256 private constant FOURTEEN_DAYS = 14 days;
    uint256 private constant THIRTY_DAYS  = 30 days;

    // ─────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────

    /// @notice The USDC ERC-20 contract. Immutable; set in constructor.
    IERC20 public immutable usdc;

    /// @notice Next gift ID to be assigned. Starts at 1; 0 is the nonexistent sentinel.
    uint256 public nextGiftId;

    struct Gift {
        address recipient;         // Immutable once created; never zero or address(this)
        uint256 giftAt;            // Contribution window closes at this timestamp (exclusive)
                                   // Also signals existence: 0 = nonexistent gift
        uint256 claimDeadline;     // giftAt + claimDuration; claim window closes here (exclusive)
        uint256 totalContributed;  // Cumulative USDC received; monotonically increasing
        uint256 totalClaimed;      // 0 before claim; == totalContributed after successful claim
        uint256 totalRefunded;     // Running sum of refunds issued so far
    }

    mapping(uint256 => Gift) public gifts;

    /// @notice Per-contributor entitlement per gift. Accumulates across repeated contributions.
    mapping(uint256 => mapping(address => uint256)) public contributions;

    /// @notice True after a contributor has successfully refunded for a given gift.
    mapping(uint256 => mapping(address => bool)) public refunded;

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event GiftCreated(
        uint256 indexed giftId,
        address indexed creator,
        address indexed recipient,
        uint256 giftAt,
        uint256 claimDeadline
    );

    event ContributionMade(
        uint256 indexed giftId,
        address indexed contributor,
        uint256 amount,
        uint256 totalContributed
    );

    event GiftClaimed(
        uint256 indexed giftId,
        address indexed recipient,
        uint256 amount
    );

    event ContributorRefunded(
        uint256 indexed giftId,
        address indexed contributor,
        uint256 amount
    );

    // ─────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────

    error GiftDoesNotExist(uint256 giftId);
    error InvalidRecipient();
    error InvalidGiftAt();
    error InvalidClaimDuration();
    error ContributionWindowClosed();
    error ZeroAmount();
    error NotRecipient();
    error ClaimWindowNotOpen();
    error ClaimWindowClosed();
    error AlreadyClaimed();
    error RefundWindowNotOpen();
    error NotContributor();
    error AlreadyRefunded();

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    /**
     * @param _usdc Address of the USDC ERC-20 contract.
     *              On Arc (mainnet and testnet): 0x3600000000000000000000000000000000000000
     */
    constructor(address _usdc) {
        require(_usdc != address(0), "CheersGiftRegistry: zero usdc");
        usdc = IERC20(_usdc);
        nextGiftId = 1; // 0 is the nonexistent sentinel
    }

    // ─────────────────────────────────────────────────────────────
    // Write functions
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Create a new gift.
     * @param recipient    Address that may claim the gift. Must not be zero or this contract.
     * @param giftAt       Unix timestamp after which contributions are no longer accepted
     *                     and the recipient may begin claiming. Must be in the future.
     * @param claimDuration Seconds the recipient has to claim after giftAt. Must be
     *                     exactly 7 days, 14 days, or 30 days.
     * @return giftId      The newly assigned gift identifier (starts at 1).
     */
    function createGift(
        address recipient,
        uint256 giftAt,
        uint256 claimDuration
    ) external returns (uint256 giftId) {
        // ── Checks ──────────────────────────────────────────────
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (giftAt <= block.timestamp) {
            revert InvalidGiftAt();
        }
        if (
            claimDuration != SEVEN_DAYS &&
            claimDuration != FOURTEEN_DAYS &&
            claimDuration != THIRTY_DAYS
        ) {
            revert InvalidClaimDuration();
        }

        // ── Effects ─────────────────────────────────────────────
        giftId = nextGiftId;
        unchecked { nextGiftId = giftId + 1; }

        uint256 claimDeadline = giftAt + claimDuration;

        gifts[giftId] = Gift({
            recipient:        recipient,
            giftAt:           giftAt,
            claimDeadline:    claimDeadline,
            totalContributed: 0,
            totalClaimed:     0,
            totalRefunded:    0
        });

        emit GiftCreated(giftId, msg.sender, recipient, giftAt, claimDeadline);
    }

    /**
     * @notice Contribute USDC to an existing gift.
     *
     * @dev Caller must have approved this contract to spend at least `amount` USDC
     *      before calling. Repeated contributions from the same address accumulate.
     *      Contributions are accepted only while block.timestamp < giftAt.
     *
     * @param giftId  The gift to contribute to.
     * @param amount  USDC amount in 6-decimal ERC-20 units. Must be > 0.
     */
    function contribute(uint256 giftId, uint256 amount) external nonReentrant {
        Gift storage gift = _requireExistingGift(giftId);

        // ── Checks ──────────────────────────────────────────────
        if (block.timestamp >= gift.giftAt) {
            revert ContributionWindowClosed();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }

        // ── Effects ─────────────────────────────────────────────
        contributions[giftId][msg.sender] += amount;
        gift.totalContributed += amount;

        // ── Interactions ─────────────────────────────────────────
        // safeTransferFrom reverts if the transfer fails or returns false.
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit ContributionMade(giftId, msg.sender, amount, gift.totalContributed);
    }

    /**
     * @notice Recipient claims the full gift balance.
     *
     * @dev Only callable by the recipient during giftAt <= block.timestamp < claimDeadline.
     *      Can only succeed once. After a successful claim, totalClaimed == totalContributed
     *      and remainingBalance == 0.
     *
     *      CEI: totalClaimed is set before safeTransfer. A transfer failure reverts the
     *      transaction entirely, restoring totalClaimed to 0 and preserving the entitlement.
     *
     * @param giftId  The gift to claim.
     */
    function claim(uint256 giftId) external nonReentrant {
        Gift storage gift = _requireExistingGift(giftId);

        // ── Checks ──────────────────────────────────────────────
        if (msg.sender != gift.recipient) {
            revert NotRecipient();
        }
        if (gift.totalClaimed != 0) {
            revert AlreadyClaimed();
        }
        if (block.timestamp < gift.giftAt) {
            revert ClaimWindowNotOpen();
        }
        if (block.timestamp >= gift.claimDeadline) {
            revert ClaimWindowClosed();
        }
        if (gift.totalContributed == 0) {
            revert ZeroAmount();
        }

        // ── Effects ─────────────────────────────────────────────
        uint256 amount = gift.totalContributed;
        gift.totalClaimed = amount; // CEI: state before external call

        // ── Interactions ─────────────────────────────────────────
        // safeTransfer reverts on failure; totalClaimed reverts to 0 with the tx.
        usdc.safeTransfer(gift.recipient, amount);

        emit GiftClaimed(giftId, gift.recipient, amount);
    }

    /**
     * @notice Contributor withdraws their own aggregated contribution after the claim
     *         deadline has passed without the recipient claiming.
     *
     * @dev Callable by any contributor after block.timestamp >= claimDeadline, provided
     *      the gift was not claimed. Each contributor may refund exactly once. There is
     *      no expiry on refund rights.
     *
     *      CEI: refunded flag and totalRefunded are set before safeTransfer.
     *      A transfer failure reverts the transaction, restoring both fields.
     *
     * @param giftId  The gift to refund from.
     */
    function refund(uint256 giftId) external nonReentrant {
        Gift storage gift = _requireExistingGift(giftId);

        // ── Checks ──────────────────────────────────────────────
        if (block.timestamp < gift.claimDeadline) {
            revert RefundWindowNotOpen();
        }
        if (gift.totalClaimed != 0) {
            // Gift was claimed; no refunds allowed
            revert AlreadyClaimed();
        }
        if (refunded[giftId][msg.sender]) {
            revert AlreadyRefunded();
        }
        uint256 entitlement = contributions[giftId][msg.sender];
        if (entitlement == 0) {
            revert NotContributor();
        }

        // ── Effects ─────────────────────────────────────────────
        refunded[giftId][msg.sender] = true;      // CEI: mark before transfer
        gift.totalRefunded += entitlement;         // CEI: update before transfer

        // ── Interactions ─────────────────────────────────────────
        // safeTransfer reverts on failure; both state mutations revert with the tx.
        usdc.safeTransfer(msg.sender, entitlement);

        emit ContributorRefunded(giftId, msg.sender, entitlement);
    }

    // ─────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Returns the full Gift struct for a given giftId.
     * @dev Reverts with GiftDoesNotExist if the giftId has never been created.
     */
    function getGift(uint256 giftId) external view returns (Gift memory) {
        _requireExistingGift(giftId);
        return gifts[giftId];
    }

    /**
     * @notice Returns the remaining balance for a gift.
     *         remainingBalance = totalContributed - totalClaimed - totalRefunded.
     */
    function getRemainingBalance(uint256 giftId) external view returns (uint256) {
        Gift storage gift = _requireExistingGift(giftId);
        return gift.totalContributed - gift.totalClaimed - gift.totalRefunded;
    }

    /**
     * @notice Returns the contribution entitlement for a specific contributor.
     */
    function getContribution(uint256 giftId, address contributor)
        external
        view
        returns (uint256)
    {
        _requireExistingGift(giftId);
        return contributions[giftId][contributor];
    }

    /**
     * @notice Returns the current on-chain phase of a gift.
     * @return phase  0 = OPEN, 1 = CLAIMABLE, 2 = REFUNDABLE, 3 = CLOSED
     */
    function getPhase(uint256 giftId) external view returns (uint8 phase) {
        Gift storage gift = _requireExistingGift(giftId);
        if (gift.totalClaimed != 0) return 3; // CLOSED
        if (block.timestamp < gift.giftAt) return 0; // OPEN
        if (block.timestamp < gift.claimDeadline) return 1; // CLAIMABLE
        return 2; // REFUNDABLE
    }

    // ─────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────

    /**
     * @dev Returns a storage pointer to the gift if it exists; reverts otherwise.
     *      Existence is determined by giftAt != 0 (giftAt is always > 0 when set).
     */
    function _requireExistingGift(uint256 giftId)
        internal
        view
        returns (Gift storage gift)
    {
        gift = gifts[giftId];
        if (gift.giftAt == 0) revert GiftDoesNotExist(giftId);
    }
}
