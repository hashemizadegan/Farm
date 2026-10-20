// Ownership as the platform reports it from the chain. The client only displays it: it never
// decides ownership, and never treats "not indexed" as "nobody owns this".
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Ownership
{
    public interface IOwnershipReader
    {
        Task<IReadOnlyList<OwnershipReading>> GetOwnershipAsync(string assetId, CancellationToken cancellationToken = default);
    }
}
