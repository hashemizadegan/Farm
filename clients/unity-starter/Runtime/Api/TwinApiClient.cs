// Read-only client for the digital-twin API. It never signs or submits anything.
//
// Authentication: an OIDC access token for the signed-in user (authorization code + PKCE in the
// system browser). Supply it through ITokenSource; never embed tokens or secrets in a build.
using System;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine.Networking;

namespace Metafarm.Twin.Api
{
    public interface ITokenSource
    {
        Task<string> GetAccessTokenAsync();
    }

    public sealed class TwinApiException : Exception
    {
        public readonly long Status;
        public readonly ApiError Error;
        public TwinApiException(long status, ApiError error, string fallback)
            : base(error?.Message ?? fallback) { Status = status; Error = error; }
    }

    public sealed class TwinApiClient
    {
        private readonly string _baseUrl;     // e.g. https://api.example.org (no trailing slash)
        private readonly string _tenantId;
        private readonly ITokenSource _tokens;
        public int TimeoutSeconds = 20;

        public TwinApiClient(string baseUrl, string tenantId, ITokenSource tokens)
        {
            if (!baseUrl.StartsWith("https://") && !baseUrl.StartsWith("http://localhost"))
                throw new ArgumentException("the API must be reached over https");
            _baseUrl = baseUrl.TrimEnd('/');
            _tenantId = tenantId;
            _tokens = tokens;
        }

        public Task<TwinScene> GetSceneAsync(string farmId, string cursor = null, int limit = 200) =>
            GetAsync<TwinScene>($"/twin/farms/{Uri.EscapeDataString(farmId)}/scene?limit={limit}" + (cursor == null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"));

        public Task<TwinAssetDetail> GetAssetAsync(string assetId) =>
            GetAsync<TwinAssetDetail>($"/twin/assets/{Uri.EscapeDataString(assetId)}");

        private async Task<T> GetAsync<T>(string path)
        {
            var url = $"{_baseUrl}/v1/tenants/{Uri.EscapeDataString(_tenantId)}{path}";
            using var req = UnityWebRequest.Get(url);
            req.timeout = TimeoutSeconds;
            req.SetRequestHeader("Authorization", "Bearer " + await _tokens.GetAccessTokenAsync());
            req.SetRequestHeader("Accept", "application/json");
            await Send(req);
            var body = req.downloadHandler.text;
            if (req.result != UnityWebRequest.Result.Success)
            {
                ApiError err = null;
                try { err = JsonConvert.DeserializeObject<ApiError>(body); } catch (JsonException) { }
                throw new TwinApiException(req.responseCode, err, $"request failed ({req.responseCode})");
            }
            return JsonConvert.DeserializeObject<T>(body);
        }

        private static Task Send(UnityWebRequest req)
        {
            var done = new TaskCompletionSource<bool>();
            req.SendWebRequest().completed += _ => done.TrySetResult(true);
            return done.Task;
        }
    }
}
