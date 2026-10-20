using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Api
{
    /// <summary>
    /// JSON settings for the twin API. Dates stay strings exactly as sent: by default Newtonsoft
    /// turns ISO timestamps into DateTime and back into a culture-formatted string, which would change
    /// values that are hashed or compared (snapshot times, source times).
    /// </summary>
    public static class TwinJson
    {
        public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Double,
            MissingMemberHandling = MissingMemberHandling.Ignore,
        };

        public static T Deserialize<T>(string json) => JsonConvert.DeserializeObject<T>(json, Settings);
    }
}
