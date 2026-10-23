using System;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>The yield operator read client: paths, query validation, parsing without precision loss, D-39.</summary>
    public class YieldReadClientTests
    {
        private const string Tenant = "11111111-1111-4111-8111-111111111111";
        private const string Cycle = "22222222-2222-4222-8222-222222222222";
        private const string Set = "33333333-3333-4333-8333-333333333333";
        private static string Base => $"/v1/tenants/{Tenant}/yield";

        private const string List = @"{ ""items"": [
            { ""id"": ""22222222-2222-4222-8222-222222222222"", ""period"": { ""start"": ""2026-04-01"", ""end"": ""2026-06-30"" }, ""version"": 1,
              ""simulation"": true, ""status"": ""published"", ""priorStatus"": null, ""closeReason"": null,
              ""chainAsset"": { ""network"": ""solana-devnet"", ""rail"": ""SOLANA_TOKEN_2022"", ""id"": ""7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"" },
              ""artifactSetHash"": ""5555555555555555555555555555555555555555555555555555555555555555"",
              ""merkleRoot"": ""4444444444444444444444444444444444444444444444444444444444444444"", ""updatedAt"": ""2026-10-22T10:00:00.000Z"" } ],
          ""nextCursor"": null }";

        private const string Detail = @"{ ""id"": ""22222222-2222-4222-8222-222222222222"", ""period"": { ""start"": ""2026-04-01"", ""end"": ""2026-06-30"" }, ""version"": 1,
            ""simulation"": true, ""status"": ""under_review"", ""closeReason"": null, ""artifactSetHash"": null, ""merkleRoot"": null, ""updatedAt"": ""2026-10-22T10:00:00.000Z"",
            ""artifactSets"": [ { ""id"": ""33333333-3333-4333-8333-333333333333"", ""setNumber"": 1, ""status"": ""frozen"",
              ""hashes"": { ""calculation"": ""11"", ""allocation"": ""22"", ""evidenceBundle"": ""33"", ""merkleRoot"": ""44"", ""set"": ""55"" },
              ""ownershipSnapshot"": null, ""attesters"": 1 } ] }";

        private const string Allocations = @"{ ""items"": [
            { ""kind"": ""allocated"", ""partyId"": ""44444444-4444-4444-8444-444444444444"", ""holderKey"": null, ""weight"": ""340282366920938463463374607431768211455"", ""amount"": ""18446744073709551615"" },
            { ""kind"": ""dust"", ""partyId"": null, ""holderKey"": null, ""weight"": ""1"", ""amount"": ""7"" } ] }";

        private static SampleTransport Transport() => new SampleTransport()
            .Add($"{Base}/cycles", List)
            .Add($"{Base}/cycles/{Cycle}", Detail)
            .Add($"{Base}/cycles/{Cycle}/artifact-sets/{Set}/allocations", Allocations);

        [Fact]
        public async Task ListsCyclesWithTheFiltersInTheQuery()
        {
            var transport = Transport();
            var api = new YieldReadClient(transport, Tenant);
            var list = await api.ListCyclesAsync(limit: 20, status: YieldStatuses.Published, simulation: true);
            var c = Assert.Single(list.Items);
            Assert.True(c.IsSimulation);
            Assert.True(YieldStatuses.HasPublishedRoot(c));
            Assert.Null(list.NextCursor);
            Assert.Equal($"{Base}/cycles?limit=20&status=published&simulation=true", transport.Requests.Single());
        }

        [Fact]
        public async Task ReadsACycleAndItsAllocationsWithoutLosingDigits()
        {
            var api = new YieldReadClient(Transport(), Tenant);
            var d = await api.GetCycleAsync(Cycle);
            Assert.Equal("under_review", d.Status);
            Assert.False(YieldStatuses.HasPublishedRoot(new YieldCycleSummary { Status = d.Status, MerkleRoot = d.MerkleRoot }));
            var set = Assert.Single(d.ArtifactSets);
            Assert.Equal(Set, set.ArtifactSetId);
            Assert.Null(set.OwnershipSnapshot);
            var rows = (await api.ListAllocationsAsync(Cycle, Set)).Items;
            Assert.Equal(2, rows.Count);
            Assert.Equal("340282366920938463463374607431768211455", rows[0].Weight);
            Assert.Equal("18446744073709551615", rows[0].Amount);
            Assert.Null(rows[1].PartyId);
        }

        [Fact]
        public async Task RefusesBadIdsLimitsAndStatusesBeforeAnyRequest()
        {
            var transport = Transport();
            var api = new YieldReadClient(transport, Tenant);
            await Assert.ThrowsAsync<ArgumentException>(() => api.GetCycleAsync("../../admin"));
            await Assert.ThrowsAsync<ArgumentException>(() => api.ListAllocationsAsync(Cycle, "x"));
            await Assert.ThrowsAsync<ArgumentException>(() => api.ListCyclesAsync(cursor: "1&limit=1000"));
            await Assert.ThrowsAsync<ArgumentException>(() => api.ListCyclesAsync(status: "paid"));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => api.ListCyclesAsync(limit: 0));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => api.ListCyclesAsync(limit: 101));
            Assert.Throws<ArgumentException>(() => new YieldReadClient(transport, "not-a-uuid"));
            Assert.Empty(transport.Requests);
        }

        [Fact]
        public async Task SurfacesApiErrors()
        {
            var api = new YieldReadClient(Transport(), Tenant);
            var ex = await Assert.ThrowsAsync<TwinApiException>(() => api.GetCycleAsync(Guid.NewGuid().ToString()));
            Assert.Equal(404, ex.Status);
            Assert.Equal("not_found", ex.Error.Error);
        }

        [Fact]
        public void TheReadApiOnlyReads()
        {
            var names = typeof(IYieldReadApi).GetMethods().Select(m => m.Name).ToArray();
            Assert.All(names, n => Assert.True(n.StartsWith("List") || n.StartsWith("Get"), n));
        }

        [Fact]
        public void TheD39BannerIsFixedEnglishAndFailsClosedForNonSimulationCycles()
        {
            Assert.Equal("D-39/simulation-banner/2026-10-22", YieldDisclosure.Id);
            Assert.StartsWith("SIMULATION ONLY:", YieldDisclosure.SimulationBanner);
            Assert.Equal("en", YieldDisclosure.Language);
            Assert.Equal(YieldDisclosure.SimulationBanner, YieldDisclosure.For(new YieldCycleSummary { IsSimulation = true }));
            Assert.Throws<InvalidOperationException>(() => YieldDisclosure.For(new YieldCycleSummary { IsSimulation = false }));
            Assert.Throws<ArgumentNullException>(() => YieldDisclosure.For(null));
        }
    }
}
