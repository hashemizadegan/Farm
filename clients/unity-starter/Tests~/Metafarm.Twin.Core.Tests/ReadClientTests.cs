using System;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    public class ReadClientTests
    {
        [Fact]
        public async Task ReadsTheSampleSceneWithLayersAndChainIdentities()
        {
            var api = new TwinReadClient(Samples.Transport(), SampleIds.TenantId);
            var scene = await api.GetSceneAsync(SampleIds.FarmId);
            Assert.Equal(TwinScene.Scheme1, scene.Scheme);
            Assert.Equal(new[] { "plots", "crops_trees", "buildings", "storage" }, scene.Objects.Select(o => o.Layer).ToArray());
            var plot = scene.Objects[0];
            Assert.Equal("Polygon", (string)plot.Geometry["type"]);
            Assert.Equal("SOLANA_BUBBLEGUM_CNFT", plot.Chain.Single().Rail);
            Assert.Null(scene.Objects[3].Geometry);
            Assert.Null(scene.NextCursor);
            Assert.Equal(5, scene.Farm.Outline.Count);
        }

        [Fact]
        public async Task ReadsAnAssetWithOwnershipAsStrings()
        {
            var api = new TwinReadClient(Samples.Transport(), SampleIds.TenantId);
            var detail = await api.GetAssetAsync(SampleIds.BuildingAssetId);
            var ownership = detail.Ownership.Single();
            Assert.Equal("indexed", ownership.Status);
            Assert.Equal("310000900", ownership.AsOfSlot);
            Assert.Equal("750000", ownership.Holders[0].Amount);
            Assert.Equal(3L, detail.DataCommitments.Single().ByteSize);
        }

        [Fact]
        public async Task SurfacesApiErrors()
        {
            var api = new TwinReadClient(Samples.Transport(), SampleIds.TenantId);
            var ex = await Assert.ThrowsAsync<TwinApiException>(() => api.GetAssetAsync(Guid.NewGuid().ToString()));
            Assert.Equal(404, ex.Status);
            Assert.Equal("not_found", ex.Error.Error);
        }

        [Fact]
        public async Task RefusesIdsThatAreNotUuidsBeforeAnyRequest()
        {
            var transport = Samples.Transport();
            var api = new TwinReadClient(transport, SampleIds.TenantId);
            await Assert.ThrowsAsync<ArgumentException>(() => api.GetAssetAsync("../../admin"));
            await Assert.ThrowsAsync<ArgumentException>(() => api.GetSceneAsync(SampleIds.FarmId, cursor: "x&limit=9999"));
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => api.GetSceneAsync(SampleIds.FarmId, limit: 0));
            Assert.Empty(transport.Requests);
            Assert.Throws<ArgumentException>(() => new TwinReadClient(transport, "not-a-tenant"));
        }

        [Fact]
        public async Task OnlyReadsTwinPathsOfItsWorkspace()
        {
            var transport = Samples.Transport();
            var api = new TwinReadClient(transport, SampleIds.TenantId);
            await api.GetSceneAsync(SampleIds.FarmId);
            await api.GetAssetAsync(SampleIds.BuildingAssetId);
            await api.GetCommitmentProofAsync(SampleIds.CommitmentId);
            Assert.All(transport.Requests, p => Assert.StartsWith($"/v1/tenants/{SampleIds.TenantId}/twin/", p));
        }
    }
}
