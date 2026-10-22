using System;
using System.Collections.Generic;
using System.Linq;
using Metafarm.Twin.Core.Yield;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>
    /// Byte-for-byte parity with the platform's claim tree (packages/domain/src/yield/claim-tree.ts).
    /// Samples/claim-tree-vectors.json is generated from that TypeScript code; a vitest test
    /// (claim-tree.vectors.test.ts) requires the committed file to equal what TypeScript produces.
    /// </summary>
    public class ClaimTreeParityTests
    {
        private static readonly JObject Vectors = JObject.Parse(Samples.Read("claim-tree-vectors.json"));

        private static byte[] Bytes(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        private static ClaimLeafFields Fields(JToken f) => new ClaimLeafFields
        {
            NetworkId = (byte)f["networkId"],
            ClusterIdentity = Bytes((string)f["clusterIdentity"]),
            CycleId = ClaimLeafCodec.UuidBytes((string)f["cycleId"]),
            CycleVersion = (uint)f["cycleVersion"],
            Epoch = (uint)f["epoch"],
            EconomicAssetId = Bytes((string)f["economicAssetId"]),
            Recipient = Bytes((string)f["recipient"]),
            PayoutMint = Bytes((string)f["payoutMint"]),
            Amount = ulong.Parse((string)f["amount"]),
            FormulaVersion = (ushort)f["formulaVersion"],
            LeafLayoutVersion = (ushort)f["leafLayoutVersion"],
            LeafIndex = (uint)f["leafIndex"],
        };

        private static IEnumerable<(JToken Tree, JToken Leaf)> AllLeaves() =>
            Vectors["trees"].SelectMany(t => t["leaves"].Select(l => (t, l)));

        private static IEnumerable<JToken> AllEncodedLeaves() =>
            AllLeaves().Select(x => x.Leaf).Append(Vectors["edgeLeaf"]);

        [Fact]
        public void VectorsCoverSeveralTreeShapes()
        {
            Assert.Equal("sha256-rfc9162-double-leaf/1", (string)Vectors["hasherId"]);
            Assert.Equal(ClaimTreeVerifier.HasherId, (string)Vectors["hasherId"]);
            Assert.Equal(new[] { 1, 3, 5, 7, 8 }, Vectors["trees"].Select(t => (int)t["size"]).ToArray());
            Assert.Equal(24, AllLeaves().Count());
        }

        [Fact]
        public void DomainTagMatchesByteForByte() => Assert.Equal(Bytes((string)Vectors["leafDomainTag"]), ClaimLeafCodec.DomainTag());

        [Fact]
        public void EncodesEveryLeafByteForByte()
        {
            foreach (var leaf in AllEncodedLeaves())
            {
                var encoded = ClaimLeafCodec.Encode(Fields(leaf["fields"]));
                Assert.Equal(ClaimLeafCodec.Length, encoded.Length);
                Assert.Equal(Bytes((string)leaf["leafBytes"]), encoded);
            }
        }

        [Fact]
        public void DecodesEveryLeafToTheVectorFieldsAndReEncodesIdentically()
        {
            foreach (var leaf in AllEncodedLeaves())
            {
                var bytes = Bytes((string)leaf["leafBytes"]);
                var d = ClaimLeafCodec.Decode(bytes);
                var f = leaf["fields"];
                Assert.Equal((byte)f["networkId"], d.NetworkId);
                Assert.Equal((string)f["clusterIdentity"], Hex(d.ClusterIdentity));
                Assert.Equal(ClaimLeafCodec.UuidBytes((string)f["cycleId"]), d.CycleId);
                Assert.Equal((uint)f["cycleVersion"], d.CycleVersion);
                Assert.Equal((uint)f["epoch"], d.Epoch);
                Assert.Equal((string)f["economicAssetId"], Hex(d.EconomicAssetId));
                Assert.Equal((string)f["recipient"], Hex(d.Recipient));
                Assert.Equal((string)f["payoutMint"], Hex(d.PayoutMint));
                Assert.Equal(ulong.Parse((string)f["amount"]), d.Amount);
                Assert.Equal((ushort)f["formulaVersion"], d.FormulaVersion);
                Assert.Equal((ushort)f["leafLayoutVersion"], d.LeafLayoutVersion);
                Assert.Equal((uint)f["leafIndex"], d.LeafIndex);
                Assert.Equal(bytes, ClaimLeafCodec.Encode(d));
            }
        }

        [Fact]
        public void EdgeLeafPinsTheLittleEndianLayoutAtEveryMaximum()
        {
            var b = Bytes((string)Vectors["edgeLeaf"]["leafBytes"]);
            Assert.Equal(255, b[32]);
            Assert.Equal(new byte[] { 0xff, 0xff, 0xff, 0xff }, b.Skip(81).Take(4).ToArray()); // cycle version u32 max
            Assert.Equal(new byte[] { 0xfe, 0xff, 0xff, 0xff }, b.Skip(85).Take(4).ToArray()); // epoch u32 max − 1, low byte first
            Assert.Equal(Enumerable.Repeat((byte)0xff, 8).ToArray(), b.Skip(185).Take(8).ToArray()); // amount u64 max
            Assert.Equal(new byte[] { 0xff, 0xff, 0x01, 0x00 }, b.Skip(193).Take(4).ToArray()); // formula u16 max, layout 1
            Assert.Equal(ulong.MaxValue, ClaimLeafCodec.Decode(b).Amount);
        }

        [Fact]
        public void LeafHashesMatchHexForHex()
        {
            foreach (var leaf in AllEncodedLeaves())
                Assert.Equal((string)leaf["leafHash"], ClaimTreeVerifier.LeafHash(Bytes((string)leaf["leafBytes"])));
        }

        [Fact]
        public void RootsMatchForEveryTreeSize()
        {
            foreach (var tree in Vectors["trees"])
            {
                var hashes = tree["leaves"].Select(l => (string)l["leafHash"]).ToList();
                Assert.Equal((string)tree["root"], ClaimTreeVerifier.ComputeRoot(hashes));
            }
        }

        [Fact]
        public void EveryVectorProofVerifiesAtItsIndex()
        {
            foreach (var (tree, leaf) in AllLeaves())
            {
                var path = leaf["path"].Select(p => (string)p).ToList();
                var bytes = Bytes((string)leaf["leafBytes"]);
                long index = (long)leaf["index"], size = (long)tree["size"];
                var root = (string)tree["root"];
                Assert.True(ClaimTreeVerifier.VerifyInclusion((string)leaf["leafHash"], index, size, path, root));
                Assert.True(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, index, size, path, root, root, size));
            }
        }

        [Fact]
        public void RejectsTamperedLeavesIndexesPathsAndRoots()
        {
            var tree = Vectors["trees"][2]; // size 5
            var leaf = tree["leaves"][3];
            var path = leaf["path"].Select(p => (string)p).ToList();
            var bytes = Bytes((string)leaf["leafBytes"]);
            var root = (string)tree["root"];
            Assert.True(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 3, 5, path, root, root, 5));

            var tampered = (byte[])bytes.Clone();
            tampered[185] ^= 1; // amount
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(tampered, 3, 5, path, root, root, 5));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 2, 5, path, root, root, 5));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 3, 5, path.Take(path.Count - 1).ToList(), root, root, 5));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 3, 5, path.Concat(new[] { path[0] }).ToList(), root, root, 5));
            var otherRoot = (string)Vectors["trees"][3]["root"];
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 3, 5, path, otherRoot, root, 5));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes, 3, 5, path, otherRoot, otherRoot, 5));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(bytes.Take(200).ToArray(), 3, 5, path, root, root, 5));
            Assert.False(ClaimTreeVerifier.VerifyInclusion((string)leaf["leafHash"], 3, 5, new List<string> { "zz" }, root));
            Assert.False(ClaimTreeVerifier.VerifyInclusion((string)leaf["leafHash"], -1, 5, path, root));
        }

        [Fact]
        public void BindsTheTreeSizeOnlyAgainstThePublishedTree()
        {
            // As in TypeScript: in a 3-leaf tree, leaf 1's path also verifies if the proof claims 4 leaves.
            var tree = Vectors["trees"][1];
            var leaf = tree["leaves"][1];
            var path = leaf["path"].Select(p => (string)p).ToList();
            var root = (string)tree["root"];
            Assert.True(ClaimTreeVerifier.VerifyInclusion((string)leaf["leafHash"], 1, 4, path, root));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(Bytes((string)leaf["leafBytes"]), 1, 4, path, root, root, 3));
            Assert.True(ClaimTreeVerifier.VerifyClaimLeafProof(Bytes((string)leaf["leafBytes"]), 1, 3, path, root, root, 3));
        }

        [Fact]
        public void RefusesLeavesTheCodecCannotRepresent()
        {
            var f = Fields(Vectors["trees"][0]["leaves"][0]["fields"]);
            f.Amount = 0;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Encode(f));
            var g = Fields(Vectors["trees"][0]["leaves"][0]["fields"]);
            g.Recipient = new byte[31];
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Encode(g));
            var bytes = Bytes((string)Vectors["trees"][0]["leaves"][0]["leafBytes"]);
            var wrongTag = (byte[])bytes.Clone();
            wrongTag[0] ^= 1;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(wrongTag));
            var wrongLayout = (byte[])bytes.Clone();
            wrongLayout[195] = 2;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(wrongLayout));
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(bytes.Take(200).ToArray()));
        }

        [Fact]
        public void UuidBytesUseRfc4122OrderNotSystemGuidOrder()
        {
            const string id = "00000000-0000-4000-8000-00000000000a";
            Assert.Equal(Bytes("0000000000004000800000000000000a"), ClaimLeafCodec.UuidBytes(id));
            Assert.NotEqual(Guid.Parse("01020304-0506-4708-890a-0b0c0d0e0f10").ToByteArray(), ClaimLeafCodec.UuidBytes("01020304-0506-4708-890a-0b0c0d0e0f10"));
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.UuidBytes(id.ToUpperInvariant().Replace("A", "B") + "X"));
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.UuidBytes("00000000-0000-4000-8000-00000000000A"));
        }
    }
}
