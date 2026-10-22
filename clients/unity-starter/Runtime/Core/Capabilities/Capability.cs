// Capability states, as the platform reports them (packages/config capabilities.ts): a client feature that depends on
// an external provider is Enabled, Disabled (intentionally off: the default), Missing (selected but incomplete) or
// Invalid. A client never treats anything but Enabled as usable, and never fakes the feature.
using System;

namespace Metafarm.Twin.Core.Capabilities
{
    public enum CapabilityState
    {
        Disabled = 0,
        Enabled = 1,
        Missing = 2,
        Invalid = 3,
    }

    public sealed class Capability
    {
        private Capability(string name, CapabilityState state, string provider, string reason)
        {
            Name = name;
            State = state;
            Provider = provider;
            Reason = reason;
        }

        public string Name { get; }
        public CapabilityState State { get; }
        /// <summary>The provider in use when Enabled (e.g. a tile host); null otherwise.</summary>
        public string Provider { get; }
        /// <summary>Why it is in this state, for logs and an "unavailable" message; never contains a secret.</summary>
        public string Reason { get; }
        public bool IsUsable => State == CapabilityState.Enabled;

        public static Capability Enabled(string name, string provider) => new Capability(name, CapabilityState.Enabled, provider, null);
        public static Capability Disabled(string name, string reason) => new Capability(name, CapabilityState.Disabled, null, reason);
        public static Capability Missing(string name, string reason) => new Capability(name, CapabilityState.Missing, null, reason);
        public static Capability Invalid(string name, string reason) => new Capability(name, CapabilityState.Invalid, null, reason);
    }

    /// <summary>Thrown when a feature is used while its capability is not Enabled.</summary>
    public sealed class CapabilityUnavailableException : InvalidOperationException
    {
        public CapabilityUnavailableException(Capability capability)
            : base($"{capability.Name} is {capability.State.ToString().ToLowerInvariant()}: {capability.Reason}")
        {
            Capability = capability;
        }

        public Capability Capability { get; }
    }
}
