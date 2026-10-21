// Verifies a claim payload against the trusted published tree, exactly as claim-lookup.ts
// verifyClaimPayload: simulation only; same cycle and hasher; the leaf decodes to the published cycle id
// and version and to the payload's recipient and amount; and VerifyClaimLeafProof passes against the
// trusted root and size. Verification only: nothing here builds a tree, holds keys or calls a network.
using System;
using System.Globalization;

namespace Metafarm.Twin.Core.Yield
{
    public static class ClaimPayloadVerification
    {
        public static bool Verify(ClaimPayload claim, PublishedClaimTree trusted)
        {
            if (claim == null || trusted == null) return false;
            if (claim.Scheme != ClaimPayload.SchemeId || !claim.Simulation || !trusted.Simulation) return false;
            if (claim.CycleId != trusted.CycleId || claim.CycleVersion != trusted.CycleVersion) return false;
            if (claim.HasherId != trusted.HasherId || trusted.HasherId != ClaimTreeVerifier.HasherId) return false;
            if (!IsHex(claim.LeafBytes, ClaimLeafCodec.Length * 2) || !IsHex(claim.Recipient, 64)) return false;
            if (claim.Amount == null || claim.Amount.Length == 0 || claim.Amount.Length > 20 || (claim.Amount.Length > 1 && claim.Amount[0] == '0')) return false;
            if (!ulong.TryParse(claim.Amount, NumberStyles.None, CultureInfo.InvariantCulture, out var amount)) return false;

            var bytes = FromHex(claim.LeafBytes);
            ClaimLeafFields leaf;
            byte[] cycleId;
            try
            {
                leaf = ClaimLeafCodec.Decode(bytes);
                cycleId = ClaimLeafCodec.UuidBytes(trusted.CycleId);
            }
            catch (ArgumentException)
            {
                return false;
            }
            if (!SameBytes(leaf.CycleId, cycleId) || leaf.CycleVersion != trusted.CycleVersion) return false;
            if (!SameBytes(leaf.Recipient, FromHex(claim.Recipient)) || leaf.Amount != amount) return false;
            return ClaimTreeVerifier.VerifyClaimLeafProof(bytes, claim.LeafIndex, claim.TreeSize, claim.Path, claim.Root, trusted.Root, trusted.TreeSize);
        }

        private static bool SameBytes(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        private static bool IsHex(string s, int length)
        {
            if (s == null || s.Length != length) return false;
            foreach (var c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        private static byte[] FromHex(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return b;
        }
    }
}
