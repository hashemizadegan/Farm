// Claim-tree proof verification, compatible with packages/domain/src/yield/claim-tree.ts:
// hasher sha256-rfc9162-double-leaf/1 (leaf = SHA-256(0x00 || SHA-256(leafBytes)),
// node = SHA-256(0x01 || left || right)), RFC 9162 tree shape and inclusion proofs.
// Verification only: the client never builds, publishes or anchors a tree. Simulation only while D-26
// (hash function) is open; a different hasher would be a different HasherId.
using System;
using System.Collections.Generic;
using System.Security.Cryptography;

namespace Metafarm.Twin.Core.Yield
{
    public static class ClaimTreeVerifier
    {
        public const string HasherId = "sha256-rfc9162-double-leaf/1";

        /// <summary>The leaf hash of 201 leaf bytes, as lowercase hex.</summary>
        public static string LeafHash(byte[] leafBytes)
        {
            if (leafBytes == null) throw new ArgumentNullException(nameof(leafBytes));
            return ToHex(LeafHashBytes(leafBytes));
        }

        /// <summary>The RFC 9162 root of leaf hashes in leaf order, as lowercase hex.</summary>
        public static string ComputeRoot(IReadOnlyList<string> leafHashes)
        {
            if (leafHashes == null || leafHashes.Count == 0) throw new ArgumentException("a tree has at least one leaf", nameof(leafHashes));
            var leaves = new byte[leafHashes.Count][];
            for (var i = 0; i < leaves.Length; i++)
            {
                if (!IsHex64(leafHashes[i])) throw new ArgumentException("leaf hashes must be 64 lowercase hex characters", nameof(leafHashes));
                leaves[i] = FromHex(leafHashes[i]);
            }
            return ToHex(Subtree(leaves, 0, leaves.Length));
        }

        /// <summary>
        /// RFC 9162 section 2.1.3.2: whether leafHash is at index in a tree of size leaves with this root.
        /// The root and size are taken as given; to check a claim leaf against a published tree use
        /// VerifyClaimLeafProof. Malformed input is not a proof: the answer is false.
        /// </summary>
        public static bool VerifyInclusion(string leafHash, long index, long size, IReadOnlyList<string> path, string root)
        {
            if (!IsHex64(leafHash) || !IsHex64(root) || path == null) return false;
            if (index < 0 || size < 1 || index >= size || size > 4294967296L) return false;
            foreach (var h in path) if (!IsHex64(h)) return false;
            long fn = index, sn = size - 1;
            var r = FromHex(leafHash);
            foreach (var hex in path)
            {
                if (sn == 0) return false;
                var sibling = FromHex(hex);
                if (fn % 2 == 1 || fn == sn)
                {
                    r = Node(sibling, r);
                    if (fn % 2 == 0)
                        while (fn % 2 == 0 && fn != 0) { fn >>= 1; sn >>= 1; }
                }
                else
                {
                    r = Node(r, sibling);
                }
                fn >>= 1;
                sn >>= 1;
            }
            return sn == 0 && ToHex(r) == root;
        }

        /// <summary>
        /// Verifies leaf bytes against a trusted, published root and size (an RFC 9162 path alone does not
        /// bind the size): the proof's root and size must equal the trusted ones, the leaf must decode, its
        /// embedded index must equal the proof's index, and the leaf hash recomputed from the bytes must be
        /// included. As the platform's verifyClaimLeafProof.
        /// </summary>
        public static bool VerifyClaimLeafProof(byte[] leafBytes, long leafIndex, long treeSize, IReadOnlyList<string> path, string proofRoot, string trustedRoot, long trustedTreeSize)
        {
            if (leafBytes == null || proofRoot == null || proofRoot != trustedRoot || treeSize != trustedTreeSize) return false;
            ClaimLeafFields f;
            try
            {
                f = ClaimLeafCodec.Decode(leafBytes);
            }
            catch (ArgumentException)
            {
                return false;
            }
            if (f.LeafIndex != leafIndex) return false;
            return VerifyInclusion(LeafHash(leafBytes), leafIndex, treeSize, path, trustedRoot);
        }

        private static byte[] LeafHashBytes(byte[] leafBytes) => Hash(new byte[] { 0 }, Hash(leafBytes));

        private static byte[] Node(byte[] left, byte[] right) => Hash(new byte[] { 1 }, left, right);

        private static byte[] Subtree(byte[][] leaves, int lo, int hi)
        {
            if (hi - lo == 1) return leaves[lo];
            var k = 1;
            while (k * 2 < hi - lo) k *= 2;
            return Node(Subtree(leaves, lo, lo + k), Subtree(leaves, lo + k, hi));
        }

        private static byte[] Hash(params byte[][] parts)
        {
            var total = 0;
            foreach (var p in parts) total += p.Length;
            var buf = new byte[total];
            var at = 0;
            foreach (var p in parts) { Buffer.BlockCopy(p, 0, buf, at, p.Length); at += p.Length; }
            using (var sha = SHA256.Create()) return sha.ComputeHash(buf);
        }

        private static bool IsHex64(string s)
        {
            if (s == null || s.Length != 64) return false;
            foreach (var c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        private static byte[] FromHex(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        internal static string ToHex(byte[] bytes)
        {
            var c = new char[bytes.Length * 2];
            const string digits = "0123456789abcdef";
            for (var i = 0; i < bytes.Length; i++) { c[2 * i] = digits[bytes[i] >> 4]; c[2 * i + 1] = digits[bytes[i] & 15]; }
            return new string(c);
        }
    }
}
