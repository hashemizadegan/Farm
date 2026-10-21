// The content and structure links of a snapshot, shared by SnapshotSync and SnapshotChain:
//   - the record is a farm-snapshot commitment for the expected farm;
//   - SHA-256 of the exact received bytes equals the record's contentSha256;
//   - those same bytes parse to a snapshot whose entity order, Merkle root over the entity hashes
//     and snapshot id check out (SnapshotVerifier), for the same farm.
// It does not recompute each entity's hash from its data (that needs the platform's canonical JSON);
// the entity hashes are trusted as committed, and bound to the root and the snapshot id. Pure: no I/O.
using System.Collections.Generic;
using System.Text;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Verification;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotContentVerification
    {
        public const string SnapshotSchema = "metafarm.farm-snapshot";
        private static readonly Rfc9162CommitmentVerifier Hashes = new Rfc9162CommitmentVerifier();

        private SnapshotContentVerification(SnapshotFailure failure, ChainLinkState content, ChainLinkState structure, FarmSnapshot snapshot, IReadOnlyList<string> problems)
        {
            Failure = failure;
            Content = content;
            Structure = structure;
            Snapshot = snapshot;
            Problems = problems;
        }

        public SnapshotFailure Failure { get; }
        public ChainLinkState Content { get; }
        public ChainLinkState Structure { get; }
        /// <summary>Set only when both links are verified.</summary>
        public FarmSnapshot Snapshot { get; }
        public IReadOnlyList<string> Problems { get; }
        public bool Ok => Failure == SnapshotFailure.None;

        /// <param name="record">The commitment selected for this snapshot (from a list or a proof document).</param>
        /// <param name="body">The exact response body of GET …/snapshots/{id}/content.</param>
        /// <param name="expectedFarmId">The farm the caller asked for; null to accept the record's own farm.</param>
        public static SnapshotContentVerification Check(DataCommitment record, string body, string expectedFarmId)
        {
            var refused = CheckRecord(record, expectedFarmId);
            if (refused != null) return refused;
            var farmId = expectedFarmId ?? record.SubjectId;

            if (body == null || !Hashes.ContentMatches(Encoding.UTF8.GetBytes(body), record.ContentSha256))
                return Fail(SnapshotFailure.ContentMismatch, ChainLinkState.Failed, ChainLinkState.NotChecked, "the snapshot's bytes do not match the committed hash");

            FarmSnapshot snapshot = null;
            try { snapshot = TwinJson.Deserialize<FarmSnapshot>(body); }
            catch (JsonException) { }
            if (snapshot == null)
                return Fail(SnapshotFailure.Unreadable, ChainLinkState.Verified, ChainLinkState.Failed, "the snapshot's bytes are not a snapshot");
            var problems = SnapshotVerifier.CheckStructure(snapshot);
            if (problems.Count > 0) return new SnapshotContentVerification(SnapshotFailure.StructureInvalid, ChainLinkState.Verified, ChainLinkState.Failed, null, problems);
            if (snapshot.FarmId != farmId)
                return Fail(SnapshotFailure.FarmMismatch, ChainLinkState.Verified, ChainLinkState.Failed, "the snapshot is for another farm");
            return new SnapshotContentVerification(SnapshotFailure.None, ChainLinkState.Verified, ChainLinkState.Verified, snapshot, new List<string>());
        }

        /// <summary>The record alone, before any content is fetched: null when it may be fetched, else the refusal.</summary>
        public static SnapshotContentVerification CheckRecord(DataCommitment record, string expectedFarmId)
        {
            if (record == null || record.Schema != SnapshotSchema)
                return Fail(SnapshotFailure.NotASnapshotRecord, ChainLinkState.Failed, ChainLinkState.NotChecked, $"record {record?.Id ?? "(none)"} is not a farm snapshot");
            var farmId = expectedFarmId ?? record.SubjectId;
            if (record.SubjectId != farmId || (record.FarmId != null && record.FarmId != farmId))
                return Fail(SnapshotFailure.FarmMismatch, ChainLinkState.NotChecked, ChainLinkState.NotChecked, "the record is for another farm");
            return null;
        }

        private static SnapshotContentVerification Fail(SnapshotFailure failure, ChainLinkState content, ChainLinkState structure, string problem) =>
            new SnapshotContentVerification(failure, content, structure, null, new List<string> { problem });
    }
}
