namespace Metafarm.Twin.Core.Ownership
{
    /// <summary>What the client can honestly say about an ownership reading.</summary>
    public enum OwnershipKnowledge
    {
        /// <summary>Holders come from the chain or an indexer of it.</summary>
        Known,
        /// <summary>The platform could not read the chain for this asset: unknown, not "no owner".</summary>
        Unknown,
        /// <summary>The asset has no on-chain identity yet.</summary>
        NotOnChain,
        /// <summary>Fixture data for tests and local development; never chain state.</summary>
        TestData,
    }
}
