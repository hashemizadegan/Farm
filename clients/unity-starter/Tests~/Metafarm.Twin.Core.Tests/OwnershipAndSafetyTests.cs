using System;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Ownership;
using Metafarm.Twin.Core.Transactions;
using Metafarm.Twin.Core.Transport;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    public class OwnershipAndSafetyTests
    {
        [Theory]
        [InlineData("indexed", "das", "inclusion_verified", OwnershipKnowledge.Known)]
        [InlineData("indexed", "fixture", "fixture", OwnershipKnowledge.TestData)]
        [InlineData("not_indexed", null, null, OwnershipKnowledge.Unknown)]
        [InlineData("not_on_chain", null, null, OwnershipKnowledge.NotOnChain)]
        [InlineData("something_new", null, null, OwnershipKnowledge.Unknown)]
        public void ClassifiesOwnershipWithoutGuessing(string status, string source, string assurance, OwnershipKnowledge expected)
        {
            var o = new OwnershipReading { Status = status, Source = source, Assurance = assurance };
            Assert.Equal(expected, OwnershipDisplay.Classify(o));
            Assert.Equal(OwnershipKnowledge.Unknown, OwnershipDisplay.Classify(null));
            Assert.Equal("Ownership unknown (not indexed)", OwnershipDisplay.Label(new OwnershipReading { Status = "not_indexed" }));
        }

        [Fact]
        public async Task ReadsOwnershipThroughTheApi()
        {
            var reader = new ApiOwnershipReader(new TwinReadClient(Samples.Transport(), SampleIds.TenantId));
            var readings = await reader.GetOwnershipAsync(SampleIds.BuildingAssetId);
            Assert.Equal(OwnershipKnowledge.TestData, OwnershipDisplay.Classify(readings.Single()));
        }

        [Fact]
        public async Task TransferPreviewsAreDisabledByDefault()
        {
            var previewer = new DisabledTransferPreviewer();
            Assert.False(previewer.Available);
            await Assert.ThrowsAsync<NotSupportedException>(() => previewer.PreviewAsync(new TransferPreviewRequest()));
        }

        [Fact]
        public void TheTransportCanOnlyRead()
        {
            var methods = typeof(ITwinTransport).GetMethods().Select(m => m.Name).ToArray();
            Assert.Equal(new[] { "GetAsync" }, methods);
        }

        [Fact]
        public void NothingCanSignSubmitOrHoldKeys()
        {
            var forbidden = new[] { "sign", "submit", "send", "privatekey", "secretkey", "keypair", "mnemonic", "seed", "wallet" };
            var assembly = typeof(TwinReadClient).Assembly;
            foreach (var type in assembly.GetTypes())
            {
                Assert.DoesNotContain(forbidden, f => type.Name.ToLowerInvariant().Contains(f));
                foreach (var member in type.GetMembers(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                {
                    var name = member.Name.ToLowerInvariant();
                    // Compiler-generated async state machines and SendWebRequest-style names do not occur in Core.
                    Assert.DoesNotContain(forbidden, f => name.Contains(f));
                }
            }
        }
    }
}
