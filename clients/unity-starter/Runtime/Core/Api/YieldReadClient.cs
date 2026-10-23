using System;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Transport;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Api
{
    /// <summary>Reads the yield operator API for one workspace through an <see cref="ITwinTransport"/> (GET only).</summary>
    public sealed class YieldReadClient : IYieldReadApi
    {
        private readonly ITwinTransport _transport;
        private readonly string _tenantId;

        public YieldReadClient(ITwinTransport transport, string tenantId)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            _tenantId = RequireId(tenantId, nameof(tenantId));
        }

        public Task<YieldCycleList> ListCyclesAsync(string cursor = null, int limit = 50, string status = null, bool? simulation = null, CancellationToken cancellationToken = default)
        {
            if (limit < 1 || limit > 100) throw new ArgumentOutOfRangeException(nameof(limit), "limit must be 1-100");
            if (status != null && !YieldStatuses.IsKnown(status)) throw new ArgumentException("unknown yield cycle status", nameof(status));
            var query = $"?limit={limit}"
                + (cursor == null ? "" : $"&cursor={RequireId(cursor, nameof(cursor))}")
                + (status == null ? "" : $"&status={status}")
                + (simulation == null ? "" : $"&simulation={(simulation.Value ? "true" : "false")}");
            return GetAsync<YieldCycleList>($"/cycles{query}", cancellationToken);
        }

        public Task<YieldCycleDetail> GetCycleAsync(string cycleId, CancellationToken cancellationToken = default) =>
            GetAsync<YieldCycleDetail>($"/cycles/{RequireId(cycleId, nameof(cycleId))}", cancellationToken);

        public Task<YieldAllocationList> ListAllocationsAsync(string cycleId, string artifactSetId, CancellationToken cancellationToken = default) =>
            GetAsync<YieldAllocationList>($"/cycles/{RequireId(cycleId, nameof(cycleId))}/artifact-sets/{RequireId(artifactSetId, nameof(artifactSetId))}/allocations", cancellationToken);

        private async Task<T> GetAsync<T>(string yieldPath, CancellationToken cancellationToken)
        {
            var response = await _transport.GetAsync($"/v1/tenants/{_tenantId}/yield{yieldPath}", cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccess)
            {
                ApiError error = null;
                try { error = TwinJson.Deserialize<ApiError>(response.Body ?? ""); }
                catch (JsonException) { }
                throw new TwinApiException(response.Status, error, $"request failed ({response.Status})");
            }
            return TwinJson.Deserialize<T>(response.Body);
        }

        /// <summary>Ids are UUIDs; anything else is refused before it reaches a URL.</summary>
        private static string RequireId(string value, string name)
        {
            if (!Guid.TryParseExact(value ?? "", "D", out var id)) throw new ArgumentException($"{name} must be a UUID", name);
            return id.ToString("D");
        }
    }
}
