namespace Metafarm.Twin.Core.Sync
{
    /// <summary>The state of one link in a snapshot's verification chain.</summary>
    public enum ChainLinkState
    {
        /// <summary>Not checked, because an earlier link failed or the caller did not ask for it.</summary>
        NotChecked,
        /// <summary>Checked by the client itself and it holds.</summary>
        Verified,
        /// <summary>Checked and it does not hold; see the report's problems.</summary>
        Failed,
        /// <summary>The commitment is in no batch yet, so there is no inclusion proof or batch root.</summary>
        NotBatched,
    }
}
