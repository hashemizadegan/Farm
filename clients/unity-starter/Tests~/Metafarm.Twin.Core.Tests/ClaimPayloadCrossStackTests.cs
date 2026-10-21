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
            var notSimulation = JsonConvert.DeserializeObject<PublishedClaimTree>(JsonConvert.SerializeObject(s.PublishedTree));
            notSimulation.Simulation = false;
            Assert.False(ClaimPayloadVerification.Verify(c, notSimulation));
        }
    }
}
