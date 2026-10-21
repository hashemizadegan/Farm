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
    /// Claims served by the platform's claim read model (packages/domain/src/yield/claim-read-model.ts): the
    /// 4,096-holder cycle of the large-tree sample, projected into records, persisted as a byte image, reloaded,
    /// and queried one holder at a time (proofs rebuilt from stored tree nodes). Samples/claim-readmodel.sample.json
    /// is drift-checked by claim-read-model.test.ts. The client must decode every layout 2 leaf exactly, verify every
    /// claim, and find each one identical to the claim the in-memory lookup served for the same party
    /// (Samples/claim-payloads.large-tree.sample.json).
    /// </summary>
    public class ReadModelCrossStackTests
    {
        public sealed class Header
        {
            [JsonProperty("simulation")] public bool Simulation;
            [JsonProperty("networkId")] public string NetworkId;
            [JsonProperty("artifactSha256")] public string ArtifactSha256;
            [JsonProperty("published")] public PublishedClaimTree Published;
            [JsonProperty("levelSizes")] public List<long> LevelSizes;
        }

        public sealed class Read
        {
            [JsonProperty("partyId")] public string PartyId;
            [JsonProperty("gets")] public int Gets;
        }

        public sealed class Sample
        {
            [JsonProperty("imageSha256")] public string ImageSha256;
            [JsonProperty("header")] public Header Header;
            [JsonProperty("reads")] public List<Read> Reads;
            [JsonProperty("claims")] public List<ClaimPayload> Claims;
        }

        public sealed class LargeTree
        {
            [JsonProperty("artifactSha256")] public string ArtifactSha256;
            [JsonProperty("publishedTree")] public PublishedClaimTree PublishedTree;
            [JsonProperty("claims")] public List<ClaimPayload> Claims;
        }

        private static Sample Load() => TwinJson.Deserialize<Sample>(Samples.Read("claim-readmodel.sample.json"));
        private static LargeTree LoadLargeTree() => TwinJson.Deserialize<LargeTree>(Samples.Read("claim-payloads.large-tree.sample.json"));

        private static byte[] Bytes(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        [Fact]
        public void TheHeaderPinsASimulationTreeWithConsistentLevels()
        {
            var s = Load();
            Assert.Matches("^[0-9a-f]{64}$", s.ImageSha256);
            Assert.True(s.Header.Simulation);
            Assert.Equal("simulation", s.Header.NetworkId);
            Assert.True(s.Header.Published.Simulation);
            // Level sizes follow from the tree size: n, ceil(n/2), ..., 1.
            var want = new List<long> { s.Header.Published.TreeSize };
            while (want[want.Count - 1] > 1) want.Add((want[want.Count - 1] + 1) / 2);
            Assert.Equal(want, s.Header.LevelSizes);
            // The same cycle and tree as the large-tree sample.
            var large = LoadLargeTree();
            Assert.Equal(large.ArtifactSha256, s.Header.ArtifactSha256);
            Assert.Equal(JsonConvert.SerializeObject(large.PublishedTree), JsonConvert.SerializeObject(s.Header.Published));
        }

        [Fact]
        public void EveryReadModelClaimDecodesExactlyAndVerifies()
        {
            var s = Load();
            Assert.True(s.Claims.Count > 32);
            foreach (var c in s.Claims)
            {
                var bytes = Bytes(c.LeafBytes);
                Assert.Equal(ClaimLeafCodec.LengthSnapshotBound, bytes.Length);
                var leaf = ClaimLeafCodec.Decode(bytes);
                Assert.Equal(ClaimLeafCodec.LayoutVersionSnapshotBound, leaf.LeafLayoutVersion);
                Assert.Equal((uint)c.LeafIndex, leaf.LeafIndex);
                Assert.Equal(ulong.Parse(c.Amount), leaf.Amount);
                Assert.Equal(c.Recipient, Hex(leaf.Recipient));
                Assert.Equal(s.Header.Published.OwnershipSnapshotHash, Hex(leaf.OwnershipSnapshotHash));
                Assert.Equal(bytes, ClaimLeafCodec.Encode(leaf));
                Assert.Equal(c.LeafHash, ClaimTreeVerifier.LeafHash(bytes));
                Assert.True(c.Path.Count <= s.Header.LevelSizes.Count - 1);
                Assert.True(ClaimPayloadVerification.Verify(c, s.Header.Published));
            }
        }

        [Fact]
        public void ReadModelClaimsAreIdenticalToTheInMemoryLookupsClaims()
        {
            var s = Load();
            var large = LoadLargeTree().Claims.ToDictionary(c => c.PartyId);
            Assert.Equal(large.Count, s.Claims.Count);
            for (var i = 0; i < s.Claims.Count; i++)
            {
                var c = s.Claims[i];
                Assert.Equal(JsonConvert.SerializeObject(large[c.PartyId]), JsonConvert.SerializeObject(c));
                // A single-holder lookup read 2 + path-length records.
                Assert.Equal(c.PartyId, s.Reads[i].PartyId);
                Assert.Equal(2 + c.Path.Count, s.Reads[i].Gets);
            }
        }
    }
}
