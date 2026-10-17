// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title HarvestRegistry
 * @notice Public, append-only fingerprints of real harvest batches, so anyone
 *         holding a batch code (e.g. from a QR label on a crate) can check
 *         that the farm's record has not been changed since it was registered.
 *
 *         Only a SHA-256 hash of the batch's public record is stored. No names,
 *         coordinates or other personal data are written on-chain.
 *
 *         This is not a token: nothing here can be owned, transferred or traded,
 *         and it carries no value, title, ownership or profit right.
 *
 * Rules:
 *  - A batch id is registered once; its hash can never be changed or deleted.
 *  - A registered batch can be voided once (e.g. recorded in error). Voiding
 *    keeps the original hash and adds the time and a hash of the reason.
 *  - Only RECORDER_ROLE writes. The admin manages roles but does not record
 *    unless separately granted the role.
 */
contract HarvestRegistry is AccessControl {
    bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");

    struct Entry {
        bytes32 recordHash;
        uint64 recordedAt;
        uint64 voidedAt;
    }

    mapping(bytes32 => Entry) private _entries;

    event BatchRecorded(bytes32 indexed batchId, bytes32 recordHash, address indexed recorder);
    event BatchVoided(bytes32 indexed batchId, bytes32 reasonHash, address indexed recorder);

    error ZeroValue();
    error AlreadyRecorded(bytes32 batchId);
    error NotRecorded(bytes32 batchId);
    error AlreadyVoided(bytes32 batchId);

    constructor(address admin, address recorder) {
        if (admin == address(0) || recorder == address(0)) revert ZeroValue();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECORDER_ROLE, recorder);
    }

    /// @notice Registers the fingerprint of a batch's public record.
    function record(bytes32 batchId, bytes32 recordHash) external onlyRole(RECORDER_ROLE) {
        if (batchId == bytes32(0) || recordHash == bytes32(0)) revert ZeroValue();
        if (_entries[batchId].recordedAt != 0) revert AlreadyRecorded(batchId);
        _entries[batchId] = Entry({recordHash: recordHash, recordedAt: uint64(block.timestamp), voidedAt: 0});
        emit BatchRecorded(batchId, recordHash, msg.sender);
    }

    /// @notice Marks a registered batch as void. The original fingerprint stays readable.
    function voidBatch(bytes32 batchId, bytes32 reasonHash) external onlyRole(RECORDER_ROLE) {
        Entry storage e = _entries[batchId];
        if (e.recordedAt == 0) revert NotRecorded(batchId);
        if (e.voidedAt != 0) revert AlreadyVoided(batchId);
        e.voidedAt = uint64(block.timestamp);
        emit BatchVoided(batchId, reasonHash, msg.sender);
    }

    /// @notice The registered fingerprint and timestamps (all zero when unknown).
    function entryOf(bytes32 batchId) external view returns (bytes32 recordHash, uint64 recordedAt, uint64 voidedAt) {
        Entry storage e = _entries[batchId];
        return (e.recordHash, e.recordedAt, e.voidedAt);
    }
}
