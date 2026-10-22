// The read-only yield operator API (GET /v1/tenants/{tenantId}/yield/...). Staff views only: the caller's token
// needs yield:read. Nothing here creates, approves, publishes, signs or pays: the transport is GET-only.
// Every view of these results must show YieldDisclosure.SimulationBanner (D-39).
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Api
{
    public interface IYieldReadApi
    {
        /// <summary>Cycles, newest first. <paramref name="status"/> must be one of <see cref="YieldStatuses.All"/>.</summary>
        Task<YieldCycleList> ListCyclesAsync(string cursor = null, int limit = 50, string status = null, bool? simulation = null, CancellationToken cancellationToken = default);
        /// <summary>One cycle with its artifact sets (hashes, ownership snapshot, attestation count).</summary>
        Task<YieldCycleDetail> GetCycleAsync(string cycleId, CancellationToken cancellationToken = default);
        /// <summary>The allocation rows of one artifact set of a cycle. Amounts and weights stay decimal strings.</summary>
        Task<YieldAllocationList> ListAllocationsAsync(string cycleId, string artifactSetId, CancellationToken cancellationToken = default);
    }
}
