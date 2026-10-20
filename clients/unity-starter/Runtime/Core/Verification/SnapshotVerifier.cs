// Checks a farm snapshot's structure without trusting the API: entity order, the Merkle root over
// the entity hashes, and the snapshot id over the canonical header. It does not recompute each
// entity's hash from its data (that needs the platform's canonical JSON for arbitrary numbers);
// the platform's verifier (verifyFarmSnapshot) does, and a single entity can be checked against
// the root with an inclusion proof.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Verification
{
    public static class SnapshotVerifier
    {
        private static readonly Regex SafeId = new Regex("^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$", RegexOptions.CultureInvariant);
        private static readonly Regex IsoTime = new Regex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", RegexOptions.CultureInvariant);

        /// <returns>The problems found; empty when the structure checks out.</returns>
        public static IReadOnlyList<string> CheckStructure(FarmSnapshot s)
        {
            var problems = new List<string>();
            if (s == null) { problems.Add("no snapshot"); return problems; }
            if (s.Scheme != FarmSnapshot.Scheme1) problems.Add("unknown scheme");
            if (s.Entities == null || s.Entities.Count == 0 || s.Entities.Count != s.EntityCount) { problems.Add("entityCount does not match the entities"); return problems; }
            for (var i = 1; i < s.Entities.Count; i++)
                if (string.CompareOrdinal(Key(s.Entities[i - 1]), Key(s.Entities[i])) >= 0) { problems.Add("entities are not in (type, id) order or repeat"); break; }
            var leaves = new List<string>(s.Entities.Count);
            foreach (var e in s.Entities)
            {
                try { leaves.Add(Rfc9162CommitmentVerifier.LeafHash(e.Sha256)); }
                catch (ArgumentException) { problems.Add($"{e.Type}/{e.Id}: malformed hash"); return problems; }
            }
            if (Rfc9162CommitmentVerifier.ComputeRoot(leaves) != s.Root) problems.Add("root does not match the entity hashes");
            if (HeaderId(s) != s.SnapshotId) problems.Add("snapshotId does not match the header");
            return problems;
        }

        /// <summary>SHA-256 of the canonical header, as the platform computes it; null for a header it cannot be computed for.</summary>
        public static string HeaderId(FarmSnapshot s)
        {
            if (s.FarmId == null || s.TakenAt == null || s.Root == null || !SafeId.IsMatch(s.FarmId) || !IsoTime.IsMatch(s.TakenAt)) return null;
            // Canonical JSON: keys sorted, no spaces; every value here is a plain ASCII string or an integer.
            var json = "{\"entityCount\":" + s.EntityCount.ToString(CultureInfo.InvariantCulture)
                + ",\"entitySchemaVersion\":" + s.EntitySchemaVersion.ToString(CultureInfo.InvariantCulture)
                + ",\"farmId\":\"" + s.FarmId + "\",\"root\":\"" + s.Root
                + "\",\"scheme\":\"" + FarmSnapshot.Scheme1 + "\",\"takenAt\":\"" + s.TakenAt + "\"}";
            using (var sha = SHA256.Create())
            {
                var digest = sha.ComputeHash(Encoding.UTF8.GetBytes(json));
                var sb = new StringBuilder(64);
                foreach (var b in digest) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        private static string Key(SnapshotEntity e) => e.Type + "\u0000" + e.Id;
    }
}
