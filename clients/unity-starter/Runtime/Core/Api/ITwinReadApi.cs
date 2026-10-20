// The read-only twin API the game uses. Mock it, or back it with SampleTransport, to run offline.
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Api
{
    public interface ITwinReadApi
    {
        Task<TwinScene> GetSceneAsync(string farmId, string cursor = null, int limit = 200, CancellationToken cancellationToken = default);
        Task<TwinAssetDetail> GetAssetAsync(string assetId, CancellationToken cancellationToken = default);
        Task<DataCommitmentProof> GetCommitmentProofAsync(string commitmentId, CancellationToken cancellationToken = default);
    }
}
