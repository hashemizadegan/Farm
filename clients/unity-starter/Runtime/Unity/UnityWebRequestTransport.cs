// HTTP transport for the twin API on UnityWebRequest. GET only, over https (http only for localhost
// during development). The bearer token comes from an ITokenSource implemented by the game.
using System;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Auth;
using Metafarm.Twin.Core.Transport;
using UnityEngine.Networking;

namespace Metafarm.Twin.Unity
{
    public sealed class UnityWebRequestTransport : ITwinTransport
    {
        private readonly string _baseUrl;
        private readonly ITokenSource _tokens;

        public UnityWebRequestTransport(string baseUrl, ITokenSource tokens)
        {
            if (string.IsNullOrEmpty(baseUrl)) throw new ArgumentException("baseUrl is required", nameof(baseUrl));
            if (!baseUrl.StartsWith("https://", StringComparison.Ordinal) && !baseUrl.StartsWith("http://localhost", StringComparison.Ordinal))
                throw new ArgumentException("the API must be reached over https", nameof(baseUrl));
            if (baseUrl.Contains("@") || baseUrl.Contains("?")) throw new ArgumentException("the base URL must not carry credentials or a query", nameof(baseUrl));
            _baseUrl = baseUrl.TrimEnd('/');
            _tokens = tokens ?? throw new ArgumentNullException(nameof(tokens));
        }

        public int TimeoutSeconds { get; set; } = 20;

        public async Task<TransportResponse> GetAsync(string pathAndQuery, CancellationToken cancellationToken = default)
        {
            using (var request = UnityWebRequest.Get(_baseUrl + pathAndQuery))
            {
                request.timeout = TimeoutSeconds;
                request.SetRequestHeader("Accept", "application/json");
                var token = await _tokens.GetAccessTokenAsync(cancellationToken);
                if (!string.IsNullOrEmpty(token)) request.SetRequestHeader("Authorization", "Bearer " + token);

                var done = new TaskCompletionSource<bool>();
                using (cancellationToken.Register(() => { request.Abort(); done.TrySetCanceled(); }))
                {
                    request.SendWebRequest().completed += _ => done.TrySetResult(true);
                    await done.Task;
                }
                return new TransportResponse(request.responseCode, request.downloadHandler?.text);
            }
        }
    }
}
