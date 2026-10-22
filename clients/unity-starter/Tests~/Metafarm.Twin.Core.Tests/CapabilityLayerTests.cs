using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Capabilities;
using Metafarm.Twin.Core.Mocks;
using Metafarm.Twin.Core.Models;
using Newtonsoft.Json;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>Provider-neutral client capabilities: states, media, realtime (disabled), polling, exact decimals.</summary>
    public class CapabilityLayerTests
    {
        private const string Tenant = "11111111-1111-4111-8111-111111111111";
        private const string Farm = "55555555-5555-4555-8555-555555555555";
        private const string Media = "66666666-6666-4666-8666-666666666666";

        /// <summary>Records requested delays instead of waiting; cancels the token after a number of interval waits.</summary>
        private sealed class FakeDelay : IDelay
        {
            private readonly CancellationTokenSource _cts;
            private readonly int _cancelAfterIntervals;
            private readonly TimeSpan _interval;
            public readonly List<TimeSpan> Waits = new List<TimeSpan>();

            public FakeDelay(CancellationTokenSource cts = null, int cancelAfterIntervals = int.MaxValue, TimeSpan interval = default)
            {
                _cts = cts;
                _cancelAfterIntervals = cancelAfterIntervals;
                _interval = interval;
            }

            public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken)
            {
                Waits.Add(duration);
                if (_cts != null && duration == _interval && Waits.Count(w => w == _interval) >= _cancelAfterIntervals) _cts.Cancel();
                cancellationToken.ThrowIfCancellationRequested();
                return Task.CompletedTask;
            }
        }

        private static PollingOptions Options => new PollingOptions { Interval = TimeSpan.FromSeconds(30), MaxRetries = 3, BackoffBase = TimeSpan.FromSeconds(1), BackoffMax = TimeSpan.FromSeconds(3) };

        [Fact]
        public void MapImageryStatesFollowThePlatformRules()
        {
            Assert.Equal(CapabilityState.Disabled, new UnavailableMapImagerySource().Capability.State);
            Assert.Throws<CapabilityUnavailableException>(() => new UnavailableMapImagerySource().GetConfig());
            Assert.Equal(CapabilityState.Disabled, new StaticMapImagerySource(null, null).Capability.State);
            Assert.Equal(CapabilityState.Invalid, new StaticMapImagerySource("http://tiles.example/style.json", "x").Capability.State);
            Assert.Equal(CapabilityState.Invalid, new StaticMapImagerySource("not a url", "x").Capability.State);
            Assert.Equal(CapabilityState.Missing, new StaticMapImagerySource("https://tiles.example/style.json", " ").Capability.State);
            var ok = new StaticMapImagerySource("https://tiles.example/style.json", "© Example");
            Assert.True(ok.Capability.IsUsable);
            Assert.Equal("tiles.example", ok.Capability.Provider);
            Assert.Equal("© Example", ok.GetConfig().Attribution);
        }

        [Fact]
        public async Task MediaListsThroughTheApiAndBuildsContentPathsWithValidatedIds()
        {
            var transport = new SampleTransport().Add($"/v1/tenants/{Tenant}/farms/{Farm}/media",
                @"{ ""items"": [ { ""id"": ""66666666-6666-4666-8666-666666666666"", ""farmId"": ""55555555-5555-4555-8555-555555555555"", ""filename"": ""a.jpg"", ""contentType"": ""image/jpeg"", ""byteSize"": 3000000000, ""purpose"": ""observation-photo"", ""status"": ""uploaded"", ""createdAt"": ""2026-10-22T10:00:00.000Z"" } ] }");
            var media = new ApiMediaSource(transport, Tenant);
            var list = await media.ListFarmMediaAsync(Farm, "observation-photo");
            var item = Assert.Single(list.Items);
            Assert.Equal(3000000000L, item.ByteSize);
            Assert.Equal($"/v1/tenants/{Tenant}/farms/{Farm}/media?purpose=observation-photo", transport.Requests.Single());
            Assert.Equal($"/v1/tenants/{Tenant}/media/{Media}/content", media.ContentPath(Media));
            await Assert.ThrowsAsync<ArgumentException>(() => media.ListFarmMediaAsync(Farm, "selfie"));
            Assert.Throws<ArgumentException>(() => media.ContentPath("../../etc"));
            Assert.Single(transport.Requests);
        }

        [Fact]
        public async Task UnavailableMediaAndDisabledRealtimeRefuseToPretend()
        {
            await Assert.ThrowsAsync<CapabilityUnavailableException>(() => new UnavailableMediaSource().ListFarmMediaAsync(Farm));
            var realtime = new DisabledRealtimeChannel();
            Assert.Equal(CapabilityState.Disabled, realtime.Capability.State);
            var ex = await Assert.ThrowsAsync<CapabilityUnavailableException>(() => realtime.SubscribeAsync("yield.cycle.updated", _ => { }));
            Assert.Contains("polling", ex.Message);
        }

        [Fact]
        public void TheRealtimeEnvelopeParsesTheServerShape()
        {
            var e = TwinJson.Deserialize<RealtimeEnvelope>(@"{ ""scheme"": ""metafarm-event/1"", ""type"": ""yield.cycle.updated"", ""schemaVersion"": 1, ""id"": ""e1"",
              ""scope"": { ""tenantId"": ""11111111-1111-4111-8111-111111111111"", ""farmId"": null }, ""occurredAt"": ""2026-10-22T10:00:00.000Z"",
              ""correlationId"": null, ""payload"": { ""amount"": ""18446744073709551615"" } }");
            Assert.Equal(RealtimeEnvelope.Scheme, e.EnvelopeScheme);
            Assert.Null(e.Scope.FarmId);
            Assert.Equal("18446744073709551615", (string)e.Payload["amount"]);
        }

        [Fact]
        public async Task PollingDeliversEachReadUntilCancelled()
        {
            using var cts = new CancellationTokenSource();
            var delay = new FakeDelay(cts, cancelAfterIntervals: 3, interval: Options.Interval);
            var n = 0;
            var seen = new List<int>();
            await Poller.RunAsync(_ => Task.FromResult(++n), seen.Add, Options, delay, cts.Token);
            Assert.Equal(new[] { 1, 2, 3 }, seen);
            Assert.All(delay.Waits, w => Assert.Equal(Options.Interval, w));
        }

        [Fact]
        public async Task RetriesTransientFailuresWithCappedBackoffThenSucceeds()
        {
            var delay = new FakeDelay();
            var calls = 0;
            var value = await Poller.FetchWithRetryAsync(_ =>
            {
                calls++;
                if (calls == 1) throw new TwinApiException(503, null, "unavailable");
                if (calls == 2) throw new TwinApiException(429, null, "slow down");
                if (calls == 3) throw new System.Net.Http.HttpRequestException("reset");
                return Task.FromResult("ok");
            }, Options, delay, CancellationToken.None);
            Assert.Equal("ok", value);
            Assert.Equal(new[] { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(3) }, delay.Waits);
        }

        [Fact]
        public async Task GivesUpAfterMaxRetriesAndNeverRetriesClientErrorsOrMalformedResponses()
        {
            var calls = 0;
            await Assert.ThrowsAsync<TwinApiException>(() => Poller.FetchWithRetryAsync<string>(_ => { calls++; throw new TwinApiException(502, null, "bad gateway"); }, Options, new FakeDelay(), CancellationToken.None));
            Assert.Equal(4, calls); // the first try and 3 retries

            calls = 0;
            await Assert.ThrowsAsync<TwinApiException>(() => Poller.FetchWithRetryAsync<string>(_ => { calls++; throw new TwinApiException(404, null, "not found"); }, Options, new FakeDelay(), CancellationToken.None));
            Assert.Equal(1, calls);

            calls = 0;
            await Assert.ThrowsAnyAsync<JsonException>(() => Poller.FetchWithRetryAsync(_ => { calls++; return Task.FromResult(TwinJson.Deserialize<YieldCycleList>("{ not json")); }, Options, new FakeDelay(), CancellationToken.None));
            Assert.Equal(1, calls);
        }

        [Fact]
        public async Task CancellationStopsPollingQuietlyAndRetriesThrow()
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            var seen = 0;
            await Poller.RunAsync(_ => Task.FromResult(1), _ => seen++, Options, new FakeDelay(), cts.Token);
            Assert.Equal(0, seen);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Poller.FetchWithRetryAsync(_ => Task.FromResult(1), Options, new FakeDelay(), cts.Token));
        }

        [Fact]
        public async Task TheYieldWatcherPollsTheReadApi()
        {
            var transport = new SampleTransport().Add($"/v1/tenants/{Tenant}/yield/cycles", @"{ ""items"": [], ""nextCursor"": null }");
            using var cts = new CancellationTokenSource();
            var watcher = new YieldCycleWatcher(new YieldReadClient(transport, Tenant), Options, new FakeDelay(cts, cancelAfterIntervals: 2, interval: Options.Interval));
            var lists = 0;
            await watcher.WatchAsync(_ => lists++, cts.Token, limit: 10);
            Assert.Equal("polling", watcher.Mode);
            Assert.Equal(2, lists);
            Assert.All(transport.Requests, r => Assert.Equal($"/v1/tenants/{Tenant}/yield/cycles?limit=10", r));
        }

        [Fact]
        public void DecimalStringsAreExactBeyondDoublePrecision()
        {
            Assert.Equal("36893488147419103230", DecimalStrings.Sum(new[] { "18446744073709551615", "18446744073709551615" }));
            Assert.Equal("340282366920938463463374607431768211456", DecimalStrings.Sum(new[] { "340282366920938463463374607431768211455", "1" }));
            Assert.Equal(1, DecimalStrings.Compare("9007199254740993", "9007199254740992"));
            foreach (var bad in new[] { "", "-1", "01", "1e3", "1.0", " 1", "1,000", null }) Assert.False(DecimalStrings.IsValid(bad), bad ?? "null");
            Assert.Throws<FormatException>(() => DecimalStrings.Parse("1e3"));
        }
    }
}
