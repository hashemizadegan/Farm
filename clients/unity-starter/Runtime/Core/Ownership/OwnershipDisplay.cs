using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Ownership
{
    public static class OwnershipDisplay
    {
        public static OwnershipKnowledge Classify(OwnershipReading o)
        {
            if (o == null) return OwnershipKnowledge.Unknown;
            switch (o.Status)
            {
                case "indexed":
                    return o.Source == "fixture" || o.Assurance == "fixture" ? OwnershipKnowledge.TestData : OwnershipKnowledge.Known;
                case "not_on_chain":
                    return OwnershipKnowledge.NotOnChain;
                default:
                    return OwnershipKnowledge.Unknown;
            }
        }

        /// <summary>A short label for the UI.</summary>
        public static string Label(OwnershipReading o)
        {
            switch (Classify(o))
            {
                case OwnershipKnowledge.Known:
                    return o.Assurance == "inclusion_verified" ? "On-chain holders (proof checked)" : "On-chain holders (as indexed)";
                case OwnershipKnowledge.TestData:
                    return "Test data, not chain state";
                case OwnershipKnowledge.NotOnChain:
                    return "Not on chain yet";
                default:
                    return "Ownership unknown (not indexed)";
            }
        }
    }
}
