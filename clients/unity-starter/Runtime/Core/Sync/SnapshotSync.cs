// Keeps a client's copy of a farm's state current: compare the newest snapshot commitment with the
// one held, fetch only when it changed, and accept the new snapshot only if the server's check and
// the client's own structure check (order, Merkle root, snapshot id) both pass. Read-only.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Verification;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotSync
    {
        private readonly ITwinReadApi _api;

        public SnapshotSync(ITwinReadApi api) => _api = api ?? throw new ArgumentNullException(nameof(api));

        /// <param name="heldCommitmentId">The commitment of the snapshot the client holds, or null.</param>
        public async Task<SnapshotSyncResult> SyncAsync(string farmId, string heldCommitmentId, CancellationToken cancellationToken = default)
        {
            var newest = (await _api.ListSnapshotsAsync(farmId, null, 1, cancellationToken).ConfigureAwait(false)).Items.FirstOrDefault();
            if (newest == null) return new SnapshotSyncResult(SnapshotSyncOutcome.NoSnapshot, null, null, null);
            if (newest.Id == heldCommitmentId) return new SnapshotSyncResult(SnapshotSyncOutcome.UpToDate, newest.Id, null, null);

            var doc = await _api.GetSnapshotAsync(newest.Id, cancellationToken).ConfigureAwait(false);
            var problems = new List<string>();
            if (doc?.Check == null || !doc.Check.Ok) problems.Add("the server's check did not pass");
            if (doc?.Snapshot == null) problems.Add("no snapshot in the response");
            else
            {
                problems.AddRange(SnapshotVerifier.CheckStructure(doc.Snapshot));
                if (doc.Snapshot.FarmId != farmId) problems.Add("the snapshot is for another farm");
            }
            return problems.Count == 0
                ? new SnapshotSyncResult(SnapshotSyncOutcome.Updated, newest.Id, doc.Snapshot, null)
                : new SnapshotSyncResult(SnapshotSyncOutcome.VerificationFailed, newest.Id, null, problems);
        }
    }
}
