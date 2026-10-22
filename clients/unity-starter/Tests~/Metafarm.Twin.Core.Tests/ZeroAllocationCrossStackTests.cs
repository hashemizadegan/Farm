using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;
using System.Text;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Yield;
using Newtonsoft.Json;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>
    /// Zero-allocation policy, checked across stacks. Samples/claim-payloads.tiny-holders.sample.json is a seeded
    /// simulation cycle with many tiny holders, run through the platform pipeline with dust threshold 0
    /// (zero-allocation.sample.test-support.ts; a vitest test requires the committed file to match exactly).
    /// Here the client recomputes the largest-remainder allocation from the shares with BigInteger and applies
    /// the state rule itself (no wallet: withheld; amount 0: deferred, zero_amount; below the threshold:
    /// deferred, below_dust_threshold; otherwise payable), then requires the platform's entries and claims to
    /// match exactly, every claim to verify, and no claim to be for 0.
    /// </summary>
    public class ZeroAllocationCrossStackTests
    {
        public sealed class Sample
        {
            [JsonProperty("settlement")] public SettlementInfo Settlement;
            [JsonProperty("shares")] public List<Share> Shares;
            [JsonProperty("entries")] public List<Entry> Entries;
            [JsonProperty("totals")] public Dictionary<string, string> Totals;
            [JsonProperty("publishedTree")] public PublishedClaimTree PublishedTree;
            [JsonProperty("claims")] public List<ClaimPayload> Claims;
        }

        public sealed class SettlementInfo
        {
            [JsonProperty("amount")] public string Amount;
            [JsonProperty("dustThreshold")] public string DustThreshold;
            [JsonProperty("remainder")] public string Remainder;
        }

        public sealed class Share
        {
            [JsonProperty("key")] public string Key;
            [JsonProperty("kind")] public string Kind;
            [JsonProperty("hasPayoutWallet")] public bool HasPayoutWallet;
            [JsonProperty("weight")] public string Weight;
        }

        public sealed class Entry
        {
            [JsonProperty("key")] public string Key;
            [JsonProperty("state")] public string State;
            [JsonProperty("deferredReason")] public string DeferredReason;
            [JsonProperty("allocated")] public string Allocated;
            [JsonProperty("amount")] public string Amount;
        }

        private static Sample Load() => TwinJson.Deserialize<Sample>(Samples.Read("claim-payloads.tiny-holders.sample.json"));

        private static BigInteger Big(string s) => BigInteger.Parse(s, NumberStyles.None, CultureInfo.InvariantCulture);

        /// <summary>Byte-wise comparison of UTF-8 keys; a prefix sorts first (as allocation.ts compares recipient bytes).</summary>
        private static int CompareKeyBytes(string a, string b)
        {
            var x = Encoding.UTF8.GetBytes(a);
            var y = Encoding.UTF8.GetBytes(b);
            for (var i = 0; i < Math.Min(x.Length, y.Length); i++)
                if (x[i] != y[i]) return x[i].CompareTo(y[i]);
            return x.Length.CompareTo(y.Length);
        }

        /// <summary>Largest remainder: floor shares, then one unit each to the largest dropped fractions, ties by ascending key bytes.</summary>
        private static Dictionary<string, BigInteger> Allocate(BigInteger total, List<Share> shares)
        {
            var ordered = shares.ToList();
            ordered.Sort((a, b) => CompareKeyBytes(a.Key, b.Key));
            var sum = ordered.Aggregate(BigInteger.Zero, (n, s) => n + Big(s.Weight));
            var parts = ordered.Select(s => new { s.Key, Floor = total * Big(s.Weight) / sum, Fraction = total * Big(s.Weight) % sum }).ToList();
            var amounts = parts.ToDictionary(p => p.Key, p => p.Floor);
            var remainder = total - parts.Aggregate(BigInteger.Zero, (n, p) => n + p.Floor);
            foreach (var p in parts.OrderByDescending(p => p.Fraction)) // stable: equal fractions keep key order
            {
                if (remainder == 0) break;
                amounts[p.Key] += 1;
                remainder -= 1;
            }
            Assert.Equal(BigInteger.Zero, remainder);
            return amounts;
        }

        private static (string State, string Reason) StateOf(Share s, BigInteger amount, BigInteger threshold)
        {
            if (s.Kind == "unattributed") return ("unattributed", null);
            if (!s.HasPayoutWallet) return ("withheld", null);
            if (amount == 0) return ("deferred", "zero_amount");
            if (amount < threshold) return ("deferred", "below_dust_threshold");
            return ("payable", null);
        }

        private static byte[] Bytes(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        [Fact]
        public void TheClientDerivesThePlatformsAllocationAndStatesIndependently()
        {
            var s = Load();
            Assert.Equal("largest_remainder", s.Settlement.Remainder);
            Assert.Equal("0", s.Settlement.DustThreshold);
            var total = Big(s.Settlement.Amount);
            var threshold = Big(s.Settlement.DustThreshold);
            var amounts = Allocate(total, s.Shares);
            Assert.Equal(s.Shares.Count, s.Entries.Count);
            var zeroDeferred = 0;
            for (var i = 0; i < s.Shares.Count; i++)
            {
                var share = s.Shares[i];
                var entry = s.Entries[i];
                Assert.Equal(share.Key, entry.Key);
                Assert.Equal(amounts[share.Key], Big(entry.Allocated));
                Assert.Equal(Big(entry.Allocated), Big(entry.Amount)); // first cycle: nothing deferred in
                var (state, reason) = StateOf(share, amounts[share.Key], threshold);
                Assert.Equal(state, entry.State);
                Assert.Equal(reason, entry.DeferredReason);
                if (reason == "zero_amount") zeroDeferred++;
            }
            Assert.True(zeroDeferred > 5, "the sample must contain tiny holders allocated 0");
        }

        [Fact]
        public void ClaimsAreExactlyThePayableEntriesAndEveryOneVerifies()
        {
            var s = Load();
            var payable = s.Entries.Where(e => e.State == "payable").ToDictionary(e => e.Key.Substring(2), e => e.Amount);
            Assert.Equal(payable.Count, s.Claims.Count);
            Assert.Equal(payable.Count, s.PublishedTree.TreeSize);
            foreach (var c in s.Claims)
            {
                Assert.NotEqual("0", c.Amount);
                Assert.Equal(payable[c.PartyId], c.Amount);
                Assert.True(ClaimPayloadVerification.Verify(c, s.PublishedTree));
            }
            Assert.Equal(s.PublishedTree.Root, ClaimTreeVerifier.ComputeRoot(s.Claims.OrderBy(c => c.LeafIndex).Select(c => c.LeafHash).ToList()));
        }

        [Fact]
        public void ConservationHoldsExactly()
        {
            var s = Load();
            var t = s.Totals.ToDictionary(kv => kv.Key, kv => Big(kv.Value));
            Assert.Equal(Big(s.Settlement.Amount), t["inflow"]);
            Assert.Equal(s.Claims.Aggregate(BigInteger.Zero, (n, c) => n + Big(c.Amount)), t["leaves"]);
            Assert.Equal(t["inflow"], t["leaves"] + t["dustCarriedForward"] + t["withheld"] + t["unattributed"] + t["remainderCarried"]);
            Assert.Equal(BigInteger.Zero, t["dustCarriedForward"]); // zero amounts carry nothing forward
        }

        [Fact]
        public void ZeroAmountLeavesAreRefusedOnEncodeDecodeAndVerification()
        {
            var s = Load();
            var c = s.Claims[0];
            var bytes = Bytes(c.LeafBytes);
            var zero = (byte[])bytes.Clone();
            for (var i = 185; i < 193; i++) zero[i] = 0;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Decode(zero));
            var fields = ClaimLeafCodec.Decode(bytes);
            fields.Amount = 0;
            Assert.Throws<ArgumentException>(() => ClaimLeafCodec.Encode(fields));
            var forged = JsonConvert.DeserializeObject<ClaimPayload>(JsonConvert.SerializeObject(c), TwinJson.Settings);
            forged.Amount = "0";
            forged.LeafBytes = Hex(zero);
            Assert.False(ClaimPayloadVerification.Verify(forged, s.PublishedTree));
            Assert.False(ClaimTreeVerifier.VerifyClaimLeafProof(zero, c.LeafIndex, c.TreeSize, c.Path, c.Root, s.PublishedTree.Root, s.PublishedTree.TreeSize));
        }
    }
}
