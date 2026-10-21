using System;
using System.Collections.Generic;
using System.Linq;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Yield;
using Newtonsoft.Json;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>
    /// Cross-stack check on live pipeline output. Samples/claim-payloads.sample.json holds the claim payloads
    /// that packages/domain/src/yield/claim-lookup.ts serves from the frozen artifact of the PR #73
    /// multi-party simulation cycle; a vitest test (claim-lookup.sample.test.ts) reruns that pipeline and
    /// requires the committed file to match exactly. Here the C# client deserializes the payloads with its
    /// own settings and verifies them with VerifyClaimLeafProof.
    /// </summary>
    public class ClaimPayloadCrossStackTests
    {
        public sealed class Sample
        {
            [JsonProperty("artifactSha256")] public string ArtifactSha256;
            [JsonProperty("publishedTree")] public PublishedClaimTree PublishedTree;
            [JsonProperty("claims")] public List<ClaimPayload> Claims;
        }

        private static Sample Load() => TwinJson.Deserialize<Sample>(Samples.Read("claim-payloads.sample.json"));

        private static byte[] Bytes(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        private static ClaimPayload Copy(ClaimPayload c) => JsonConvert.DeserializeObject<ClaimPayload>(JsonConvert.SerializeObject(c), TwinJson.Settings);

        [Fact]
        public void DeserializesTheLivePipelineOutput()
        {
            var s = Load();
            Assert.Matches("^[0-9a-f]{64}$", s.ArtifactSha256);
            Assert.True(s.PublishedTree.Simulation);
            Assert.Equal(ClaimTreeVerifier.HasherId, s.PublishedTree.HasherId);
            Assert.Equal(2, s.PublishedTree.TreeSize);
            // The ownership snapshot the leaves are bound to (TS and an independent Python computation agree on it).
            Assert.Equal("bb57ff8d4fcf9adbfae0d505004022e73cbd1535848641fde2c493bf884d5ddd", s.PublishedTree.OwnershipSnapshotHash);
            Assert.All(s.Claims, c => Assert.Equal(s.PublishedTree.OwnershipSnapshotHash, c.OwnershipSnapshotHash));
            Assert.Equal(new[] { "party-a", "party-b" }, s.Claims.Select(c => c.PartyId).ToArray());
            Assert.Equal(new[] { "2677500000", "1606500000" }, s.Claims.Select(c => c.Amount).ToArray());
        }

        [Fact]
        public void VerifyClaimLeafProofPassesOnEveryLiveClaim()
        {
            var s = Load();
            foreach (var c in s.Claims)
            {
                Assert.True(ClaimTreeVerifier.VerifyClaimLeafProof(Bytes(c.LeafBytes), c.LeafIndex, c.TreeSize, c.Path, c.Root, s.PublishedTree.Root, s.PublishedTree.TreeSize));
                Assert.True(ClaimPayloadVerification.Verify(c, s.PublishedTree));
            }
        }

        [Fact]
        public void LiveLeavesDecodeToThePayloadAndRebuildThePublishedRoot()
        {
            var s = Load();
            foreach (var c in s.Claims)
            {
                var leaf = ClaimLeafCodec.Decode(Bytes(c.LeafBytes));
                Assert.Equal(ulong.Parse(c.Amount), leaf.Amount);
                Assert.Equal(c.Recipient, Hex(leaf.Recipient));
                Assert.Equal((uint)c.LeafIndex, leaf.LeafIndex);
                Assert.Equal(ClaimLeafCodec.UuidBytes(s.PublishedTree.CycleId), leaf.CycleId);
                Assert.Equal(s.PublishedTree.CycleVersion, leaf.CycleVersion);
                Assert.Equal(ClaimLeafCodec.LayoutVersionSnapshotBound, leaf.LeafLayoutVersion);
                Assert.Equal(ClaimLeafCodec.LengthSnapshotBound, Bytes(c.LeafBytes).Length);
                Assert.Equal(s.PublishedTree.OwnershipSnapshotHash, Hex(leaf.OwnershipSnapshotHash));
                Assert.Equal(c.LeafHash, ClaimTreeVerifier.LeafHash(Bytes(c.LeafBytes)));
                Assert.Equal(Bytes(c.LeafBytes), ClaimLeafCodec.Encode(leaf));
            }
            Assert.Equal(s.PublishedTree.Root, ClaimTreeVerifier.ComputeRoot(s.Claims.OrderBy(c => c.LeafIndex).Select(c => c.LeafHash).ToList()));
        }

        [Fact]
        public void RejectsLiveClaimsThatWereAlteredOrPresentedAgainstAnotherTree()
        {
            var s = Load();
            var c = s.Claims[1];
            Assert.True(ClaimPayloadVerification.Verify(c, s.PublishedTree));

            var alterations = new List<Action<ClaimPayload>>
            {
                x => x.Amount = "1606500001",
                x => x.Amount = "01606500000",
                x => x.Recipient = new string('0', 64),
                x => x.LeafIndex = 0,
                x => x.TreeSize = 3,
                x => x.Root = new string('0', 64),
                x => x.Path = new List<string> { new string('f', 64) },
                x => x.Path = null,
                x => x.LeafBytes = x.LeafBytes.Substring(2),
                x => x.HasherId = "other",
                x => x.Simulation = false,
                x => x.Scheme = "metafarm-yield-claim/2",
                x => x.OwnershipSnapshotHash = new string('1', 64),
            };
            foreach (var alter in alterations)
            {
                var altered = Copy(c);
                alter(altered);
                Assert.False(ClaimPayloadVerification.Verify(altered, s.PublishedTree));
            }

            var otherRoot = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            otherRoot.Root = new string('0', 64);
            Assert.False(ClaimPayloadVerification.Verify(c, otherRoot));
            var otherSize = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            otherSize.TreeSize = 3;
            Assert.False(ClaimPayloadVerification.Verify(c, otherSize));
            // A genuine leaf of this cycle claimed for another cycle or version (same root) is refused.
            var otherCycle = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            otherCycle.CycleId = "00000000-0000-4000-8000-0000000000c2";
            var moved = Copy(c);
            moved.CycleId = otherCycle.CycleId;
            Assert.False(ClaimPayloadVerification.Verify(moved, otherCycle));
            // A claim presented against another ownership snapshot (payload and trusted tree agreeing) is refused:
            // the leaf itself names the snapshot it was built from.
            var otherSnapshot = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            otherSnapshot.OwnershipSnapshotHash = new string('1', 64);
            var rebound = Copy(c);
            rebound.OwnershipSnapshotHash = otherSnapshot.OwnershipSnapshotHash;
            Assert.False(ClaimPayloadVerification.Verify(rebound, otherSnapshot));
            var notSimulation = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            notSimulation.Simulation = false;
            Assert.False(ClaimPayloadVerification.Verify(c, notSimulation));
        }

        [Fact]
        public void TheCodecKeepsLayoutsApart()
        {
            var s = Load();
            var bytes = Bytes(s.Claims[0].LeafBytes);
            var leaf = ClaimLeafCodec.Decode(bytes);
            // Layout 2 needs its snapshot hash; layout 1 refuses one.
            var noHash = ClaimLeafCodec.Decode(bytes);
            noHash.OwnershipSnapshotHash = null;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Encode(noHash));
            var layout1WithHash = ClaimLeafCodec.Decode(bytes);
            layout1WithHash.LeafLayoutVersion = ClaimLeafCodec.LayoutVersion;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Encode(layout1WithHash));
            // Lengths must match the layout byte.
            var truncated = bytes.Take(ClaimLeafCodec.Length).ToArray();
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(truncated));
            var relabelled = (byte[])bytes.Clone();
            relabelled[195] = 1;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(relabelled));
            Assert.Equal(bytes, ClaimLeafCodec.Encode(leaf));
        }
    }
}
