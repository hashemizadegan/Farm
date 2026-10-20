using System;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Transport;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Api
{
    /// <summary>Reads the twin API for one workspace through an <see cref="ITwinTransport"/>.</summary>
    public sealed class TwinReadClient : ITwinReadApi
    {
        private readonly ITwinTransport _transport;
        private readonly string _tenantId;

        public TwinReadClient(ITwinTransport transport, string tenantId)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            _tenantId = RequireId(tenantId, nameof(tenantId));
        }

        public Task<TwinScene> GetSceneAsync(string farmId, string cursor = null, int limit = 200, CancellationToken cancellationToken = default)
        {
            if (limit < 1 || limit > 500) throw new ArgumentOutOfRangeException(nameof(limit), "limit must be 1-500");
            var query = $"?limit={limit}" + (cursor == null ? "" : $"&cursor={RequireId(cursor, nameof(cursor))}");
            return GetAsync<TwinScene>($"/farms/{RequireId(farmId, nameof(farmId))}/scene{query}", cancellationToken);
        }

        public Task<TwinAssetDetail> GetAssetAsync(string assetId, CancellationToken cancellationToken = default) =>
            GetAsync<TwinAssetDetail>($"/assets/{RequireId(assetId, nameof(assetId))}", cancellationToken);

        public Task<DataCommitmentProof> GetCommitmentProofAsync(string commitmentId, CancellationToken cancellationToken = default) =>
            GetAsync<DataCommitmentProof>($"/data-commitments/{RequireId(commitmentId, nameof(commitmentId))}/proof", cancellationToken);

        private async Task<T> GetAsync<T>(string twinPath, CancellationToken cancellationToken)
        {
            var response = await _transport.GetAsync($"/v1/tenants/{_tenantId}/twin{twinPath}", cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccess)
            {
                ApiError error = null;
                try { error = JsonConvert.DeserializeObject<ApiError>(response.Body ?? ""); }
                catch (JsonException) { }
                throw new TwinApiException(response.Status, error, $"request failed ({response.Status})");
            }
            return JsonConvert.DeserializeObject<T>(response.Body);
        }

        /// <summary>Ids are UUIDs; anything else is refused before it reaches a URL.</summary>
        private static string RequireId(string value, string name)
        {
            if (!Guid.TryParseExact(value ?? "", "D", out var id)) throw new ArgumentException($"{name} must be a UUID", name);
            return id.ToString("D");
        }
    }
}
