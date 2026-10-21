namespace Metafarm.Twin.Core.Scene
{
    public enum SceneOperationKind
    {
        /// <summary>Take the object out of the scene.</summary>
        Remove,
        /// <summary>Redraw an object that is already in the scene from its new state.</summary>
        Refresh,
        /// <summary>Draw an object that is not in the scene yet.</summary>
        Place,
    }
}
