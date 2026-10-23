// Basemap imagery for the map view, provider-neutral. Default: unavailable (the scene draws without a basemap).
using System;

namespace Metafarm.Twin.Core.Capabilities
{
    public sealed class MapImageryConfig
    {
        public MapImageryConfig(string styleUrl, string attribution)
        {
            StyleUrl = styleUrl;
            Attribution = attribution;
        }

        /// <summary>A MapLibre-compatible style document (https).</summary>
        public string StyleUrl { get; }
        /// <summary>Attribution the provider's terms require; shown whenever the imagery is.</summary>
        public string Attribution { get; }
    }

    public interface IMapImagerySource
    {
        Capability Capability { get; }
        /// <summary>The configuration, or <see cref="CapabilityUnavailableException"/> when the capability is not Enabled.</summary>
        MapImageryConfig GetConfig();
    }

    /// <summary>No basemap provider: the default.</summary>
    public sealed class UnavailableMapImagerySource : IMapImagerySource
    {
        public Capability Capability { get; } = Capability.Disabled("map-imagery", "no basemap provider configured");
        public MapImageryConfig GetConfig() => throw new CapabilityUnavailableException(Capability);
    }

    /// <summary>A fixed provider from configuration: https only, attribution required (same rules as the web).</summary>
    public sealed class StaticMapImagerySource : IMapImagerySource
    {
        private readonly MapImageryConfig _config;

        public StaticMapImagerySource(string styleUrl, string attribution)
        {
            if (string.IsNullOrEmpty(styleUrl))
            {
                Capability = Capability.Disabled("map-imagery", "no style URL configured");
                return;
            }
            if (!Uri.TryCreate(styleUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            {
                Capability = Capability.Invalid("map-imagery", "the style URL must be an absolute https URL");
                return;
            }
            if (string.IsNullOrWhiteSpace(attribution))
            {
                Capability = Capability.Missing("map-imagery", "the provider's attribution is required");
                return;
            }
            _config = new MapImageryConfig(uri.ToString(), attribution);
            Capability = Capability.Enabled("map-imagery", uri.Host);
        }

        public Capability Capability { get; }

        public MapImageryConfig GetConfig() => Capability.IsUsable ? _config : throw new CapabilityUnavailableException(Capability);
    }
}
