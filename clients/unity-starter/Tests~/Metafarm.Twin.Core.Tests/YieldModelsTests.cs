using System.Linq;
using System.Reflection;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>Y11: the yield read models parse the operator API's JSON and only read.</summary>
    public class YieldModelsTests
    {
        private const string Detail = @"{
          ""id"": ""c1"", ""businessAssetId"": ""a1"", ""period"": { ""start"": ""2026-01-01"", ""end"": ""2026-03-31"" }, ""version"": 2,
          ""simulation"": true, ""status"": ""published"", ""priorStatus"": null, ""closeReason"": null,
          ""chainAsset"": { ""network"": ""solana-devnet"", ""rail"": ""SOLANA_TOKEN_2022"", ""id"": ""7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"" },
          ""slotRange"": { ""start"": ""100"", ""end"": ""200"" },
          ""artifactSetHash"": ""5555555555555555555555555555555555555555555555555555555555555555"",
          ""merkleRoot"": ""4444444444444444444444444444444444444444444444444444444444444444"",
          ""updatedAt"": ""2026-10-22T10:00:00.000Z"",
          ""artifactSets"": [{
            ""id"": ""s1"", ""setNumber"": 1, ""status"": ""approved"",
            ""hashes"": { ""calculation"": ""11"", ""allocation"": ""22"", ""evidenceBundle"": ""33"", ""merkleRoot"": ""44"", ""set"": ""55"" },
            ""ownershipSnapshot"": { ""sourceKind"": ""fixture"", ""sourceIdentityId"": null, ""network"": ""solana-devnet"", ""slotRange"": { ""start"": ""100"", ""end"": ""200"" },
              ""cursorSlot"": ""300"", ""holdingModel"": ""slot_weighted"", ""inputCommitment"": ""66"", ""totalWeight"": ""340282366920938463463374607431768211455"" },
            ""attesters"": 1, ""createdAt"": ""2026-10-22T09:00:00.000Z""
          }]
        }";

        [Fact]
        public void ParsesACycleWithoutLosingDigitsOrTimes()
        {
            var d = TwinJson.Deserialize<YieldCycleDetail>(Detail);
            Assert.True(d.IsSimulation);
            Assert.Equal("2026-10-22T10:00:00.000Z", d.LastUpdated);
            var set = Assert.Single(d.ArtifactSets);
            Assert.Equal(1, set.AttestationCount);
            Assert.Equal("fixture", set.OwnershipSnapshot.SourceKind);
            Assert.Equal("340282366920938463463374607431768211455", set.OwnershipSnapshot.TotalWeight);
            var summary = TwinJson.Deserialize<YieldCycleSummary>(Detail);
            Assert.True(YieldStatuses.HasPublishedRoot(summary));
            Assert.False(YieldStatuses.PayoutsPaused(summary));
        }

        [Fact]
        public void NeverTreatsUnknownOrUnpublishedCyclesAsVerified()
        {
            Assert.False(YieldStatuses.HasPublishedRoot(new YieldCycleSummary { Status = "approved", MerkleRoot = "44" }));
            Assert.False(YieldStatuses.HasPublishedRoot(new YieldCycleSummary { Status = "published", MerkleRoot = null }));
            Assert.False(YieldStatuses.HasPublishedRoot(new YieldCycleSummary { Status = "something-new", MerkleRoot = "44" }));
            Assert.False(YieldStatuses.IsKnown("something-new"));
            Assert.True(YieldStatuses.PayoutsPaused(new YieldCycleSummary { Status = "disputed" }));
            Assert.Equal(13, YieldStatuses.All.Count);
        }

        [Fact]
        public void TheYieldModelsAreDataOnly()
        {
            var types = typeof(YieldCycleSummary).Assembly.GetTypes().Where(t => t.Name.StartsWith("Yield") && t.IsClass && !t.IsAbstract).ToArray();
            Assert.NotEmpty(types);
            foreach (var t in types.Where(t => t.Name != nameof(YieldStatuses)))
            {
                // Public fields only: no methods beyond object's, so a DTO cannot request or change anything.
                Assert.Empty(t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly));
                Assert.All(t.GetFields(BindingFlags.Public | BindingFlags.Instance), f => Assert.False(f.FieldType.IsSubclassOf(typeof(System.Delegate))));
            }
            // Amounts and weights are strings, never floating point.
            Assert.Equal(typeof(string), typeof(YieldAllocationView).GetField(nameof(YieldAllocationView.Amount)).FieldType);
            Assert.Equal(typeof(string), typeof(YieldOwnershipSnapshot).GetField(nameof(YieldOwnershipSnapshot.TotalWeight)).FieldType);
        }
    }
}
