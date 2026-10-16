// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Pausable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title FarmProjectCollectible
 * @notice ERC-721 digital collectible representing a farm *project* inside the
 *         application. It is a display and in-app utility item only.
 *
 *         It does NOT represent, convey or evidence: land title, any interest in
 *         land, crop ownership, a share of profit or revenue, or any claim on
 *         the issuer. It carries no promise of value or appreciation.
 *
 * Design constraints (see docs/data-provenance-and-legal.md):
 *  - Fixed maximum supply set at deployment and never increased.
 *  - Explicit MINTER_ROLE; the deployer does not mint unless granted the role.
 *  - Pause exists only to halt minting and transfers during an emergency
 *    (e.g. a compromised minter key). It cannot move or burn anyone's token.
 *  - No confiscation: there is no admin transfer, admin burn, or blocklist.
 *  - Metadata contains no coordinates, personal data, deeds, sensor
 *    credentials or identity mappings; tokenURI points to public metadata
 *    validated against nft-metadata.schema.json.
 */
contract FarmProjectCollectible is ERC721, ERC721Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public immutable maxSupply;
    uint256 public totalMinted;
    string private _baseTokenURI;

    error MaxSupplyReached(uint256 maxSupply);
    error ZeroMaxSupply();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory baseTokenURI_,
        uint256 maxSupply_,
        address admin,
        address minter,
        address pauser
    ) ERC721(name_, symbol_) {
        if (maxSupply_ == 0) revert ZeroMaxSupply();
        maxSupply = maxSupply_;
        _baseTokenURI = baseTokenURI_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Mints the next token id to `to`. Token ids start at 1.
    function mint(address to) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        if (totalMinted >= maxSupply) revert MaxSupplyReached(maxSupply);
        unchecked {
            tokenId = ++totalMinted;
        }
        _safeMint(to, tokenId);
    }

    /// @notice Emergency stop for minting and transfers. Does not affect ownership records.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ── Required overrides ────────────────────────────────────────────────

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Pausable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
