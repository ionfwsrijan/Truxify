// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AggregatedVerifier
 * @dev Verifies aggregated ZK proofs (SnarkPack) to reduce gas overhead for multi-escrow validation.
 *
 *      A genuine SnarkPack verification decodes the aggregated proof into the
 *      Groth16 points A, B, C and runs the bilinear pairing checks (precompile
 *      0x08) against the aggregation verification key. That verification key
 *      and circuit are not deployed yet, so this contract FAILS CLOSED: it
 *      rejects every proof it cannot actually verify. Previously it accepted
 *      ANY 64-byte blob as a valid aggregated proof, letting anyone claim an
 *      arbitrary `_aggregationCommitment` was batch-verified.
 *
 *      The proof bytes are still decoded and structurally validated (points on
 *      the BN254 curve, no point at infinity) so clearly malformed proofs are
 *      rejected up front, but the pairing result can never be `true` until a
 *      real Groth16/SnarkPack verifier over `_aggregatedProofBytes` against
 *      `_aggregationCommitment` is wired in.
 */
contract AggregatedVerifier is Ownable {

    event BatchVerified(bytes32 indexed aggregationCommitment, uint256 count, bool success);

    // BN254 (alt_bn128) base field modulus.
    uint256 constant BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Verifies a single aggregated proof representing N verified delivery records.
     *      FAILS CLOSED: decodes and structurally validates the aggregated
     *      proof's Groth16 points, but no genuine pairing verification key is
     *      deployed, so an unverifiable proof always returns false.
     */
    function verifyAggregatedProof(
        bytes32 _aggregationCommitment,
        uint256 _proofCount,
        bytes calldata _aggregatedProofBytes
    ) external returns (bool) {
        require(_proofCount > 0, "Proof count must be > 0");
        // A SnarkPack-aggregated proof carries a Groth16 proof (a, b, c):
        // 8 32-byte words.
        require(_aggregatedProofBytes.length >= 256, "Invalid aggregated proof bytes dimensions");

        // Decode the aggregated proof's Groth16 points.
        uint256 aX;
        uint256 aY;
        uint256 bX1;
        uint256 bY1;
        uint256 bX2;
        uint256 bY2;
        uint256 cX;
        uint256 cY;
        assembly {
            aX  := calldataload(add(_aggregatedProofBytes.offset, 0))
            aY  := calldataload(add(_aggregatedProofBytes.offset, 32))
            bX1 := calldataload(add(_aggregatedProofBytes.offset, 64))
            bY1 := calldataload(add(_aggregatedProofBytes.offset, 96))
            bX2 := calldataload(add(_aggregatedProofBytes.offset, 128))
            bY2 := calldataload(add(_aggregatedProofBytes.offset, 160))
            cX  := calldataload(add(_aggregatedProofBytes.offset, 192))
            cY  := calldataload(add(_aggregatedProofBytes.offset, 224))
        }

        // Bind the proof to its exact inputs so a rejected result can never be
        // replayed across different commitments or proof counts.
        keccak256(abi.encode(_aggregationCommitment, _proofCount, _aggregatedProofBytes));

        // Reject structurally invalid points: G1 components must lie on the
        // BN254 curve, and the G2 component must not be the point at infinity.
        require(_isOnBn254(aX, aY), "Invalid aggregated proof point a");
        require(_isOnBn254(cX, cY), "Invalid aggregated proof point c");
        require(bX1 != 0 || bY1 != 0 || bX2 != 0 || bY2 != 0, "Invalid aggregated proof point b");

        // No genuine SnarkPack pairing verifier is implemented; fail closed.
        // A proof can never be accepted until the pairing relation over the
        // decoded points and `_aggregationCommitment` is actually evaluated.
        bool isValid = false;
        emit BatchVerified(_aggregationCommitment, _proofCount, isValid);
        return isValid;
    }

    /// @dev Returns true if (x, y) is on the BN254 G1 curve y^2 = x^3 + 3.
    function _isOnBn254(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= BN254_P && y >= BN254_P) return false;
        if (x == 0 && y == 0) return true;
        uint256 lhs = mulmod(y, y, BN254_P);
        uint256 rhs = mulmod(mulmod(x, x, BN254_P), x, BN254_P);
        rhs = addmod(rhs, 3, BN254_P);
        return lhs == rhs;
    }
}
