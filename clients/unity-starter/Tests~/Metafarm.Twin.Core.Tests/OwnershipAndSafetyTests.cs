using System;
using System.Collections.Generic;
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
        [InlineData("indexed", "chain_index", "indexer_reported", OwnershipKnowledge.Known)]
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
        public void LabelsIndexedOwnershipWithItsSlotAndNeverConfusesNoHoldersWithUnknown()
        {
            var held = new OwnershipReading
            {
                Status = "indexed", Source = "chain_index", Assurance = "indexer_reported", AsOfSlot = "310000500",
                Holders = { new Holder { Owner = "Owner1111111111111111111111111111111111111", Amount = "1" } },
            };
            Assert.Equal("On-chain holders (as indexed, slot 310000500)", OwnershipDisplay.Label(held));

            var burned = new OwnershipReading { Status = "indexed", Source = "chain_index", Assurance = "indexer_reported", AsOfSlot = "310000600" };
            Assert.Equal(OwnershipKnowledge.Known, OwnershipDisplay.Classify(burned));
            Assert.Equal("No current holders on chain (as indexed, slot 310000600)", OwnershipDisplay.Label(burned));

            var verified = new OwnershipReading { Status = "indexed", Source = "das", Assurance = "inclusion_verified", Holders = held.Holders };
            Assert.Equal("On-chain holders (proof checked)", OwnershipDisplay.Label(verified));

            Assert.Equal("Ownership unknown (not indexed)", OwnershipDisplay.Label(new OwnershipReading { Status = "not_indexed", Reason = "reader_unavailable" }));
        }

        [Fact]
        public void SaysYouHoldThisOnlyWhenTheApiSaysSoForChainData()
        {
            var holders = new List<Holder> { new Holder { Owner = "Owner1111111111111111111111111111111111111", Amount = "1" } };
            var mine = new OwnershipReading { Status = "indexed", Source = "chain_index", Assurance = "indexer_reported", AsOfSlot = "900", Holders = holders, HeldByYou = true };
            Assert.Equal("You hold this (as indexed, slot 900)", OwnershipDisplay.Label(mine));

            var notMine = new OwnershipReading { Status = "indexed", Source = "chain_index", Assurance = "indexer_reported", AsOfSlot = "900", Holders = holders, HeldByYou = false };
            Assert.Equal("On-chain holders (as indexed, slot 900)", OwnershipDisplay.Label(notMine));

            var unstated = new OwnershipReading { Status = "indexed", Source = "chain_index", Assurance = "indexer_reported", AsOfSlot = "900", Holders = holders };
            Assert.Null(unstated.HeldByYou);
            Assert.Equal("On-chain holders (as indexed, slot 900)", OwnershipDisplay.Label(unstated));

            // Never for test data or unknown ownership, whatever the field says.
            var fixture = new OwnershipReading { Status = "indexed", Source = "fixture", Assurance = "fixture", Holders = holders, HeldByYou = true };
            Assert.Equal("Test data, not chain state", OwnershipDisplay.Label(fixture));
            Assert.Equal("Ownership unknown (not indexed)", OwnershipDisplay.Label(new OwnershipReading { Status = "not_indexed", HeldByYou = true }));
        }

        [Fact]
        public void ParsesHeldByYouAndLeavesItNullWhenAbsent()
        {
            var withField = Newtonsoft.Json.JsonConvert.DeserializeObject<OwnershipReading>("{\"status\":\"indexed\",\"source\":\"chain_index\",\"assurance\":\"indexer_reported\",\"asOfSlot\":\"9\",\"holders\":[],\"heldByYou\":false}");
            Assert.False(withField.HeldByYou);
            var without = Newtonsoft.Json.JsonConvert.DeserializeObject<OwnershipReading>("{\"status\":\"indexed\",\"source\":\"chain_index\",\"assurance\":\"indexer_reported\",\"asOfSlot\":\"9\",\"holders\":[]}");
            Assert.Null(without.HeldByYou);
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
