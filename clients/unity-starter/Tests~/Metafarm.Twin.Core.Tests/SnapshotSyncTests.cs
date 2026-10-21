using System;
using System.Linq;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Sync;
using Metafarm.Twin.Core.Verification;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>
    /// sync-a/b/c.content.sample.json were built by the platform's buildFarmSnapshot (re-derived in
    /// client-samples.test.ts): A at 06:00; B at 07:00 with structure/3333 removed, structure/5555 added,
    /// machine/2222 and plot/1111 changed, three entities unchanged; C at 07:00 like B but with other stock.
    /// </summary>
    public class SnapshotSyncTests
    {
        private static readonly string Base = $"/v1/tenants/{SampleIds.TenantId}/twin";
        private static readonly JObject Records = JObject.Parse(Samples.Read("sync-commitments.sample.json"));

        private static string Id(string name) => (string)Records[name]["id"];

        /// <summary>A server whose newest record is <paramref name="name"/>, serving that record's bytes.</summary>
        private static SampleTransport Serving(string name, string content = null, JObject record = null)
        {
            var rec = record ?? (JObject)Records[name].DeepClone();
            var list = new JObject { ["items"] = new JArray(rec), ["nextCursor"] = null };
            var t = new SampleTransport().Add($"{Base}/farms/{SampleIds.FarmId}/snapshots", list.ToString());
            if (content != null || name != null) t.Add($"{Base}/snapshots/{(string)rec["id"]}/content", content ?? Samples.Read($"sync-{name}.content.sample.json"));
            return t;
        }

        private static Task<SnapshotSyncResult> Sync(SampleTransport t, FarmSnapshotState state) =>
            new SnapshotSync(new TwinReadClient(t, SampleIds.TenantId)).SyncAsync(state);

        /// <summary>A state holding snapshot <paramref name="name"/>, reached through a real sync.</summary>
        private static async Task<FarmSnapshotState> Holding(string name)
        {
            var s = new FarmSnapshotState(SampleIds.FarmId);
            Assert.Equal(SnapshotSyncOutcome.Initial, (await Sync(Serving(name), s)).Outcome);
            return s;
        }

        private static string[] Keys(System.Collections.Generic.IEnumerable<SnapshotEntity> es) => es.Select(e => $"{e.Type}/{e.Id.Substring(0, 4)}").ToArray();

        [Fact]
        public async Task FirstSyncVerifiesAndAddsEveryEntity()
        {
            var t = Serving("a");
            var state = new FarmSnapshotState(SampleIds.FarmId);
            var r = await Sync(t, state);
            Assert.Equal(SnapshotSyncOutcome.Initial, r.Outcome);
            Assert.True(r.Accepted);
            Assert.Equal(Id("a"), state.CommitmentId);
            Assert.Equal(r.Snapshot.SnapshotId, state.Snapshot.SnapshotId);
            Assert.NotSame(r.Snapshot, state.Snapshot);
            Assert.Equal((string)Records["a"]["contentSha256"], state.ContentSha256);
            Assert.Equal(new[] { "animal/7777", "crop/6666", "inventory/4444", "machine/2222", "plot/1111", "structure/3333" }, Keys(r.Diff.Added));
            Assert.Empty(r.Diff.Removed);
            Assert.Empty(r.Diff.Changed);
            // Normal polling: list plus content, nothing else.
            Assert.Equal(2, t.Requests.Count);
            Assert.EndsWith("/content", t.Requests[1]);
        }

        [Fact]
        public async Task ANewerSnapshotGivesAMixedDiffInPlatformOrder()
        {
            var state = await Holding("a");
            var r = await Sync(Serving("b"), state);
            Assert.Equal(SnapshotSyncOutcome.Updated, r.Outcome);
            Assert.Equal(Id("b"), state.CommitmentId);
            Assert.Equal(new[] { "structure/5555" }, Keys(r.Diff.Added));
            Assert.Equal(new[] { "structure/3333" }, Keys(r.Diff.Removed));
            Assert.Equal(new[] { "machine/2222", "plot/1111" }, r.Diff.Changed.Select(c => $"{c.Type}/{c.Id.Substring(0, 4)}").ToArray());
            Assert.Equal("4310.5", (string)r.Diff.Changed[0].Before.Data["hourMeter"]);
            Assert.Equal("4322.0", (string)r.Diff.Changed[0].After.Data["hourMeter"]);
            Assert.Equal(3, r.Diff.UnchangedCount);
        }

        [Fact]
        public async Task TheHeldRecordIsNotFetchedAgain()
        {
            var state = await Holding("a");
            var t = Serving("a");
            var r = await Sync(t, state);
            Assert.Equal(SnapshotSyncOutcome.UpToDate, r.Outcome);
            Assert.Single(t.Requests);
        }

        [Fact]
        public async Task AMatchingRecordIdAloneDoesNotSkipVerification()
        {
            // Same id as the held record but another content hash: the bytes are fetched and checked.
            var state = await Holding("a");
            var record = (JObject)Records["a"].DeepClone();
            record["contentSha256"] = new string('f', 64);
            var t = Serving("a", record: record);
            var r = await Sync(t, state);
            Assert.Equal(SnapshotSyncOutcome.VerificationFailed, r.Outcome);
            Assert.Equal(SnapshotFailure.ContentMismatch, r.Failure);
            Assert.Equal(2, t.Requests.Count);
            Assert.Equal((string)Records["a"]["contentSha256"], state.ContentSha256);
        }

        [Fact]
        public void BeforeTheFirstSyncNothingIsHeld()
        {
            var state = new FarmSnapshotState(SampleIds.FarmId);
            Assert.False(state.HasSnapshot);
            Assert.Null(state.Snapshot);
            Assert.Null(state.CommitmentId);
            Assert.Null(state.ContentSha256);
        }

        [Fact]
        public async Task ChangingWhatTheCallerReceivedNeverChangesTheHeldBaseline()
        {
            var state = new FarmSnapshotState(SampleIds.FarmId);
            var first = await Sync(Serving("a"), state);
            // Tamper with everything handed out: the result's snapshot, the diff's entities, a copy of the state.
            first.Snapshot.Entities.Clear();
            first.Snapshot.TakenAt = "2099-01-01T00:00:00.000Z";
            first.Diff.Added[0].Data["name"] = "edited";
            first.Diff.Added[0].Sha256 = new string('0', 64);
            var copy = state.Snapshot;
            copy.TakenAt = "2099-01-01T00:00:00.000Z";
            copy.Entities.RemoveAt(0);

            Assert.Equal("2026-10-21T06:00:00.000Z", state.Snapshot.TakenAt);
            Assert.Equal(6, state.Snapshot.Entities.Count);
            Assert.Empty(SnapshotVerifier.CheckStructure(state.Snapshot));

            // The next sync still compares against the verified A: same mixed diff as without tampering.
            var r = await Sync(Serving("b"), state);
            Assert.Equal(SnapshotSyncOutcome.Updated, r.Outcome);
            Assert.Equal(new[] { "structure/5555" }, Keys(r.Diff.Added));
            Assert.Equal(new[] { "structure/3333" }, Keys(r.Diff.Removed));
            Assert.Equal(2, r.Diff.Changed.Count);
            Assert.Equal(3, r.Diff.UnchangedCount);

            // And the diff's "before" side is a copy too.
            r.Diff.Changed[0].Before.Data["hourMeter"] = "0";
            Assert.Equal(SnapshotSyncOutcome.Rollback, (await Sync(Serving("a"), state)).Outcome);
        }

        [Fact]
        public async Task TheSameVerifiedSnapshotUnderAnotherRecordIsUnchanged()
        {
            var state = await Holding("a");
            var record = (JObject)Records["a"].DeepClone();
            record["id"] = "a1000000-0000-4000-8000-0000000000aa";
            var r = await Sync(Serving("a", record: record), state);
            Assert.Equal(SnapshotSyncOutcome.Unchanged, r.Outcome);
            Assert.False(r.Accepted);
            Assert.Null(r.Diff);
            Assert.Equal(Id("a"), state.CommitmentId);
        }

        [Fact]
        public async Task RejectsAnOlderSnapshotAsRollbackAndKeepsHeldState()
        {
            var state = await Holding("b");
            var held = state.Snapshot.SnapshotId;
            var r = await Sync(Serving("a"), state);
            Assert.Equal(SnapshotSyncOutcome.Rollback, r.Outcome);
            Assert.Null(r.Diff);
            Assert.Null(r.Snapshot);
            Assert.Contains("before the held one", r.Problems.Single());
            Assert.Equal(held, state.Snapshot.SnapshotId);
            Assert.Equal(Id("b"), state.CommitmentId);
        }

        [Fact]
        public async Task RejectsEqualTimeWithDifferentContentAsConflict()
        {
            var state = await Holding("b");
            var held = state.Snapshot.SnapshotId;
            var r = await Sync(Serving("c"), state);
            Assert.Equal(SnapshotSyncOutcome.Conflict, r.Outcome);
            Assert.Null(r.Diff);
            Assert.Equal(held, state.Snapshot.SnapshotId);
            Assert.Equal(Id("b"), state.CommitmentId);
        }

        [Fact]
        public async Task RejectsTamperedBytesAndKeepsHeldState()
        {
            var state = await Holding("a");
            var tampered = Samples.Read("sync-b.content.sample.json").Replace("4322.0", "9999.0");
            var r = await Sync(Serving("b", content: tampered), state);
            Assert.Equal(SnapshotSyncOutcome.VerificationFailed, r.Outcome);
            Assert.Equal(SnapshotFailure.ContentMismatch, r.Failure);
            Assert.Null(r.Diff);
            Assert.Equal(Id("a"), state.CommitmentId);
        }

        [Fact]
        public async Task RejectsBytesThatMatchTheirRecordButFailTheStructureCheck()
        {
            // A record that commits to bytes whose root does not match their entities: the hash matches, the structure does not.
            var bad = Samples.Read("sync-b.content.sample.json").Replace("\"entityCount\":6", "\"entityCount\":5");
            var record = (JObject)Records["b"].DeepClone();
            record["contentSha256"] = Sha256(bad);
            var state = await Holding("a");
            var r = await Sync(Serving("b", content: bad, record: record), state);
            Assert.Equal(SnapshotSyncOutcome.VerificationFailed, r.Outcome);
            Assert.Equal(SnapshotFailure.StructureInvalid, r.Failure);
            Assert.Null(r.Diff);
            Assert.Equal(Id("a"), state.CommitmentId);
        }

        [Fact]
        public async Task RejectsAnotherFarmEvenOnTheFirstSync()
        {
            var state = new FarmSnapshotState(SampleIds.FarmId);
            var record = (JObject)Records["a"].DeepClone();
            record["subjectId"] = record["farmId"] = "0f0f0f0f-0000-4000-8000-000000000000";
            var t = Serving("a", record: record);
            var r = await Sync(t, state);
            Assert.Equal(SnapshotSyncOutcome.FarmMismatch, r.Outcome);
            Assert.Equal(SnapshotFailure.FarmMismatch, r.Failure);
            Assert.Null(state.Snapshot);
            Assert.Single(t.Requests); // refused before fetching any content

            // A record for the right farm whose bytes hash correctly and are a structurally valid
            // snapshot, but of another farm (header id recomputed for that farm).
            const string otherFarm = "0f0f0f0f-0000-4000-8000-000000000000";
            var a = Samples.Read("sync-a.content.sample.json");
            var parsed = TwinJson.Deserialize<FarmSnapshot>(a);
            var moved = a.Replace(SampleIds.FarmId, otherFarm);
            var movedSnapshot = TwinJson.Deserialize<FarmSnapshot>(moved);
            moved = moved.Replace(parsed.SnapshotId, SnapshotVerifier.HeaderId(movedSnapshot));
            Assert.Empty(SnapshotVerifier.CheckStructure(TwinJson.Deserialize<FarmSnapshot>(moved)));
            var forged = (JObject)Records["a"].DeepClone();
            forged["contentSha256"] = Sha256(moved);
            var r2 = await Sync(Serving("a", content: moved, record: forged), state);
            Assert.Equal(SnapshotSyncOutcome.FarmMismatch, r2.Outcome);
            Assert.Equal("the snapshot is for another farm", r2.Problems.Single());
            Assert.Null(state.Snapshot);
            Assert.Null(state.CommitmentId);
        }

        [Fact]
        public async Task ReportsMissingContentWithoutTouchingHeldState()
        {
            var state = await Holding("a");
            var t = new SampleTransport().Add($"{Base}/farms/{SampleIds.FarmId}/snapshots", new JObject { ["items"] = new JArray(Records["b"].DeepClone()), ["nextCursor"] = null }.ToString());
            var r = await Sync(t, state);
            Assert.Equal(SnapshotSyncOutcome.VerificationFailed, r.Outcome);
            Assert.Equal(SnapshotFailure.ContentUnavailable, r.Failure);
            Assert.StartsWith("snapshot content: HTTP 404 not_found", r.Problems.Single());
            Assert.Equal(Id("a"), state.CommitmentId);
        }

        [Fact]
        public async Task ReportsWhenThereIsNoSnapshot()
        {
            var empty = new SampleTransport().Add($"{Base}/farms/{SampleIds.FarmId}/snapshots", "{\"items\":[],\"nextCursor\":null}");
            var r = await Sync(empty, new FarmSnapshotState(SampleIds.FarmId));
            Assert.Equal(SnapshotSyncOutcome.NoSnapshot, r.Outcome);
        }

        [Fact]
        public void OrdersByTakenAtAndNeverBySnapshotId()
        {
            Assert.Throws<FormatException>(() => SnapshotOrdering.ParseTakenAt("2026-10-21T07:00:00Z"));
            Assert.Equal(DateTimeKind.Utc, SnapshotOrdering.ParseTakenAt("2026-10-21T07:00:00.000Z").Kind);
        }

        private static string Sha256(string s)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
                return string.Concat(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(s)).Select(b => b.ToString("x2")));
        }
    }
}
