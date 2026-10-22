// D-39 simulation disclosure (owner-adopted wording, 2026-10-22), for any client view that shows yield data.
// The text is fixed and English-only in every locale: never translate, shorten or rephrase it. It must equal
// D39_SIMULATION_DISCLOSURE in apps/web/src/lib/yield.ts; a unit test in apps/web compares the two files.
namespace Metafarm.Twin.Core.Models
{
    public static class YieldDisclosure
    {
        /// <summary>Version id of the adopted wording.</summary>
        public const string Id = "D-39/simulation-banner/2026-10-22";

        /// <summary>Shown verbatim, in English, above every view of simulation yield data.</summary>
        public const string SimulationBanner =
            "SIMULATION ONLY: Yield metrics, cycles, and claim intents displayed in this interface are generated from deterministic simulation models. No real assets, mainnet signatures, or monetary liabilities are incurred.";

        /// <summary>BCP 47 tag the banner must be rendered with, whatever the interface language.</summary>
        public const string Language = "en";

        /// <summary>
        /// The banner a view must show for a cycle. Every cycle the platform can produce today is a simulation; a cycle
        /// that is not marked as one is not displayable until a disclosure for real cycles is approved, so this fails
        /// closed instead of returning nothing.
        /// </summary>
        public static string For(YieldCycleSummary cycle)
        {
            if (cycle == null) throw new System.ArgumentNullException(nameof(cycle));
            if (!cycle.IsSimulation) throw new System.InvalidOperationException("no approved disclosure exists for non-simulation yield cycles (D-39)");
            return SimulationBanner;
        }
    }
}
