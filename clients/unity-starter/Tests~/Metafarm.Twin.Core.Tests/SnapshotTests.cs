using System.Linq;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Verification;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>Samples/farm-snapshot.sample.json was produced by the platform's buildFarmSnapshot.</summary>
    public class SnapshotTests
    {
        private static FarmSnapshot Load() => TwinJson.Deserialize<FarmSnapshot>(Samples.Read("farm-snapshot.sample.json"));

        [Fact]
        public void ThePlatformsSnapshotChecksOut()
        {
            var s = Load();
            Assert.Equal(7, s.EntityCount);
            Assert.Equal("2026-10-20T12:00:00.000Z", s.TakenAt);
            Assert.Empty(SnapshotVerifier.CheckStructure(s));
            Assert.Equal(s.SnapshotId, SnapshotVerifier.HeaderId(s));
        }

        [Fact]
        public void ComputesTheSameRootAsThePlatform()
        {
            const string root = "5610b47577351888d614cb915e3b0d11fbc5d440a689446c1bd8e87d75194da5";
            var leaves = new[]
            {
                "a3981ed0a7f57bf7e6b199fa04741b77933e5bf7753e03fc739e48411f9e825c",
                "eda813d9aad8d78c26169d03241ab55bc56bbc8830ed7c16d1242cfdeb73961a",
                "d9e1b610b0813a5d887b9c429d7744747c5ce4160c2dd371d57b29229fd8efb1",
                "3aa1754f4d1aac016470f0ecc25b329665666cec4496d631766691a2549d0058",
                "879653c5f920149ba78b5a222b4d1fad2b917dc1d3a73b0dcc8bc3a372303b47",
            };
            Assert.Equal(root, Rfc9162CommitmentVerifier.ComputeRoot(leaves));
        }

        [Fact]
        public void NoticesTamperedHashesOrderTimeAndRoot()
        {
            var hash = Load();
            hash.Entities[2].Sha256 = hash.Entities[3].Sha256;
            Assert.Contains("root does not match the entity hashes", SnapshotVerifier.CheckStructure(hash));

            var order = Load();
            order.Entities.Reverse();
            Assert.Contains("entities are not in (type, id) order or repeat", SnapshotVerifier.CheckStructure(order));

            var time = Load();
            time.TakenAt = "2026-10-20T12:00:01.000Z";
            Assert.Equal(new[] { "snapshotId does not match the header" }, SnapshotVerifier.CheckStructure(time).ToArray());

            var count = Load();
            count.EntityCount = 6;
            Assert.NotEmpty(SnapshotVerifier.CheckStructure(count));
        }
    }
}
