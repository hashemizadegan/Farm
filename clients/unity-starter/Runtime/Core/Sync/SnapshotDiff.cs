// What changed between two verified snapshots of one farm, by entity (type, id), decided by the
// entities' committed hashes (commitToRecord over each entity's data, platform contract
// metafarm-record/1). Before diffing, each snapshot's structure is re-checked: the entity hashes, in
// order, must reproduce the snapshot's Merkle root and the root its snapshot id. That proves the
// hashes compared here are exactly the set the snapshot commits to. It does not prove that an
// entity's data matches its hash: the client does not recompute entity hashes from their data (that
// needs the platform's canonical JSON); the platform checks that when it stores and serves a snapshot,
// and SnapshotSync additionally ties the whole byte string to the commitment's content hash.
// Lists are in the platform's entity order: ordinal (type, NUL, id).
using System;
using System.Collections.Generic;
using System.Linq;
using Metafarm.Twin.Core.Models;
using Metafarm.Twin.Core.Verification;

namespace Metafarm.Twin.Core.Sync
{
    public sealed class SnapshotDiff
    {
        private SnapshotDiff(List<SnapshotEntity> added, List<SnapshotEntity> removed, List<EntityChange> changed, int unchanged)
        {
            Added = added;
            Removed = removed;
            Changed = changed;
            UnchangedCount = unchanged;
        }

        public IReadOnlyList<SnapshotEntity> Added { get; }
        /// <summary>The entities as they were in the earlier snapshot.</summary>
        public IReadOnlyList<SnapshotEntity> Removed { get; }
        public IReadOnlyList<EntityChange> Changed { get; }
        public int UnchangedCount { get; }
        public bool IsEmpty => Added.Count == 0 && Removed.Count == 0 && Changed.Count == 0;

        /// <param name="from">The earlier snapshot, or null for a first sync (every entity is then added).</param>
        /// <param name="to">The later snapshot.</param>
        /// <exception cref="ArgumentException">A snapshot fails its structure check, or they are for different farms.</exception>
        public static SnapshotDiff Between(FarmSnapshot from, FarmSnapshot to)
        {
            Require(to, nameof(to));
            if (from != null)
            {
                Require(from, nameof(from));
                if (from.FarmId != to.FarmId) throw new ArgumentException("the snapshots are for different farms", nameof(to));
            }
            var before = from == null ? new Dictionary<string, SnapshotEntity>(StringComparer.Ordinal) : Index(from);
            var after = Index(to);
            var added = new List<SnapshotEntity>();
            var removed = new List<SnapshotEntity>();
            var changed = new List<EntityChange>();
            var unchanged = 0;
            foreach (var key in after.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                if (!before.TryGetValue(key, out var old)) added.Add(after[key]);
                else if (old.Sha256 != after[key].Sha256) changed.Add(new EntityChange(old, after[key]));
                else unchanged++;
            }
            foreach (var key in before.Keys.OrderBy(k => k, StringComparer.Ordinal))
                if (!after.ContainsKey(key)) removed.Add(before[key]);
            return new SnapshotDiff(added, removed, changed, unchanged);
        }

        public static string Key(string type, string id) => type + "\u0000" + id;

        private static Dictionary<string, SnapshotEntity> Index(FarmSnapshot s)
        {
            var d = new Dictionary<string, SnapshotEntity>(StringComparer.Ordinal);
            foreach (var e in s.Entities) d[Key(e.Type, e.Id)] = e;
            return d;
        }

        private static void Require(FarmSnapshot s, string name)
        {
            if (s == null) throw new ArgumentNullException(name);
            var problems = SnapshotVerifier.CheckStructure(s);
            if (problems.Count > 0) throw new ArgumentException($"{name} does not check out: {string.Join("; ", problems)}", name);
        }
    }
}
