// Serves fixed JSON documents by path so the client runs without a backend (samples, tests).
// It records the paths asked for, so tests can show the client only reads.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Transport;

namespace Metafarm.Twin.Core.Mocks
{
    public sealed class SampleTransport : ITwinTransport
    {
        private readonly Dictionary<string, string> _documents = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly List<string> _requests = new List<string>();

        /// <summary>Serves <paramref name="json"/> for a path (the query string is ignored when matching).</summary>
        public SampleTransport Add(string path, string json)
        {
            _documents[path] = json;
            return this;
        }

        public IReadOnlyList<string> Requests => _requests;

        public Task<TransportResponse> GetAsync(string pathAndQuery, CancellationToken cancellationToken = default)
        {
            _requests.Add(pathAndQuery);
            var q = pathAndQuery.IndexOf('?');
            var path = q < 0 ? pathAndQuery : pathAndQuery.Substring(0, q);
            return Task.FromResult(_documents.TryGetValue(path, out var json)
                ? new TransportResponse(200, json)
                : new TransportResponse(404, "{\"error\":\"not_found\",\"message\":\"no sample for this path\"}"));
        }
    }
}
