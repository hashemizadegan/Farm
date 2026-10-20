// Transport for the twin API. GET only: the read client cannot change anything through it.
using System.Threading;
using System.Threading.Tasks;

namespace Metafarm.Twin.Core.Transport
{
    public interface ITwinTransport
    {
        /// <param name="pathAndQuery">Path from the API root, e.g. /v1/tenants/{id}/twin/sync-status.</param>
        Task<TransportResponse> GetAsync(string pathAndQuery, CancellationToken cancellationToken = default);
    }
}
