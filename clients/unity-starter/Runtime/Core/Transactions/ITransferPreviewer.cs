// Transaction preparation. The starter is read-only: its only implementation is disabled. A real
// previewer would call POST /twin/transfers/preview (which itself never submits anything); there is
// deliberately no interface here for signing or submitting transactions.
using System.Threading;
using System.Threading.Tasks;

namespace Metafarm.Twin.Core.Transactions
{
    public interface ITransferPreviewer
    {
        bool Available { get; }
        Task<TransferPreview> PreviewAsync(TransferPreviewRequest request, CancellationToken cancellationToken = default);
    }
}
