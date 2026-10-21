// Canonical claim leaf of the real-yield claim tree (plan rev. 4 section 6.2), byte for byte as
// packages/domain/src/yield/claim-tree.ts encodes it. Read-only use: the client decodes and checks leaves
// it is shown; it builds no tree and holds no keys. Simulation only while D-26 (hash function) is open.
//
// 201 bytes, integers little-endian:
// domain tag 32 = SHA-256("metafarm-yield-leaf/1") | network id 1 | cluster identity 32 | cycle id 16
// (UUID bytes in RFC 4122 written order, not System.Guid's) | cycle version u32 | epoch u32 |
// economic asset id 32 | recipient 32 | payout mint 32 | amount u64 | formula version u16 |
// leaf-layout version u16 | leaf index u32.
using System;
using System.Security.Cryptography;
using System.Text;

namespace Metafarm.Twin.Core.Yield
{
    public static class ClaimLeafCodec
    {
        public const string Domain = "metafarm-yield-leaf/1";
        public const int Length = 201;
        public const ushort LayoutVersion = 1;
        /// <summary>Layout 2: the 201 bytes of layout 1 (layout version 2 at offset 195), then the 32-byte ownership snapshot hash.</summary>
        public const int LengthSnapshotBound = 233;
        public const ushort LayoutVersionSnapshotBound = 2;

        /// <summary>SHA-256 of the domain string: the first 32 bytes of every leaf.</summary>
        public static byte[] DomainTag()
        {
            using (var sha = SHA256.Create()) return sha.ComputeHash(Encoding.UTF8.GetBytes(Domain));
        }

        /// <summary>
        /// The leaf bytes: 201 for layout 1, 233 for layout 2 (with OwnershipSnapshotHash). Refuses a zero amount
        /// (the platform requires 0 &lt; amount ≤ 2^64 − 1).
        /// </summary>
        public static byte[] Encode(ClaimLeafFields f)
        {
            if (f == null) throw new ArgumentNullException(nameof(f));
            if (f.Amount == 0) throw new ArgumentException("a leaf amount must be greater than zero", nameof(f));
            Require(f.ClusterIdentity, 32, nameof(f.ClusterIdentity));
            Require(f.CycleId, 16, nameof(f.CycleId));
            Require(f.EconomicAssetId, 32, nameof(f.EconomicAssetId));
            Require(f.Recipient, 32, nameof(f.Recipient));
            Require(f.PayoutMint, 32, nameof(f.PayoutMint));
            var bound = f.LeafLayoutVersion == LayoutVersionSnapshotBound;
            if (!bound && f.LeafLayoutVersion != LayoutVersion) throw new ArgumentException("unknown leaf layout version", nameof(f));
            if (bound) Require(f.OwnershipSnapshotHash, 32, nameof(f.OwnershipSnapshotHash));
            else if (f.OwnershipSnapshotHash != null) throw new ArgumentException("a layout 1 leaf has no ownership snapshot hash", nameof(f));

            var b = new byte[bound ? LengthSnapshotBound : Length];
            var at = 0;
            Put(b, ref at, DomainTag());
            b[at++] = f.NetworkId;
            Put(b, ref at, f.ClusterIdentity);
            Put(b, ref at, f.CycleId);
            PutLittleEndian(b, ref at, f.CycleVersion, 4);
            PutLittleEndian(b, ref at, f.Epoch, 4);
            Put(b, ref at, f.EconomicAssetId);
            Put(b, ref at, f.Recipient);
            Put(b, ref at, f.PayoutMint);
            PutLittleEndian(b, ref at, f.Amount, 8);
            PutLittleEndian(b, ref at, f.FormulaVersion, 2);
            PutLittleEndian(b, ref at, f.LeafLayoutVersion, 2);
            PutLittleEndian(b, ref at, f.LeafIndex, 4);
            if (bound) Put(b, ref at, f.OwnershipSnapshotHash);
            if (at != b.Length) throw new InvalidOperationException("leaf length");
            return b;
        }

        /// <summary>Decodes leaf bytes (layout 1: 201, layout 2: 233), checking the domain tag, layout and length.</summary>
        public static ClaimLeafFields Decode(byte[] b)
        {
            if (b == null || (b.Length != Length && b.Length != LengthSnapshotBound)) throw new ArgumentException("a claim leaf is 201 or 233 bytes", nameof(b));
            var tag = DomainTag();
            for (var i = 0; i < 32; i++)
                if (b[i] != tag[i]) throw new ArgumentException("the leaf's domain tag is not metafarm-yield-leaf/1", nameof(b));
            var f = new ClaimLeafFields
            {
                NetworkId = b[32],
                ClusterIdentity = Slice(b, 33, 32),
                CycleId = Slice(b, 65, 16),
                CycleVersion = (uint)ReadLittleEndian(b, 81, 4),
                Epoch = (uint)ReadLittleEndian(b, 85, 4),
                EconomicAssetId = Slice(b, 89, 32),
                Recipient = Slice(b, 121, 32),
                PayoutMint = Slice(b, 153, 32),
                Amount = ReadLittleEndian(b, 185, 8),
                FormulaVersion = (ushort)ReadLittleEndian(b, 193, 2),
                LeafLayoutVersion = (ushort)ReadLittleEndian(b, 195, 2),
                LeafIndex = (uint)ReadLittleEndian(b, 197, 4),
            };
            // A zero-amount claim is never valid (zero-allocation policy): refused on decode as on encode.
            if (f.Amount == 0) throw new ArgumentException("a leaf amount must be greater than zero", nameof(b));
            if (f.LeafLayoutVersion == LayoutVersion && b.Length == Length) return f;
            if (f.LeafLayoutVersion == LayoutVersionSnapshotBound && b.Length == LengthSnapshotBound)
            {
                f.OwnershipSnapshotHash = Slice(b, 201, 32);
                return f;
            }
            throw new ArgumentException("unknown leaf layout version, or a length that does not match it", nameof(b));
        }

        /// <summary>The 16 bytes of a lowercase UUID in RFC 4122 written order (System.Guid.ToByteArray differs).</summary>
        public static byte[] UuidBytes(string uuid)
        {
            if (uuid == null || uuid.Length != 36 || uuid[8] != '-' || uuid[13] != '-' || uuid[18] != '-' || uuid[23] != '-')
                throw new ArgumentException("a lowercase UUID is required", nameof(uuid));
            var hex = uuid.Replace("-", "");
            foreach (var c in hex)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new ArgumentException("a lowercase UUID is required", nameof(uuid));
            var b = new byte[16];
            for (var i = 0; i < 16; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }

        private static void Require(byte[] v, int length, string name)
        {
            if (v == null || v.Length != length) throw new ArgumentException($"{name} must be {length} bytes", name);
        }

        private static void Put(byte[] b, ref int at, byte[] v)
        {
            Buffer.BlockCopy(v, 0, b, at, v.Length);
            at += v.Length;
        }

        private static void PutLittleEndian(byte[] b, ref int at, ulong v, int width)
        {
            for (var i = 0; i < width; i++) b[at + i] = (byte)(v >> (8 * i));
            at += width;
        }

        private static ulong ReadLittleEndian(byte[] b, int at, int width)
        {
            ulong v = 0;
            for (var i = width - 1; i >= 0; i--) v = (v << 8) | b[at + i];
            return v;
        }

        private static byte[] Slice(byte[] b, int at, int length)
        {
            var s = new byte[length];
            Buffer.BlockCopy(b, at, s, 0, length);
            return s;
        }
    }
}
