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

        /// <summary>A short label for the UI. Known ownership names the slot it is as of, when given.</summary>
        public static string Label(OwnershipReading o)
        {
            switch (Classify(o))
            {
                case OwnershipKnowledge.Known:
                {
                    // An indexed asset with no holders (for example, burned) is known to have none:
                    // that is different from "not indexed", which is unknown.
                    var what = o.Holders == null || o.Holders.Count == 0 ? "No current holders on chain" : "On-chain holders";
                    var basis = o.Assurance == "inclusion_verified" ? "proof checked" : "as indexed";
                    var at = string.IsNullOrEmpty(o.AsOfSlot) ? "" : ", slot " + o.AsOfSlot;
                    if (o.HeldByYou == true) what = "You hold this";
                    return what + " (" + basis + at + ")";
                }
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
