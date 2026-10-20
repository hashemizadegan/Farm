// The platform's Merkle scheme (metafarm-merkle-sha256/1, packages/domain/src/twin/commitments.ts):
// RFC 9162 section 2.1, leaf = SHA-256(0x00 || content hash bytes), node = SHA-256(0x01 || l || r).
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Verification
{
    public sealed class Rfc9162CommitmentVerifier : ICommitmentVerifier
    {
        public const string Scheme = "metafarm-merkle-sha256/1";
        private const int MaxBatchLeaves = 4096;

        public bool ContentMatches(byte[] content, string contentSha256)
        {
            if (content == null || !IsHex64(contentSha256)) return false;
            using (var sha = SHA256.Create()) return ToHex(sha.ComputeHash(content)) == contentSha256;
        }

        public bool VerifyProof(DataCommitmentProof proof)
        {
            var p = proof?.Proof;
            if (p == null || proof.Commitment == null || p.Scheme != Scheme) return false;
            if (!IsHex64(proof.Commitment.ContentSha256)) return false;
            return LeafHash(proof.Commitment.ContentSha256) == p.Leaf && VerifyInclusion(p.Leaf, p.LeafIndex, p.Size, p.Path, p.Root);
        }

        /// <summary>The batch leaf for a content hash.</summary>
        public static string LeafHash(string contentSha256)
        {
            if (!IsHex64(contentSha256)) throw new ArgumentException("content hash must be 64 lowercase hex characters", nameof(contentSha256));
            return ToHex(Hash(new byte[] { 0 }, FromHex(contentSha256)));
        }

        /// <summary>The RFC 9162 root of leaf hashes in order (the platform's merkleRoot).</summary>
        public static string ComputeRoot(IReadOnlyList<string> leafHashes)
        {
            if (leafHashes == null || leafHashes.Count == 0 || leafHashes.Count > MaxBatchLeaves) throw new ArgumentException("a batch holds 1-4096 leaves", nameof(leafHashes));
            var leaves = new byte[leafHashes.Count][];
            for (var i = 0; i < leaves.Length; i++)
            {
                if (!IsHex64(leafHashes[i])) throw new ArgumentException("leaf hashes must be 64 lowercase hex characters", nameof(leafHashes));
                leaves[i] = FromHex(leafHashes[i]);
            }
            return ToHex(Subtree(leaves, 0, leaves.Length));
        }

        private static byte[] Subtree(byte[][] leaves, int lo, int hi)
        {
            if (hi - lo == 1) return leaves[lo];
            var k = 1;
            while (k * 2 < hi - lo) k *= 2;
            return Hash(new byte[] { 1 }, Subtree(leaves, lo, lo + k), Subtree(leaves, lo + k, hi));
        }

        /// <summary>RFC 9162 section 2.1.3.2. Malformed input is not a proof: the answer is false.</summary>
        public static bool VerifyInclusion(string leaf, int index, int size, IReadOnlyList<string> path, string root)
        {
            if (!IsHex64(leaf) || !IsHex64(root) || path == null) return false;
            if (index < 0 || size < 1 || index >= size || size > MaxBatchLeaves) return false;
            foreach (var h in path) if (!IsHex64(h)) return false;
            long fn = index, sn = size - 1;
            var r = FromHex(leaf);
            foreach (var hex in path)
            {
                if (sn == 0) return false;
                var sibling = FromHex(hex);
                if (fn % 2 == 1 || fn == sn)
                {
                    r = Hash(new byte[] { 1 }, sibling, r);
                    if (fn % 2 == 0)
                        while (fn % 2 == 0 && fn != 0) { fn >>= 1; sn >>= 1; }
                }
                else
                {
                    r = Hash(new byte[] { 1 }, r, sibling);
                }
                fn >>= 1;
                sn >>= 1;
            }
            return sn == 0 && ToHex(r) == root;
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

        private static string ToHex(byte[] bytes)
        {
            var c = new char[bytes.Length * 2];
            const string digits = "0123456789abcdef";
            for (var i = 0; i < bytes.Length; i++) { c[2 * i] = digits[bytes[i] >> 4]; c[2 * i + 1] = digits[bytes[i] & 15]; }
            return new string(c);
        }
    }
}
