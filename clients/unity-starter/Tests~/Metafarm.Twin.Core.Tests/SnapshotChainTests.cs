using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Anchoring;
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
    /// The snapshot-content, snapshot-proof and snapshot-batch-anchor-plan samples were produced by the
    /// platform's own code (canonicalJson, merkleAuditPath, planAnchor) and are re-derived in
    /// client-samples.test.ts.
    /// </summary>
    public class SnapshotChainTests
    {
        private const string Id = "99999999-9999-4999-8999-999999999999";
        private const string BatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        private const string ContentHash = "8a4bcd9b23616a0f8e433b5fed786eae3485bf76bdc3a267702e40fa6b96e814";
        private const string BatchRoot = "94780617aa85fe2c5d6acc45458911164c6bc62658e922738a8eb493cf3ccd99";
        private static readonly string Base = $"/v1/tenants/{SampleIds.TenantId}/twin";

        private static SampleTransport Transport(string proof = null, string content = null, string plan = null) => new SampleTransport()
            .Add($"{Base}/data-commitments/{Id}/proof", proof ?? Samples.Read("snapshot-proof.sample.json"))
            .Add($"{Base}/snapshots/{Id}/content", content ?? Samples.Read("snapshot-content.sample.json"))
            .Add($"{Base}/data-commitments/batches/{BatchId}/anchor-plan", plan ?? Samples.Read("snapshot-batch-anchor-plan.sample.json"));

        private static SnapshotChain Chain(SampleTransport t) => new SnapshotChain(new TwinReadClient(t, SampleIds.TenantId));

        [Fact]
        public async Task VerifiesEveryLinkFromTheBytesToThePlannedAnchor()
        {
            var t = Transport();
            var r = await Chain(t).VerifyAsync(Id, AnchorCarriers.Token2022Metadata);
            Assert.Empty(r.Problems);
            Assert.Equal(
                new[] { ChainLinkState.Verified, ChainLinkState.Verified, ChainLinkState.Verified, ChainLinkState.Verified },
                new[] { r.Content, r.Structure, r.Inclusion, r.AnchorPlan });
            Assert.True(r.VerifiedThroughBatch);
            Assert.Equal(ContentHash, r.ContentSha256);
            Assert.Equal(BatchRoot, r.BatchRoot);
            Assert.Equal("6b0c6f4e-8d1a-4c4e-9a43-0d1b2f3c4a5b", r.Snapshot.FarmId);
            Assert.Equal("Snapshot 609fb30445a0… matches its commitment and is in batch root 94780617aa85…; anchoring planned only, not anchored", r.Summary);
            Assert.Equal(3, t.Requests.Count);
        }

        [Fact]
        public async Task WithoutACarrierTheAnchorPlanIsNotRequested()
        {
            var t = Transport();
            var r = await Chain(t).VerifyAsync(Id);
            Assert.Equal(ChainLinkState.NotChecked, r.AnchorPlan);
            Assert.EndsWith("; not anchored", r.Summary);
            Assert.DoesNotContain(t.Requests, q => q.Contains("anchor-plan"));
        }

        [Fact]
        public async Task RefusesBytesThatDoNotMatchTheCommittedHash()
        {
            var tampered = Samples.Read("snapshot-content.sample.json").Replace("Block A", "Block B");
            var r = await Chain(Transport(content: tampered)).VerifyAsync(Id, AnchorCarriers.Token2022Metadata);
            Assert.Equal(ChainLinkState.Failed, r.Content);
            Assert.Equal(ChainLinkState.NotChecked, r.Structure);
            Assert.Null(r.Snapshot);
            Assert.False(r.VerifiedThroughBatch);
            Assert.Equal("Snapshot not verified", r.Summary);
        }

        [Fact]
        public async Task RefusesAProofThatDoesNotReachTheRoot()
        {
            var proof = JObject.Parse(Samples.Read("snapshot-proof.sample.json"));
            proof["proof"]["path"][0] = new string('3', 64);
            var r = await Chain(Transport(proof: proof.ToString())).VerifyAsync(Id, AnchorCarriers.Token2022Metadata);
            Assert.Equal(ChainLinkState.Verified, r.Content);
            Assert.Equal(ChainLinkState.Failed, r.Inclusion);
            Assert.Equal(ChainLinkState.NotChecked, r.AnchorPlan);
            Assert.Null(r.BatchRoot);
            Assert.EndsWith("batch inclusion not verified", r.Summary);
        }

        [Fact]
        public async Task SaysWhenTheSnapshotIsNotBatchedYet()
        {
            var proof = JObject.Parse(Samples.Read("snapshot-proof.sample.json"));
            proof["proof"] = null;
            proof["commitment"]["batch"] = null;
            proof["state"] = "recorded";
            var r = await Chain(Transport(proof: proof.ToString())).VerifyAsync(Id, AnchorCarriers.Token2022Metadata);
            Assert.Equal(ChainLinkState.NotBatched, r.Inclusion);
            Assert.Equal(ChainLinkState.NotChecked, r.AnchorPlan);
            Assert.EndsWith("not in a batch yet", r.Summary);
        }

        [Fact]
        public async Task RefusesAnAnchorPlanForAnotherRoot()
        {
            // The batch-anchor-plan sample belongs to a different batch root.
            var plan = JObject.Parse(Samples.Read("batch-anchor-plan.sample.json"));
            plan["batchId"] = BatchId;
            var r = await Chain(Transport(plan: plan.ToString())).VerifyAsync(Id, AnchorCarriers.BubblegumV1Leaf);
            Assert.Equal(ChainLinkState.Verified, r.Inclusion);
            Assert.Equal(ChainLinkState.Failed, r.AnchorPlan);
            Assert.Contains(r.Problems, p => p.Contains("different root"));
            Assert.EndsWith("; not anchored", r.Summary);
        }

        [Fact]
        public async Task StopsAtCommitmentsThatAreNotSnapshotsAndReportsApiErrors()
        {
            var telemetry = new SampleTransport().Add($"{Base}/data-commitments/{SampleIds.CommitmentId}/proof", Samples.Read("commitment-proof.sample.json"));
            var r = await Chain(telemetry).VerifyAsync(SampleIds.CommitmentId);
            Assert.Equal(ChainLinkState.Failed, r.Content);
            Assert.Contains("not a farm snapshot", r.Problems.Single());
            Assert.Single(telemetry.Requests);

            var missing = new SampleTransport().Add($"{Base}/data-commitments/{Id}/proof", Samples.Read("snapshot-proof.sample.json"));
            var m = await Chain(missing).VerifyAsync(Id);
            Assert.Equal(ChainLinkState.Failed, m.Content);
            Assert.StartsWith("snapshot content: HTTP 404 not_found", m.Problems.Single());
        }

        [Fact]
        public void HashesTheTextAsUtf8ExactlyAsTheServerStoredIt()
        {
            // Persian text: the bytes are UTF-8, as the platform stores canonical JSON.
            Assert.True(new Rfc9162CommitmentVerifier().ContentMatches(Encoding.UTF8.GetBytes("{\"name\":\"مزرعهٔ پسته\"}"), "681eac2705cbcf97a942c3a59445bc61ea2604434fdc30ed31567d879f6f24a8"));
        }
    }
}
