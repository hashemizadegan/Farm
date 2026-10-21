// Keeps a client's copy of a farm's state current, verified and never moving backwards.
// Normal polling is two GET requests: the newest snapshot record (list, limit 1) and that record's
// exact bytes (…/snapshots/{id}/content). A candidate is held only if
//   1. the record is a farm snapshot for the requested farm (also on the first sync),
//   2. SHA-256 of the exact bytes is the record's content hash, and those same bytes parse to a
//      snapshot whose structure checks out for the same farm (SnapshotContentVerification), and
//   3. it is newer than the held snapshot (rollback protection relative to held state; see
//      SnapshotOrdering for what that does and does not guarantee).
// Batch inclusion and anchor plans are deeper, optional checks: use SnapshotChain for those.
// Read-only.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotSync
    {
        private readonly ITwinReadApi _api;

        public SnapshotSync(ITwinReadApi api) => _api = api ?? throw new ArgumentNullException(nameof(api));

        /// <summary>Checks for a newer snapshot and, only when it verifies and is newer, replaces <paramref name="state"/>.</summary>
        public async Task<SnapshotSyncResult> SyncAsync(FarmSnapshotState state, CancellationToken cancellationToken = default)
        {
            if (state == null) throw new ArgumentNullException(nameof(state));
            var newest = (await _api.ListSnapshotsAsync(state.FarmId, null, 1, cancellationToken).ConfigureAwait(false)).Items.FirstOrDefault();
            if (newest == null) return Result(SnapshotSyncOutcome.NoSnapshot, null);
            if (state.CommitmentId != null && newest.Id == state.CommitmentId) return Result(SnapshotSyncOutcome.UpToDate, newest.Id);

            var refused = SnapshotContentVerification.CheckRecord(newest, state.FarmId);
            if (refused != null) return Rejected(newest.Id, refused);

            string body;
            try { body = await _api.GetSnapshotContentAsync(newest.Id, cancellationToken).ConfigureAwait(false); }
            catch (TwinApiException e)
            {
                var problem = $"snapshot content: HTTP {e.Status} {e.Error?.Error ?? "error"}" + (e.Error?.RequestId != null ? $" (request {e.Error.RequestId})" : "");
                return new SnapshotSyncResult(SnapshotSyncOutcome.VerificationFailed, newest.Id, null, null, SnapshotFailure.ContentUnavailable, new List<string> { problem });
            }
            var verified = SnapshotContentVerification.Check(newest, body, state.FarmId);
            if (!verified.Ok) return Rejected(newest.Id, verified);

            var candidate = verified.Snapshot;
            switch (SnapshotOrdering.Compare(state.Snapshot, candidate))
            {
                case SnapshotOrder.Identical:
                    return Result(SnapshotSyncOutcome.Unchanged, newest.Id);
                case SnapshotOrder.Older:
                    return Result(SnapshotSyncOutcome.Rollback, newest.Id, $"the snapshot was taken at {candidate.TakenAt}, before the held one ({state.Snapshot.TakenAt})");
                case SnapshotOrder.Conflict:
                    return Result(SnapshotSyncOutcome.Conflict, newest.Id, $"the snapshot has the held one's time ({candidate.TakenAt}) but different content");
                case SnapshotOrder.NothingHeld:
                    return Accept(state, SnapshotSyncOutcome.Initial, newest.Id, candidate);
                default:
                    return Accept(state, SnapshotSyncOutcome.Updated, newest.Id, candidate);
            }
        }

        private static SnapshotSyncResult Accept(FarmSnapshotState state, SnapshotSyncOutcome outcome, string commitmentId, FarmSnapshot candidate)
        {
            // Compute the diff before replacing, so a failure here leaves the held state as it was.
            var diff = SnapshotDiff.Between(state.Snapshot, candidate);
            state.Replace(commitmentId, candidate);
            return new SnapshotSyncResult(outcome, commitmentId, candidate, diff, SnapshotFailure.None, null);
        }

        private static SnapshotSyncResult Rejected(string commitmentId, SnapshotContentVerification v) =>
            new SnapshotSyncResult(v.Failure == SnapshotFailure.FarmMismatch ? SnapshotSyncOutcome.FarmMismatch : SnapshotSyncOutcome.VerificationFailed, commitmentId, null, null, v.Failure, v.Problems);

        private static SnapshotSyncResult Result(SnapshotSyncOutcome outcome, string commitmentId, string problem = null) =>
            new SnapshotSyncResult(outcome, commitmentId, null, null, SnapshotFailure.None, problem == null ? null : new List<string> { problem });
    }
}
