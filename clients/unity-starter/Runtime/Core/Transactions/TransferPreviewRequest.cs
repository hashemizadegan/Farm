namespace Metafarm.Twin.Core.Transactions
{
    public sealed class TransferPreviewRequest
    {
        public string RepresentationId;
        public string From;
        public string To;
        /// <summary>Base units as a decimal string (u64).</summary>
        public string Amount;
    }
}
