// Realtime updates: the envelope matches the platform's event envelope (metafarm-event/1). The default channel is
// Disabled and clients poll (Poller, YieldCycleWatcher). WebSocketRealtimeChannel (RealtimeWebSocket.cs) implements
// IRealtimeChannel over the platform's optional WebSocket route; RealtimeChannels.Create picks it only when enabled.
using System;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Core.Capabilities
{
    public sealed class RealtimeScope
    {
        [JsonProperty("tenantId")] public string TenantId;
        /// <summary>Null for a workspace-wide event.</summary>
        [JsonProperty("farmId")] public string FarmId;
    }

    public sealed class RealtimeEnvelope
    {
        public const string Scheme = "metafarm-event/1";
        [JsonProperty("scheme")] public string EnvelopeScheme;
        [JsonProperty("type")] public string EventType;
        [JsonProperty("schemaVersion")] public int SchemaVersion;
        [JsonProperty("id")] public string EventId;
        [JsonProperty("scope")] public RealtimeScope Scope;
        [JsonProperty("occurredAt")] public string OccurredAt;
        [JsonProperty("correlationId")] public string CorrelationId;
        [JsonProperty("payload")] public JToken Payload;
    }

    public interface IRealtimeChannel
    {
        Capability Capability { get; }
        /// <summary>Receives envelopes of one event type until the returned handle is disposed or the token is cancelled.</summary>
        Task<IDisposable> SubscribeAsync(string eventType, Action<RealtimeEnvelope> onEvent, CancellationToken cancellationToken = default);
    }

    /// <summary>The default: no push transport. Subscribing fails with CapabilityUnavailableException; poll instead.</summary>
    public sealed class DisabledRealtimeChannel : IRealtimeChannel
    {
        public Capability Capability { get; } = Capability.Disabled("realtime", "realtime is off; polling is used");
        public Task<IDisposable> SubscribeAsync(string eventType, Action<RealtimeEnvelope> onEvent, CancellationToken cancellationToken = default) =>
            Task.FromException<IDisposable>(new CapabilityUnavailableException(Capability));
    }
}
