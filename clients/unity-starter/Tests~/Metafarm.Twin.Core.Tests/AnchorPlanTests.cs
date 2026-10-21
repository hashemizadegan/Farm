using System;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Anchoring;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>The anchor-plan samples match what the platform's planAnchor returns (checked in client-samples.test.ts).</summary>
    public class AnchorPlanTests
    {
        private const string SnapshotCommitmentId = "99999999-9999-4999-8999-999999999999";
        private const string BatchId = "88888888-8888-4888-8888-888888888888";
        private const string SnapshotRoot = "609fb30445a023b7e4a83ec941b50e7f230c4d0db811218957185aa4f774bf89";
        private const string BatchRoot = "5610b47577351888d614cb915e3b0d11fbc5d440a689446c1bd8e87d75194da5";

        private static SampleTransport Transport() => new SampleTransport()
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/snapshots/{SnapshotCommitmentId}/anchor-plan", Samples.Read("snapshot-anchor-plan.sample.json"))
            .Add($"/v1/tenants/{SampleIds.TenantId}/twin/data-commitments/batches/{BatchId}/anchor-plan", Samples.Read("batch-anchor-plan.sample.json"));

        [Fact]
        public async Task ReadsASnapshotPlanAndShowsItAsPlannedOnly()
        {
            var transport = Transport();
            var r = await new TwinReadClient(transport, SampleIds.TenantId).GetSnapshotAnchorPlanAsync(SnapshotCommitmentId, AnchorCarriers.Token2022Metadata);
            Assert.Equal($"/v1/tenants/{SampleIds.TenantId}/twin/snapshots/{SnapshotCommitmentId}/anchor-plan?carrier=token2022_metadata&network=solana-devnet", Assert.Single(transport.Requests));
            Assert.False(r.Plan.Executable);
            Assert.Equal("mf:snapshot:farm-6b0c6f4e8d1a4c", r.Plan.MetadataField.Key);
            var review = AnchorPlanReview.Of(r.Plan, SnapshotRoot);
            Assert.True(review.Ok, string.Join("; ", review.Problems));
            Assert.StartsWith("Planned only, not anchored: snapshot root 609fb30445a0", review.Summary);
        }

        [Fact]
        public async Task ReadsABatchPlanWithBubblegumLeafMetadata()
        {
            var r = await new TwinReadClient(Transport(), SampleIds.TenantId).GetBatchAnchorPlanAsync(BatchId, AnchorCarriers.BubblegumV1Leaf);
            Assert.Equal("MFANCHOR", r.Plan.LeafMetadata.Symbol);
            Assert.True(AnchorPlanReview.Of(r.Plan, BatchRoot).Ok);
        }

        [Fact]
        public async Task RefusesUnknownCarriersAndNetworksBeforeAnyRequest()
        {
            var transport = Transport();
            var client = new TwinReadClient(transport, SampleIds.TenantId);
            await Assert.ThrowsAsync<ArgumentException>(() => client.GetSnapshotAnchorPlanAsync(SnapshotCommitmentId, "evm"));
            await Assert.ThrowsAsync<ArgumentException>(() => client.GetBatchAnchorPlanAsync(BatchId, AnchorCarriers.Token2022Metadata, "tron-mainnet"));
            await Assert.ThrowsAsync<ArgumentException>(() => client.GetBatchAnchorPlanAsync("not-a-uuid", AnchorCarriers.Token2022Metadata));
            Assert.Empty(transport.Requests);
        }

        [Fact]
        public void DoesNotShowPlansThatClaimToBeExecutableOrNameAnotherRoot()
        {
            var plan = TwinJson.Deserialize<SnapshotAnchorPlan>(Samples.Read("snapshot-anchor-plan.sample.json")).Plan;
            Assert.False(AnchorPlanReview.Of(plan, BatchRoot).Ok);

            plan.Executable = true;
            var review = AnchorPlanReview.Of(plan, SnapshotRoot);
            Assert.False(review.Ok);
            Assert.Contains(review.Problems, p => p.Contains("executable"));
            Assert.Equal("Anchor plan not shown: it did not pass the client's checks", review.Summary);

            plan.Executable = false;
            plan.MetadataField.Value = "metafarm-farm-snapshot/1:" + BatchRoot;
            Assert.False(AnchorPlanReview.Of(plan, SnapshotRoot).Ok);
            Assert.False(AnchorPlanReview.Of(null, SnapshotRoot).Ok);
        }
    }
}
