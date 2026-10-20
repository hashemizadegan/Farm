using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Verification;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>Vectors produced by the platform's TypeScript implementation (packages/domain/src/twin/commitments.ts).</summary>
    public class VerificationTests
    {
        private const string Item3 = "7c377ad0322c2a80bcb539c96c3ab4dd7bf5c1dbe17132b3d177e22ff258460d"; // SHA-256("item-3")
        private const string Leaf3 = "3aa1754f4d1aac016470f0ecc25b329665666cec4496d631766691a2549d0058";
        private const string Leaf4 = "879653c5f920149ba78b5a222b4d1fad2b917dc1d3a73b0dcc8bc3a372303b47";
        private const string Root = "5610b47577351888d614cb915e3b0d11fbc5d440a689446c1bd8e87d75194da5";
        private static readonly List<string> Path3 = new List<string>
        {
            "d9e1b610b0813a5d887b9c429d7744747c5ce4160c2dd371d57b29229fd8efb1",
            "2cc48cb60f755f56376fa75d3dea9adbc093d339ef3ccc29557dd4c528e29028",
            Leaf4,
        };
        private static readonly List<string> Path4 = new List<string> { "478ab47d10c341e7550bfbaf4f3d8a54b0ba8c47d45626e74f851365f23babb9" };

        [Fact]
        public void LeafHashesMatchThePlatform() => Assert.Equal(Leaf3, Rfc9162CommitmentVerifier.LeafHash(Item3));

        [Fact]
        public void VerifiesProofsThePlatformProduced()
        {
            Assert.True(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf3, 3, 5, Path3, Root));
            Assert.True(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf4, 4, 5, Path4, Root));
        }

        [Fact]
        public void RejectsWrongLeavesIndexesPathsAndRoots()
        {
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf4, 3, 5, Path3, Root));
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf3, 2, 5, Path3, Root));
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf3, 3, 5, Path3.GetRange(0, 2), Root));
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf3, 3, 5, Path3, Leaf3));
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion("zz", 3, 5, Path3, Root));
            Assert.False(Rfc9162CommitmentVerifier.VerifyInclusion(Leaf3, 5, 5, Path3, Root));
        }

        [Fact]
        public void ChecksContentAgainstItsHash()
        {
            var v = new Rfc9162CommitmentVerifier();
            Assert.True(v.ContentMatches(Encoding.UTF8.GetBytes("item-3"), Item3));
            Assert.False(v.ContentMatches(Encoding.UTF8.GetBytes("item-4"), Item3));
            Assert.False(v.ContentMatches(null, Item3));
        }

        [Fact]
        public async Task VerifiesTheSampleProofEndToEndAndNoticesTampering()
        {
            var api = new TwinReadClient(Samples.Transport(), SampleIds.TenantId);
            var proof = await api.GetCommitmentProofAsync(SampleIds.CommitmentId);
            var v = new Rfc9162CommitmentVerifier();
            Assert.True(v.VerifyProof(proof));
            proof.Commitment.ContentSha256 = Leaf4;
            Assert.False(v.VerifyProof(proof));
            proof.Proof = null;
            Assert.False(v.VerifyProof(proof));
        }
    }
}
