using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Sync;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    public class SnapshotSyncTests
    {
        private const string CommitmentId = "99999999-9999-4999-8999-999999999999";

        private static SampleTransport Transport(string document = null) => new SampleTransport()
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/farms/{SampleIds.FarmId}/snapshots", Samples.Read("snapshot-list.sample.json"))
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/snapshots/{CommitmentId}", document ?? Samples.Read("snapshot-document.sample.json"));

        [Fact]
        public async Task FetchesAndVerifiesANewerSnapshot()
        {
            var sync = new SnapshotSync(new TwinReadClient(Transport(), SampleIds.TenantId));
            var r = await sync.SyncAsync(SampleIds.FarmId, null);
            Assert.Equal(SnapshotSyncOutcome.Updated, r.Outcome);
            Assert.Equal(CommitmentId, r.CommitmentId);
            Assert.Equal(7, r.Snapshot.EntityCount);
            Assert.Empty(r.Problems);
        }

        [Fact]
        public async Task DoesNotRefetchWhatItHolds()
        {
            var transport = Transport();
            var r = await new SnapshotSync(new TwinReadClient(transport, SampleIds.TenantId)).SyncAsync(SampleIds.FarmId, CommitmentId);
            Assert.Equal(SnapshotSyncOutcome.UpToDate, r.Outcome);
            Assert.Single(transport.Requests);
        }

        [Fact]
        public async Task RejectsASnapshotThatFailsVerification()
        {
            var tampered = Samples.Read("snapshot-document.sample.json").Replace("\"entityCount\": 7", "\"entityCount\": 6");
            var r = await new SnapshotSync(new TwinReadClient(Transport(tampered), SampleIds.TenantId)).SyncAsync(SampleIds.FarmId, null);
            Assert.Equal(SnapshotSyncOutcome.VerificationFailed, r.Outcome);
            Assert.Null(r.Snapshot);
            Assert.NotEmpty(r.Problems);
        }

        [Fact]
        public async Task ReportsWhenThereIsNoSnapshot()
        {
            var empty = new SampleTransport().Add($"/v1/tenants/{SampleIds.TenantId}/twin/farms/{SampleIds.FarmId}/snapshots", "{\"items\":[],\"nextCursor\":null}");
            var r = await new SnapshotSync(new TwinReadClient(empty, SampleIds.TenantId)).SyncAsync(SampleIds.FarmId, null);
            Assert.Equal(SnapshotSyncOutcome.NoSnapshot, r.Outcome);
        }
    }
}
