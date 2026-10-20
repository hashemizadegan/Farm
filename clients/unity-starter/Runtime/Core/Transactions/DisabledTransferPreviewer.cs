using System;
using System.Threading;
using System.Threading.Tasks;

namespace Metafarm.Twin.Core.Transactions
{
    /// <summary>The default: the starter client prepares no transfers.</summary>
    public sealed class DisabledTransferPreviewer : ITransferPreviewer
    {
        public bool Available => false;

        public Task<TransferPreview> PreviewAsync(TransferPreviewRequest request, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("the starter client is read-only: transfer previews are disabled");
    }
}
