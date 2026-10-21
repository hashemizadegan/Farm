// Checks an anchor plan before the client shows it, and words it for display. A plan is never
// presented as something that happened: only a root found in a finalized Solana transaction would be
// an anchor, and the platform does not write any yet.
using System.Collections.Generic;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Anchoring
{
    public sealed class AnchorPlanReview
    {
        public const string Scheme = "metafarm-anchor/1";
        private static readonly Dictionary<string, string> SubjectSchemes = new Dictionary<string, string>
        {
            ["batch"] = "metafarm-merkle-sha256/1",
            ["snapshot"] = "metafarm-farm-snapshot/1",
        };

        private AnchorPlanReview(bool ok, IReadOnlyList<string> problems, string summary)
        {
            Ok = ok;
            Problems = problems;
            Summary = summary;
        }

        /// <summary>True when the plan is well formed, plan-only, and about the root the caller holds.</summary>
        public bool Ok { get; }
        public IReadOnlyList<string> Problems { get; }
        /// <summary>A line for the UI, always worded as a plan.</summary>
        public string Summary { get; }

        /// <param name="expectedRoot">The root the client verified itself (snapshot or batch root).</param>
        public static AnchorPlanReview Of(AnchorPlan plan, string expectedRoot)
        {
            var problems = new List<string>();
            if (plan == null) return new AnchorPlanReview(false, new[] { "no plan" }, "No anchor plan");
            if (plan.Scheme != Scheme) problems.Add($"unknown scheme {plan.Scheme}");
            if (plan.Executable) problems.Add("the plan claims to be executable; this client only shows plans");
            if (!AnchorCarriers.IsCarrier(plan.Carrier)) problems.Add($"unknown carrier {plan.Carrier}");
            if (!AnchorCarriers.IsNetwork(plan.Network)) problems.Add($"unknown network {plan.Network}");
            if (plan.Root == null || plan.Root != expectedRoot) problems.Add("the plan is for a different root");
            if (plan.Subject == null || !SubjectSchemes.TryGetValue(plan.Subject, out var subjectScheme)) problems.Add($"unknown subject {plan.Subject}");
            else if (plan.Carrier == AnchorCarriers.Token2022Metadata && plan.MetadataField?.Value != $"{subjectScheme}:{plan.Root}")
                problems.Add("the metadata value does not name this root");
            if (plan.Carrier == AnchorCarriers.BubblegumV1Leaf && (plan.LeafMetadata?.Uri == null || !plan.LeafMetadata.Uri.StartsWith("https://") || !plan.LeafMetadata.Uri.EndsWith("/" + plan.Root)))
                problems.Add("the leaf URI does not point at this root's anchor document");

            var shortRoot = plan.Root != null && plan.Root.Length >= 12 ? plan.Root.Substring(0, 12) : plan.Root;
            var summary = problems.Count == 0
                ? $"Planned only, not anchored: {plan.Subject} root {shortRoot}… via {plan.Carrier} on {plan.Network}"
                : "Anchor plan not shown: it did not pass the client's checks";
            return new AnchorPlanReview(problems.Count == 0, problems, summary);
        }
    }
}
