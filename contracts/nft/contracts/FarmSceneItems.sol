// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title FarmSceneItems
 * @notice ERC-1155 repeated digital items (decorations, badges, cosmetic
 *         themes) usable inside the application's 3D scene.
 *
 *         Items are digital collectibles / in-app utility only. They do not
 *         represent crops, produce, land, equipment, revenue or any real-world
 *         asset or right, and carry no promise of value.
 *
 * Design constraints:
 *  - Every item id has a fixed maximum supply set ONCE when the id is defined;
 *    it can never be raised. Undefined ids cannot be minted.
 *  - Explicit MINTER_ROLE and ITEM_DEFINER_ROLE.
 *  - Pause is an emergency stop only; there is no confiscation, admin burn or
 *    admin transfer.
 */
contract FarmSceneItems is ERC1155, ERC1155Pausable, ERC1155Supply, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ITEM_DEFINER_ROLE = keccak256("ITEM_DEFINER_ROLE");

    mapping(uint256 id => uint256) public maxSupplyOf;

    event ItemDefined(uint256 indexed id, uint256 maxSupply);

    error ItemAlreadyDefined(uint256 id);
    error ItemNotDefined(uint256 id);
    error ZeroMaxSupply();
    error ExceedsMaxSupply(uint256 id, uint256 requested, uint256 remaining);

    constructor(string memory uri_, address admin, address minter, address pauser, address definer) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(ITEM_DEFINER_ROLE, definer);
    }

    /// @notice Defines an item id with a permanent maximum supply. Can be called once per id.
    function defineItem(uint256 id, uint256 maxSupply_) external onlyRole(ITEM_DEFINER_ROLE) {
        if (maxSupply_ == 0) revert ZeroMaxSupply();
        if (maxSupplyOf[id] != 0) revert ItemAlreadyDefined(id);
        maxSupplyOf[id] = maxSupply_;
        emit ItemDefined(id, maxSupply_);
    }

    function mint(address to, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        _checkSupply(id, amount);
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external onlyRole(MINTER_ROLE) {
        _mintBatch(to, ids, amounts, "");
        // Checked after minting so repeated ids in one batch are counted together;
        // any violation reverts the whole batch.
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 cap = maxSupplyOf[ids[i]];
            if (cap == 0) revert ItemNotDefined(ids[i]);
            if (totalSupply(ids[i]) > cap) revert ExceedsMaxSupply(ids[i], amounts[i], 0);
        }
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _checkSupply(uint256 id, uint256 amount) private view {
        uint256 cap = maxSupplyOf[id];
        if (cap == 0) revert ItemNotDefined(id);
        uint256 minted = totalSupply(id);
        if (amount > cap - minted) revert ExceedsMaxSupply(id, amount, cap - minted);
    }

    // ── Required overrides ────────────────────────────────────────────────

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Pausable, ERC1155Supply)
    {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
