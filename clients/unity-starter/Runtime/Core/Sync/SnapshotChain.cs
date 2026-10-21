// Verifies a snapshot from the bytes the client renders up to the root that would be anchored,
// trusting none of the API's own checks:
//   1. content:   SHA-256 of the stored bytes (GET …/snapshots/{id}/content) = the commitment's hash
//   2. structure: those same bytes parse to a snapshot whose order, Merkle root and id check out
//   3. inclusion: the commitment's RFC 9162 proof (GET …/data-commitments/{id}/proof) reaches the
//                 batch root, starting from the leaf of that same content hash
//   4. anchor plan (optional): the batch's plan is plan-only and names that root
// Read-only: GET requests through ITwinReadApi only.
using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Anchoring;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Verification;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotChain
    {
        public const string SnapshotSchema = "metafarm.farm-snapshot";
        private readonly ITwinReadApi _api;
        private readonly Rfc9162CommitmentVerifier _verifier = new Rfc9162CommitmentVerifier();

        public SnapshotChain(ITwinReadApi api) => _api = api ?? throw new ArgumentNullException(nameof(api));

        /// <param name="anchorCarrier">An <see cref="AnchorCarriers"/> value to also review the batch's anchor plan, or null.</param>
        public async Task<SnapshotChainReport> VerifyAsync(string commitmentId, string anchorCarrier = null, CancellationToken cancellationToken = default)
        {
            if (anchorCarrier != null && !AnchorCarriers.IsCarrier(anchorCarrier)) throw new ArgumentException("unknown anchor carrier", nameof(anchorCarrier));
            var report = new SnapshotChainReport { CommitmentId = commitmentId };

            // The proof document carries the commitment (hash, schema, subject) and, when batched, the proof.
            DataCommitmentProof proofDoc;
            try { proofDoc = await _api.GetCommitmentProofAsync(commitmentId, cancellationToken).ConfigureAwait(false); }
            catch (TwinApiException e) { return Fail(report, "commitment", e); }
            var commitment = proofDoc?.Commitment;
            if (commitment == null || commitment.Id != commitmentId) return Fail(report, "the commitment in the response is not the one asked for");
            if (commitment.Schema != SnapshotSchema) return Fail(report, $"commitment {commitmentId} is not a farm snapshot");
            report.ContentSha256 = commitment.ContentSha256;

            // 1. Content.
            string body;
            try { body = await _api.GetSnapshotContentAsync(commitmentId, cancellationToken).ConfigureAwait(false); }
            catch (TwinApiException e) { return Fail(report, "snapshot content", e); }
            if (body == null || !_verifier.ContentMatches(Encoding.UTF8.GetBytes(body), commitment.ContentSha256))
                return Fail(report, "the snapshot's bytes do not match the committed hash");
            report.Content = ChainLinkState.Verified;

            // 2. Structure, of exactly those bytes.
            FarmSnapshot snapshot = null;
            try { snapshot = TwinJson.Deserialize<FarmSnapshot>(body); }
            catch (JsonException) { }
            var problems = snapshot == null ? new[] { "the snapshot's bytes are not a snapshot" } : SnapshotVerifier.CheckStructure(snapshot);
            report._problems.AddRange(problems);
            if (snapshot != null && snapshot.FarmId != commitment.SubjectId) report._problems.Add("the snapshot is for another farm than its commitment");
            if (report._problems.Count > 0) { report.Structure = ChainLinkState.Failed; return report; }
            report.Structure = ChainLinkState.Verified;
            report.Snapshot = snapshot;

            // 3. Inclusion: the proof must start from the leaf of the hash just verified (VerifyProof checks it).
            var p = proofDoc.Proof;
            if (p == null) { report.Inclusion = ChainLinkState.NotBatched; return report; }
            report.BatchId = p.BatchId;
            if (commitment.Batch != null && commitment.Batch.Id != p.BatchId) report._problems.Add("the proof is for another batch than the commitment's");
            if (report._problems.Count > 0 || !_verifier.VerifyProof(proofDoc))
            {
                if (report._problems.Count == 0) report._problems.Add("the inclusion proof does not reach the batch root");
                report.Inclusion = ChainLinkState.Failed;
                return report;
            }
            report.Inclusion = ChainLinkState.Verified;
            report.BatchRoot = p.Root;

            // 4. Anchor plan (optional), reviewed against the root the client derived.
            if (anchorCarrier == null) return report;
            BatchAnchorPlan plan;
            try { plan = await _api.GetBatchAnchorPlanAsync(p.BatchId, anchorCarrier, AnchorCarriers.SolanaDevnet, cancellationToken).ConfigureAwait(false); }
            catch (TwinApiException e)
            {
                report._problems.Add(Describe("anchor plan", e));
                report.AnchorPlan = ChainLinkState.Failed;
                return report;
            }
            report.AnchorPlanReview = AnchorPlanReview.Of(plan?.Plan, report.BatchRoot);
            if (plan?.BatchId != p.BatchId) report._problems.Add("the anchor plan is for another batch");
            report._problems.AddRange(report.AnchorPlanReview.Problems);
            report.AnchorPlan = report.AnchorPlanReview.Ok && plan?.BatchId == p.BatchId ? ChainLinkState.Verified : ChainLinkState.Failed;
            return report;
        }

        private static SnapshotChainReport Fail(SnapshotChainReport r, string what, TwinApiException e) => Fail(r, Describe(what, e));

        private static SnapshotChainReport Fail(SnapshotChainReport r, string problem)
        {
            r._problems.Add(problem);
            r.Content = ChainLinkState.Failed;
            return r;
        }

        private static string Describe(string what, TwinApiException e) =>
            $"{what}: HTTP {e.Status} {e.Error?.Error ?? "error"}" + (e.Error?.RequestId != null ? $" (request {e.Error.RequestId})" : "");
    }
}
