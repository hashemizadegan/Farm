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
        /// <summary>A farm's snapshot commitments, newest first.</summary>
        Task<SnapshotList> ListSnapshotsAsync(string farmId, string cursor = null, int limit = 10, CancellationToken cancellationToken = default);
        Task<FarmSnapshotDocument> GetSnapshotAsync(string commitmentId, CancellationToken cancellationToken = default);
        /// <summary>What would anchor a snapshot's root on Solana. Data only: never executed.</summary>
        Task<SnapshotAnchorPlan> GetSnapshotAnchorPlanAsync(string commitmentId, string carrier, string network = AnchorCarriers.SolanaDevnet, CancellationToken cancellationToken = default);
        /// <summary>What would anchor a commitment batch's root on Solana. Data only: never executed.</summary>
        Task<BatchAnchorPlan> GetBatchAnchorPlanAsync(string batchId, string carrier, string network = AnchorCarriers.SolanaDevnet, CancellationToken cancellationToken = default);
    }
}
