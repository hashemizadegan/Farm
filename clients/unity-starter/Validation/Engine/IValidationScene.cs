// Validation only (not part of the runtime). What the step runner needs from a scene: the Unity
// harness implements it over FarmSceneLoader; the CI tests implement it over a model.
using System.Collections.Generic;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Scene;

namespace Metafarm.Twin.Validation
{
    public interface IValidationScene
    {
        /// <summary>Discards the current scene and loads Samples/scene.sample.json afresh.</summary>
        Task ResetAsync();
        /// <summary>Applies a plan exactly as an application would (FarmSceneLoader.ApplySnapshotPlan in Unity).</summary>
        void Apply(SceneUpdatePlan plan);
        /// <summary>The scene objects currently drawn, by twin object id.</summary>
        IReadOnlyCollection<string> DrawnObjectIds { get; }
        /// <summary>Engine-level checks after a change (in Unity: on the next frame, real GameObjects); returns problems.</summary>
        Task<IReadOnlyList<string>> CheckEngineAsync();
    }
}
