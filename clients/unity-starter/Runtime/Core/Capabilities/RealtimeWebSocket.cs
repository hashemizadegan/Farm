// Realtime over WebSocket (protocol metafarm-realtime.1, platform route GET /v1/realtime). Optional: polling stays the
// default (RealtimeChannels.Create returns the Disabled channel unless RealtimeOptions.Enabled is set), and the
// platform only serves the channel where REALTIME_EVENTS_ENABLED is on.
//
// A subscription is one connection: subscribe (workspace, optional farm, one event type, the persisted cursor), then
// events in cursor order. The last processed cursor is persisted (IRealtimeCursorStore), so a reconnect resumes
// without loss; repeats are dropped by cursor and event id. Malformed or out-of-scope events are rejected, never
// delivered. Refusals (forbidden, not found, malformed request) end the subscription; transport failures, heartbeat
// timeouts and backpressure closes reconnect with backoff. The client only ever sends `subscribe` and `ping`: no
// financial or ownership action can travel over this channel. Callbacks run on the receive loop's thread; marshal to
// the main thread in Unity.
using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Core.Capabilities
{
    public sealed class RealtimeOptions
    {
        /// <summary>Off by default: clients poll. Turn on only where the platform serves the realtime channel.</summary>
        public bool Enabled { get; set; }
        /// <summary>wss://host/v1/realtime (ws:// only for localhost).</summary>
        public Uri Endpoint { get; set; }
        public string TenantId { get; set; }
        /// <summary>Null for workspace-wide types; a farm id to receive that farm's farm-scoped events only.</summary>
        public string FarmId { get; set; }
        /// <summary>Supplies a current access token for each (re)connection.</summary>
        public Func<CancellationToken, Task<string>> AccessToken { get; set; }
        public TimeSpan PingInterval { get; set; } = TimeSpan.FromSeconds(15);
        /// <summary>Reconnect backoff (BackoffBase, BackoffMax) and how many consecutive failures are tolerated (MaxRetries).</summary>
        public PollingOptions Reconnect { get; set; } = new PollingOptions { MaxRetries = 10, BackoffBase = TimeSpan.FromSeconds(1), BackoffMax = TimeSpan.FromMinutes(1) };
        /// <summary>Called with a reason whenever a received message is rejected (never with its content).</summary>
        public Action<string> OnRejected { get; set; }

        public Capability Check()
        {
            if (!Enabled) return Capability.Disabled("realtime", "realtime is off; polling is used");
            if (Endpoint == null || AccessToken == null || !Guid.TryParse(TenantId, out _)) return Capability.Missing("realtime", "Endpoint, AccessToken and TenantId are required");
            if (FarmId != null && !Guid.TryParse(FarmId, out _)) return Capability.Invalid("realtime", "FarmId is not a UUID");
            var local = Endpoint.Host == "localhost" || Endpoint.Host == "127.0.0.1";
            if (Endpoint.Scheme != "wss" && !(Endpoint.Scheme == "ws" && local)) return Capability.Invalid("realtime", "the endpoint must use wss (ws only on localhost)");
            return Capability.Enabled("realtime", Endpoint.Host);
        }
    }

    /// <summary>Where the last processed cursor of each subscription is kept between connections (and sessions).</summary>
    public interface IRealtimeCursorStore
    {
        string Get(string key);
        void Set(string key, string cursor);
    }

    public sealed class MemoryRealtimeCursorStore : IRealtimeCursorStore
    {
        private readonly Dictionary<string, string> _cursors = new Dictionary<string, string>();
        public string Get(string key)
        {
            lock (_cursors) return _cursors.TryGetValue(key, out var c) ? c : null;
        }
        public void Set(string key, string cursor)
        {
            lock (_cursors) _cursors[key] = cursor;
        }
    }

    public interface IRealtimeConnection : IDisposable
    {
        Task WriteAsync(string text, CancellationToken cancellationToken);
        /// <summary>The next text message, or null once the connection is closed.</summary>
        Task<string> ReceiveAsync(CancellationToken cancellationToken);
        /// <summary>The close code the server sent, when closed.</summary>
        int? CloseCode { get; }
    }

    public interface IRealtimeConnector
    {
        Task<IRealtimeConnection> ConnectAsync(Uri endpoint, string accessToken, CancellationToken cancellationToken);
    }

    /// <summary>System.Net.WebSockets transport: Authorization header and the metafarm-realtime.1 subprotocol.</summary>
    public sealed class ClientWebSocketConnector : IRealtimeConnector
    {
        public async Task<IRealtimeConnection> ConnectAsync(Uri endpoint, string accessToken, CancellationToken cancellationToken)
        {
            var ws = new ClientWebSocket();
            ws.Options.AddSubProtocol(RealtimeProtocol.Name);
            ws.Options.SetRequestHeader("Authorization", "Bearer " + accessToken);
            try
            {
                await ws.ConnectAsync(endpoint, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                ws.Dispose();
                throw;
            }
            return new Connection(ws);
        }

        private sealed class Connection : IRealtimeConnection
        {
            private const int MaxMessageBytes = 1 << 20;
            private readonly ClientWebSocket _ws;
            private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);

            public Connection(ClientWebSocket ws) => _ws = ws;

            public int? CloseCode => (int?)_ws.CloseStatus;

            public async Task WriteAsync(string text, CancellationToken cancellationToken)
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    _writeLock.Release();
                }
            }

            public async Task<string> ReceiveAsync(CancellationToken cancellationToken)
            {
                var buffer = new byte[8192];
                var message = new List<byte>();
                while (true)
                {
                    var r = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close) return null;
                    for (var i = 0; i < r.Count; i++) message.Add(buffer[i]);
                    if (message.Count > MaxMessageBytes) throw new InvalidOperationException("realtime message too large");
                    if (r.EndOfMessage) return r.MessageType == WebSocketMessageType.Text ? Encoding.UTF8.GetString(message.ToArray()) : "";
                }
            }

            public void Dispose()
            {
                try
                {
                    if (_ws.State == WebSocketState.Open) _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None).Wait(TimeSpan.FromSeconds(2));
                }
                catch (Exception)
                {
                    // Closing is best effort.
                }
                _ws.Dispose();
                _writeLock.Dispose();
            }
        }
    }

    public static class RealtimeProtocol
    {
        public const string Name = "metafarm-realtime.1";
        /// <summary>Close codes after which reconnecting cannot help (the request itself is refused).</summary>
        public static bool IsTerminalClose(int? code) => code == 4400 || code == 4403 || code == 4404 || code == 4409;
        public static bool IsTerminalError(string code) =>
            code == "malformed" || code == "unknown_type" || code == "forbidden" || code == "not_found" || code == "farm_scope_required" || code == "already_subscribed";

        private static readonly Regex CursorPattern = new Regex("^(0|[1-9][0-9]{0,18})$");
        public static bool IsCursor(string s) => s != null && CursorPattern.IsMatch(s);

        /// <summary>Orders two valid cursors (decimal strings without leading zeros).</summary>
        public static int CompareCursors(string a, string b) => a.Length != b.Length ? a.Length.CompareTo(b.Length) : string.CompareOrdinal(a, b);
    }

    public sealed class RealtimeSubscriptionException : Exception
    {
        public RealtimeSubscriptionException(string code, string message) : base(message) => Code = code;
        public string Code { get; }
    }

    public static class RealtimeChannels
    {
        /// <summary>The configured channel: WebSocket when enabled and valid, otherwise the Disabled channel (poll instead).</summary>
        public static IRealtimeChannel Create(RealtimeOptions options, IRealtimeConnector connector = null, IRealtimeCursorStore cursors = null, IDelay delay = null)
        {
            if (options == null || !options.Enabled) return new DisabledRealtimeChannel();
            return new WebSocketRealtimeChannel(options, connector ?? new ClientWebSocketConnector(), cursors ?? new MemoryRealtimeCursorStore(), delay ?? new TaskDelay());
        }
    }

    public sealed class WebSocketRealtimeChannel : IRealtimeChannel
    {
        private static readonly Regex EventTypePattern = new Regex("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,4}$");
        private readonly RealtimeOptions _options;
        private readonly IRealtimeConnector _connector;
        private readonly IRealtimeCursorStore _cursors;
        private readonly IDelay _delay;

        public WebSocketRealtimeChannel(RealtimeOptions options, IRealtimeConnector connector, IRealtimeCursorStore cursors, IDelay delay)
        {
            _options = options ?? throw new ArgumentNullException(nameof(options));
            _connector = connector ?? throw new ArgumentNullException(nameof(connector));
            _cursors = cursors ?? throw new ArgumentNullException(nameof(cursors));
            _delay = delay ?? throw new ArgumentNullException(nameof(delay));
            Capability = options.Check();
        }

        public Capability Capability { get; }

        /// <summary>The cursor-store key of a subscription: workspace, farm (or "*") and event type.</summary>
        public string CursorKey(string eventType) => $"{_options.TenantId}/{_options.FarmId ?? "*"}/{eventType}";

        public async Task<IDisposable> SubscribeAsync(string eventType, Action<RealtimeEnvelope> onEvent, CancellationToken cancellationToken = default)
        {
            if (!Capability.IsUsable) throw new CapabilityUnavailableException(Capability);
            if (eventType == null || !EventTypePattern.IsMatch(eventType)) throw new ArgumentException("not an event type", nameof(eventType));
            if (onEvent == null) throw new ArgumentNullException(nameof(onEvent));
            var subscription = new Subscription(this, eventType, onEvent, cancellationToken);
            await subscription.Ready.ConfigureAwait(false);
            return subscription;
        }

        private sealed class Subscription : IDisposable
        {
            private readonly WebSocketRealtimeChannel _channel;
            private readonly string _eventType;
            private readonly Action<RealtimeEnvelope> _onEvent;
            private readonly CancellationTokenSource _cts;
            private readonly TaskCompletionSource<bool> _ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly HashSet<string> _seenIds = new HashSet<string>();
            private readonly Queue<string> _seenOrder = new Queue<string>();

            public Subscription(WebSocketRealtimeChannel channel, string eventType, Action<RealtimeEnvelope> onEvent, CancellationToken cancellationToken)
            {
                _channel = channel;
                _eventType = eventType;
                _onEvent = onEvent;
                _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                _cts.Token.Register(() => _ready.TrySetCanceled());
                Loop = Task.Run(() => RunAsync(_cts.Token));
            }

            public Task Ready => _ready.Task;
            public Task Loop { get; }

            public void Dispose() => _cts.Cancel();

            private RealtimeOptions Options => _channel._options;
            private string Key => _channel.CursorKey(_eventType);

            private async Task RunAsync(CancellationToken ct)
            {
                var failures = 0;
                Exception lastError = null;
                while (!ct.IsCancellationRequested)
                {
                    int? closeCode = null;
                    try
                    {
                        var token = await Options.AccessToken(ct).ConfigureAwait(false);
                        using (var connection = await _channel._connector.ConnectAsync(Options.Endpoint, token, ct).ConfigureAwait(false))
                        using (var pingCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
                        {
                            await connection.WriteAsync(SubscribeMessage(), ct).ConfigureAwait(false);
                            var pinging = PingAsync(connection, pingCts.Token);
                            try
                            {
                                while (true)
                                {
                                    var text = await connection.ReceiveAsync(ct).ConfigureAwait(false);
                                    if (text == null) break;
                                    var outcome = Handle(text);
                                    if (outcome == Outcome.Subscribed) failures = 0;
                                    else if (outcome == Outcome.Terminal) return;
                                }
                            }
                            finally
                            {
                                pingCts.Cancel();
                                try
                                {
                                    await pinging.ConfigureAwait(false);
                                }
                                catch (OperationCanceledException)
                                {
                                    // stopped with the connection
                                }
                            }
                            closeCode = connection.CloseCode;
                        }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception e)
                    {
                        lastError = e;
                    }
                    if (RealtimeProtocol.IsTerminalClose(closeCode))
                    {
                        _ready.TrySetException(new RealtimeSubscriptionException("closed", $"the server ended the subscription ({closeCode})"));
                        return;
                    }
                    failures++;
                    if (failures > Options.Reconnect.MaxRetries)
                    {
                        _ready.TrySetException(lastError ?? new RealtimeSubscriptionException("unavailable", "the realtime channel could not be reached; poll instead"));
                        return;
                    }
                    try
                    {
                        await _channel._delay.DelayAsync(Options.Reconnect.Backoff(failures), ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                }
            }

            private async Task PingAsync(IRealtimeConnection connection, CancellationToken ct)
            {
                while (!ct.IsCancellationRequested)
                {
                    await _channel._delay.DelayAsync(Options.PingInterval, ct).ConfigureAwait(false);
                    await connection.WriteAsync("{\"op\":\"ping\"}", ct).ConfigureAwait(false);
                }
            }

            private string SubscribeMessage()
            {
                var after = _channel._cursors.Get(Key);
                return new JObject
                {
                    ["op"] = "subscribe",
                    ["tenantId"] = Options.TenantId,
                    ["farmId"] = Options.FarmId == null ? JValue.CreateNull() : (JToken)Options.FarmId,
                    ["types"] = new JArray(_eventType),
                    ["after"] = RealtimeProtocol.IsCursor(after) ? (JToken)after : JValue.CreateNull(),
                }.ToString(Formatting.None);
            }

            private enum Outcome { Continue, Subscribed, Terminal }

            private void Reject(string reason) => Options.OnRejected?.Invoke(reason);

            private Outcome Handle(string text)
            {
                JObject m;
                try
                {
                    m = JObject.Parse(text);
                }
                catch (JsonException)
                {
                    Reject("not JSON");
                    return Outcome.Continue;
                }
                switch ((string)m["op"])
                {
                    case "subscribed":
                        var cursor = m["cursor"]?.Type == JTokenType.String ? (string)m["cursor"] : null;
                        if (cursor != null && RealtimeProtocol.IsCursor(cursor) && _channel._cursors.Get(Key) == null) _channel._cursors.Set(Key, cursor);
                        _ready.TrySetResult(true);
                        return Outcome.Subscribed;
                    case "event":
                        Deliver(m);
                        return Outcome.Continue;
                    case "error":
                        var code = m["code"]?.Type == JTokenType.String ? (string)m["code"] : "unknown";
                        if (!RealtimeProtocol.IsTerminalError(code)) return Outcome.Continue;
                        _ready.TrySetException(new RealtimeSubscriptionException(code, $"the server refused the subscription ({code})"));
                        return Outcome.Terminal;
                    case "heartbeat":
                    case "pong":
                        return Outcome.Continue;
                    default:
                        Reject("unknown message");
                        return Outcome.Continue;
                }
            }

            private void Deliver(JObject m)
            {
                var cursor = m["cursor"]?.Type == JTokenType.String ? (string)m["cursor"] : null;
                if (!RealtimeProtocol.IsCursor(cursor))
                {
                    Reject("event without a valid cursor");
                    return;
                }
                var last = _channel._cursors.Get(Key);
                if (RealtimeProtocol.IsCursor(last) && RealtimeProtocol.CompareCursors(cursor, last) <= 0) return; // already processed
                RealtimeEnvelope e = null;
                string problem;
                try
                {
                    e = (m["event"] as JObject)?.ToObject<RealtimeEnvelope>();
                    problem = Problem(e);
                }
                catch (JsonException)
                {
                    problem = "event does not deserialize";
                }
                // The cursor advances past a rejected event too: the server will not send it differently.
                _channel._cursors.Set(Key, cursor);
                if (problem != null)
                {
                    Reject(problem);
                    return;
                }
                if (!_seenIds.Add(e.EventId)) return;
                _seenOrder.Enqueue(e.EventId);
                if (_seenOrder.Count > 1024) _seenIds.Remove(_seenOrder.Dequeue());
                _onEvent(e);
            }

            private string Problem(RealtimeEnvelope e)
            {
                if (e == null) return "missing event";
                if (e.EnvelopeScheme != RealtimeEnvelope.Scheme) return "unknown envelope scheme";
                if (e.EventType != _eventType) return "unexpected event type";
                if (e.SchemaVersion < 1) return "invalid schema version";
                if (!Guid.TryParse(e.EventId, out _)) return "invalid event id";
                if (e.Scope == null || !string.Equals(e.Scope.TenantId, Options.TenantId, StringComparison.OrdinalIgnoreCase)) return "event outside the subscribed workspace";
                if (Options.FarmId != null && !string.Equals(e.Scope.FarmId, Options.FarmId, StringComparison.OrdinalIgnoreCase)) return "event outside the subscribed farm";
                if (!(e.Payload is JObject)) return "payload is not an object";
                return null;
            }
        }
    }
}
