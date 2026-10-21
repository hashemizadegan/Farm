using System.Collections.Generic;

namespace Metafarm.Twin.Validation
{
    public sealed class ValidationStep
    {
        public ValidationStep(string name, IReadOnlyList<string> problems)
        {
            Name = name;
            Problems = problems;
        }

        public string Name { get; }
        public IReadOnlyList<string> Problems { get; }
        public bool Passed => Problems.Count == 0;
        /// <summary>One line for logs, starting with TWIN-VALIDATION so it can be found in a player log.</summary>
        public override string ToString() => $"TWIN-VALIDATION {(Passed ? "PASS" : "FAIL")} {Name}" + (Passed ? "" : ": " + string.Join("; ", Problems));
    }
}
