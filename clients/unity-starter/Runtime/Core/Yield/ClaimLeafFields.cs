// The fields of a canonical claim leaf (plan rev. 4 section 6.2); see ClaimLeafCodec for the byte layout.
namespace Metafarm.Twin.Core.Yield
{
    public sealed class ClaimLeafFields
    {
        public byte NetworkId { get; set; }
        public byte[] ClusterIdentity { get; set; }
        public byte[] CycleId { get; set; }
        public uint CycleVersion { get; set; }
        public uint Epoch { get; set; }
        public byte[] EconomicAssetId { get; set; }
        public byte[] Recipient { get; set; }
        public byte[] PayoutMint { get; set; }
        public ulong Amount { get; set; }
        public ushort FormulaVersion { get; set; }
        public ushort LeafLayoutVersion { get; set; }
        public uint LeafIndex { get; set; }
    }
}
