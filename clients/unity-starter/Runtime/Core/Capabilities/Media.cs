// Storage-backed media (photos, evidence, asset models) through the platform API, never a storage vendor directly:
// GET /v1/tenants/{t}/farms/{f}/media lists confirmed files; each file's bytes are at /v1/tenants/{t}/media/{id}/content
// (members only, bearer token). The text transport lists; the Unity layer downloads bytes from ContentPath itself.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Transport;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Capabilities
{
    public sealed class MediaItem
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("farmId")] public string FarmId;
        [JsonProperty("filename")] public string Filename;
        [JsonProperty("contentType")] public string ContentType;
        [JsonProperty("byteSize")] public long ByteSize;
        [JsonProperty("purpose")] public string Purpose;
        [JsonProperty("status")] public string Status;
        [JsonProperty("createdAt")] public string CreatedAt;
    }

    public sealed class MediaList
    {
        [JsonProperty("items")] public List<MediaItem> Items = new List<MediaItem>();
    }

    public static class MediaPurposes
    {
        public static readonly IReadOnlyList<string> All = new[] { "boundary-import", "observation-photo", "verification-evidence", "asset-model" };
        public static bool IsKnown(string purpose)
        {
            foreach (var p in All) if (p == purpose) return true;
            return false;
        }
    }

    public interface IMediaSource
    {
        Capability Capability { get; }
        Task<MediaList> ListFarmMediaAsync(string farmId, string purpose = null, CancellationToken cancellationToken = default);
        /// <summary>Path (from the API root) of a file's bytes, for the engine's own download.</summary>
        string ContentPath(string mediaId);
    }

    public sealed class UnavailableMediaSource : IMediaSource
    {
        public Capability Capability { get; } = Capability.Disabled("media", "no media source configured (offline)");
        public Task<MediaList> ListFarmMediaAsync(string farmId, string purpose = null, CancellationToken cancellationToken = default) =>
            Task.FromException<MediaList>(new CapabilityUnavailableException(Capability));
        public string ContentPath(string mediaId) => throw new CapabilityUnavailableException(Capability);
    }

    public sealed class ApiMediaSource : IMediaSource
    {
        private readonly ITwinTransport _transport;
        private readonly string _tenantId;

        public ApiMediaSource(ITwinTransport transport, string tenantId)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            _tenantId = Ids.Require(tenantId, nameof(tenantId));
        }

        public Capability Capability { get; } = Capability.Enabled("media", "platform-api");

        public async Task<MediaList> ListFarmMediaAsync(string farmId, string purpose = null, CancellationToken cancellationToken = default)
        {
            if (purpose != null && !MediaPurposes.IsKnown(purpose)) throw new ArgumentException("unknown media purpose", nameof(purpose));
            var path = $"/v1/tenants/{_tenantId}/farms/{Ids.Require(farmId, nameof(farmId))}/media" + (purpose == null ? "" : $"?purpose={purpose}");
            var response = await _transport.GetAsync(path, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccess)
            {
                ApiError error = null;
                try { error = TwinJson.Deserialize<ApiError>(response.Body ?? ""); }
                catch (JsonException) { }
                throw new TwinApiException(response.Status, error, $"request failed ({response.Status})");
            }
            return TwinJson.Deserialize<MediaList>(response.Body);
        }

        public string ContentPath(string mediaId) => $"/v1/tenants/{_tenantId}/media/{Ids.Require(mediaId, nameof(mediaId))}/content";
    }

    internal static class Ids
    {
        /// <summary>Ids are UUIDs; anything else is refused before it reaches a URL.</summary>
        public static string Require(string value, string name)
        {
            if (!Guid.TryParseExact(value ?? "", "D", out var id)) throw new ArgumentException($"{name} must be a UUID", name);
            return id.ToString("D");
        }
    }
}
