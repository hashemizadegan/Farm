using System;
using System.IO;
using Metafarm.Twin.Core.Mocks;

namespace Metafarm.Twin.Core.Tests
{
    internal static class Samples
    {
        public static string Read(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Samples", name));

        public static SampleTransport Transport() => new SampleTransport()
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/farms/{SampleIds.FarmId}/scene", Read("scene.sample.json"))
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/assets/{SampleIds.BuildingAssetId}", Read("asset-detail.sample.json"))
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/data-commitments/{SampleIds.CommitmentId}/proof", Read("commitment-proof.sample.json"));
    }
}
