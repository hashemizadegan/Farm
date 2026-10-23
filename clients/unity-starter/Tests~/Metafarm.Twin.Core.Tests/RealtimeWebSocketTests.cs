using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Capabilities;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Metafarm.Twin.Core.Tests
{
    /// <summary>The optional WebSocket realtime channel (metafarm-realtime.1) over a scripted transport.</summary>
    public class RealtimeWebSocketTests
    {
        private const string Tenant = "11111111-1111-4111-8111-111111111111";
        private const string OtherTenant = "22222222-2222-4222-8222-222222222222";
        private const string Farm = "55555555-5555-4555-8555-555555555555";
        private const string OtherFarm = "77777777-7777-4777-8777-777777777777";
        private const string Type = "twin.snapshot.recorded";

        private sealed class FakeConnection : IRealtimeConnection
        {
            private readonly ConcurrentQueue<string> _incoming = new ConcurrentQueue<string>();
            private readonly SemaphoreSlim _available = new SemaphoreSlim(0);
            private readonly List<string> _sent = new List<string>();
            public bool Disposed;
            public int? CloseCode { get; private set; }

            public string[] Sent
            {
                get
                {
                    lock (_sent) return _sent.ToArray();
                }
            }

            public void Push(string text)
            {
                _incoming.Enqueue(text);
                _available.Release();
            }

            public void CloseFromServer(int code)
            {
                CloseCode = code;
                Push(null);
            }

            public Task WriteAsync(string text, CancellationToken cancellationToken)
            {
                lock (_sent) _sent.Add(text);
                return Task.CompletedTask;
            }

            public async Task<string> ReceiveAsync(CancellationToken cancellationToken)
            {
                await _available.WaitAsync(cancellationToken).ConfigureAwait(false);
                _incoming.TryDequeue(out var text);
                return text;
            }

            public void Dispose() => Disposed = true;
        }

        private sealed class FakeConnector : IRealtimeConnector
        {
            public readonly ConcurrentQueue<FakeConnection> Next = new ConcurrentQueue<FakeConnection>();
            public readonly List<FakeConnection> Opened = new List<FakeConnection>();
            public readonly List<string> Tokens = new List<string>();
            public int Failures;

            public Task<IRealtimeConnection> ConnectAsync(Uri endpoint, string accessToken, CancellationToken cancellationToken)
            {
                lock (Tokens) Tokens.Add(accessToken);
                if (Failures > 0)
                {
                    Failures--;
                    return Task.FromException<IRealtimeConnection>(new System.Net.WebSockets.WebSocketException("unreachable"));
                }
                var c = Next.TryDequeue(out var scripted) ? scripted : new FakeConnection();
                lock (Opened) Opened.Add(c);
                return Task.FromResult<IRealtimeConnection>(c);
            }
        }

        /// <summary>Backoff waits return at once (and are recorded); the ping interval (an hour here) waits for cancellation.</summary>
        private sealed class TestDelay : IDelay
        {
            public readonly ConcurrentQueue<TimeSpan> Backoffs = new ConcurrentQueue<TimeSpan>();

            public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken)
            {
                if (duration >= TimeSpan.FromMinutes(30)) return Task.Delay(Timeout.Infinite, cancellationToken);
                Backoffs.Enqueue(duration);
                cancellationToken.ThrowIfCancellationRequested();
                return Task.CompletedTask;
            }
        }

        private static RealtimeOptions Options(string farm = Farm) => new RealtimeOptions
        {
            Enabled = true,
            Endpoint = new Uri("wss://api.example.org/v1/realtime"),
            TenantId = Tenant,
            FarmId = farm,
            AccessToken = _ => Task.FromResult("token-1"),
            PingInterval = TimeSpan.FromHours(1),
            Reconnect = new PollingOptions { MaxRetries = 3, BackoffBase = TimeSpan.FromSeconds(1), BackoffMax = TimeSpan.FromSeconds(4) },
        };

        private static string Subscribed(string cursor) => new JObject { ["op"] = "subscribed", ["tenantId"] = Tenant, ["farmId"] = Farm, ["types"] = new JArray(Type), ["cursor"] = cursor == null ? JValue.CreateNull() : (JToken)cursor }.ToString();

        private static string Event(string cursor, string id = null, string tenant = Tenant, string farm = Farm, string scheme = "metafarm-event/1", string type = Type) =>
            new JObject
            {
                ["op"] = "event",
                ["cursor"] = cursor,
                ["event"] = new JObject
                {
                    ["scheme"] = scheme,
                    ["type"] = type,
                    ["schemaVersion"] = 1,
                    ["id"] = id ?? Guid.NewGuid().ToString(),
                    ["scope"] = new JObject { ["tenantId"] = tenant, ["farmId"] = farm },
                    ["occurredAt"] = "2026-10-23T01:00:00Z",
                    ["correlationId"] = null,
                    ["payload"] = new JObject { ["commitmentId"] = Guid.NewGuid().ToString(), ["sha256"] = new string('a', 64) },
                },
            }.ToString();

        private static async Task Until(Func<bool> condition, int ms = 5000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (!condition())
            {
                if (DateTime.UtcNow > until) throw new TimeoutException("condition not reached");
                await Task.Delay(5);
            }
        }

        [Fact]
        public async Task PollingStaysTheDefault()
        {
            var channel = RealtimeChannels.Create(null);
            Assert.IsType<DisabledRealtimeChannel>(channel);
            Assert.IsType<DisabledRealtimeChannel>(RealtimeChannels.Create(new RealtimeOptions { Endpoint = new Uri("wss://x.example/v1/realtime") }));
            await Assert.ThrowsAsync<CapabilityUnavailableException>(() => channel.SubscribeAsync(Type, _ => { }));
        }

        [Fact]
        public async Task OptionsAreCheckedBeforeAnyConnection()
        {
            var plain = Options();
            plain.Endpoint = new Uri("ws://api.example.org/v1/realtime");
            Assert.Equal(CapabilityState.Invalid, plain.Check().State);
            var local = Options();
            local.Endpoint = new Uri("ws://localhost:4000/v1/realtime");
            Assert.Equal(CapabilityState.Enabled, local.Check().State);
            var noToken = Options();
            noToken.AccessToken = null;
            Assert.Equal(CapabilityState.Missing, noToken.Check().State);

            var connector = new FakeConnector();
            var channel = RealtimeChannels.Create(plain, connector, new MemoryRealtimeCursorStore(), new TestDelay());
            await Assert.ThrowsAsync<CapabilityUnavailableException>(() => channel.SubscribeAsync(Type, _ => { }));
            Assert.Empty(connector.Tokens);
        }

        [Fact]
        public async Task SubscribesDeliversInOrderAndRejectsMalformedOrOutOfScopeEvents()
        {
            var connector = new FakeConnector();
            var conn = new FakeConnection();
            connector.Next.Enqueue(conn);
            var cursors = new MemoryRealtimeCursorStore();
            var options = Options();
            var rejected = new ConcurrentQueue<string>();
            options.OnRejected = r => rejected.Enqueue(r);
            var channel = RealtimeChannels.Create(options, connector, cursors, new TestDelay());
            var received = new ConcurrentQueue<RealtimeEnvelope>();
            conn.Push(Subscribed("10"));
            using (await channel.SubscribeAsync(Type, received.Enqueue))
            {
                var subscribe = JObject.Parse(conn.Sent[0]);
                Assert.Equal("subscribe", (string)subscribe["op"]);
                Assert.Equal(Tenant, (string)subscribe["tenantId"]);
                Assert.Equal(Farm, (string)subscribe["farmId"]);
                Assert.Equal(JTokenType.Null, subscribe["after"].Type);

                var first = Guid.NewGuid().ToString();
                conn.Push(Event("11", first));
                conn.Push(Event("11", first)); // repeat of a processed cursor
                conn.Push("not json");
                conn.Push(Event("12", tenant: OtherTenant));
                conn.Push(Event("13", farm: OtherFarm));
                conn.Push(Event("14", scheme: "other/1"));
                conn.Push(Event("x15"));
                conn.Push(Event("16", type: "alert.raised"));
                conn.Push(Event("17", id: first)); // same event id under a new cursor
                conn.Push(Event("18"));
                await Until(() => received.Count == 2);
                Assert.Equal("18", cursors.Get(((WebSocketRealtimeChannel)channel).CursorKey(Type)));
            }
            Assert.Equal(new[] { "not JSON", "event outside the subscribed workspace", "event outside the subscribed farm", "unknown envelope scheme", "event without a valid cursor", "unexpected event type" }, rejected.ToArray());
            var payload = received.First().Payload;
            Assert.Equal(new string('a', 64), (string)payload["sha256"]);
            Assert.All(conn.Sent, s => Assert.Contains((string)JObject.Parse(s)["op"], new[] { "subscribe", "ping" }));
        }

        [Fact]
        public async Task ReconnectsWithThePersistedCursorAfterATransientClose()
        {
            var connector = new FakeConnector();
            var first = new FakeConnection();
            var second = new FakeConnection();
            connector.Next.Enqueue(first);
            connector.Next.Enqueue(second);
            var cursors = new MemoryRealtimeCursorStore();
            var delay = new TestDelay();
            var channel = RealtimeChannels.Create(Options(), connector, cursors, delay);
            var received = new ConcurrentQueue<RealtimeEnvelope>();
            first.Push(Subscribed("40"));
            using (await channel.SubscribeAsync(Type, received.Enqueue))
            {
                first.Push(Event("41"));
                first.Push(Event("42"));
                await Until(() => received.Count == 2);
                first.CloseFromServer(4408); // heartbeat timeout: transient
                await Until(() => second.Sent.Length == 1);
                Assert.Equal("42", (string)JObject.Parse(second.Sent[0])["after"]);
                second.Push(Subscribed("42"));
                second.Push(Event("42")); // the server repeats nothing, but a repeat is harmless
                second.Push(Event("43"));
                await Until(() => received.Count == 3);
            }
            Assert.True(first.Disposed);
            Assert.Single(delay.Backoffs);
        }

        [Fact]
        public async Task ARefusalEndsTheSubscriptionWithoutReconnecting()
        {
            var connector = new FakeConnector();
            var conn = new FakeConnection();
            connector.Next.Enqueue(conn);
            var channel = RealtimeChannels.Create(Options(), connector, new MemoryRealtimeCursorStore(), new TestDelay());
            conn.Push(@"{""op"":""error"",""code"":""forbidden"",""message"":""not allowed"",""close"":true}");
            var e = await Assert.ThrowsAsync<RealtimeSubscriptionException>(() => channel.SubscribeAsync(Type, _ => { }));
            Assert.Equal("forbidden", e.Code);
            await Task.Delay(50);
            Assert.Single(connector.Tokens);
        }

        [Fact]
        public async Task GivesUpAfterTheConfiguredFailuresSoTheCallerCanPoll()
        {
            var connector = new FakeConnector { Failures = 10 };
            var delay = new TestDelay();
            var channel = RealtimeChannels.Create(Options(), connector, new MemoryRealtimeCursorStore(), delay);
            await Assert.ThrowsAnyAsync<Exception>(() => channel.SubscribeAsync(Type, _ => { }));
            Assert.Equal(4, connector.Tokens.Count);
            Assert.Equal(new[] { 1, 2, 4 }, delay.Backoffs.Select(b => (int)b.TotalSeconds).ToArray());
        }

        [Fact]
        public async Task CancellationStopsWaitingAndDisposingStopsTheStream()
        {
            var connector = new FakeConnector();
            var silent = new FakeConnection();
            connector.Next.Enqueue(silent);
            var channel = RealtimeChannels.Create(Options(), connector, new MemoryRealtimeCursorStore(), new TestDelay());
            using (var cts = new CancellationTokenSource(100))
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => channel.SubscribeAsync(Type, _ => { }, cts.Token));
            }
            await Until(() => silent.Disposed);

            var conn = new FakeConnection();
            connector.Next.Enqueue(conn);
            var received = 0;
            conn.Push(Subscribed("1"));
            var handle = await channel.SubscribeAsync(Type, _ => Interlocked.Increment(ref received));
            handle.Dispose();
            await Until(() => conn.Disposed);
            conn.Push(Event("2"));
            await Task.Delay(50);
            Assert.Equal(0, received);
        }

        [Fact]
        public async Task AnExpiredCursorAsksTheAppToRefreshAndContinuesFromTheServerCursor()
        {
            var connector = new FakeConnector();
            var conn = new FakeConnection();
            connector.Next.Enqueue(conn);
            var cursors = new MemoryRealtimeCursorStore();
            var options = Options();
            var resyncs = 0;
            options.OnResync = () => Interlocked.Increment(ref resyncs);
            var channel = (WebSocketRealtimeChannel)RealtimeChannels.Create(options, connector, cursors, new TestDelay());
            cursors.Set(channel.CursorKey(Type), "5");
            var received = new ConcurrentQueue<RealtimeEnvelope>();
            conn.Push(@"{""op"":""resync"",""reason"":""cursor_expired"",""cursor"":""900""}");
            conn.Push(Subscribed("900"));
            using (await channel.SubscribeAsync(Type, received.Enqueue))
            {
                Assert.Equal("5", (string)JObject.Parse(conn.Sent[0])["after"]);
                await Until(() => resyncs == 1);
                Assert.Equal("900", cursors.Get(channel.CursorKey(Type)));
                conn.Push(Event("899")); // older than the new cursor: not delivered
                conn.Push(Event("901"));
                await Until(() => received.Count == 1);
            }
        }

        [Fact]
        public void TheEnvelopeDeserializesWithItsPayload()
        {
            var e = JObject.Parse(Event("5"))["event"].ToObject<RealtimeEnvelope>();
            Assert.Equal(RealtimeEnvelope.Scheme, e.EnvelopeScheme);
            Assert.Equal(Type, e.EventType);
            Assert.Equal(Farm, e.Scope.FarmId);
            Assert.Null(e.CorrelationId);
            Assert.Equal(JTokenType.Object, e.Payload.Type);
            Assert.True(RealtimeProtocol.CompareCursors("10", "9") > 0);
            Assert.True(RealtimeProtocol.CompareCursors("9223372036854775808", "9223372036854775807") > 0);
            Assert.False(RealtimeProtocol.IsCursor("01"));
        }
    }
}
