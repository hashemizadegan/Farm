using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Ownership
{
    /// <summary>Reads ownership from the asset-detail endpoint.</summary>
    public sealed class ApiOwnershipReader : IOwnershipReader
    {
        private readonly ITwinReadApi _api;

        public ApiOwnershipReader(ITwinReadApi api) => _api = api ?? throw new ArgumentNullException(nameof(api));

        public async Task<IReadOnlyList<OwnershipReading>> GetOwnershipAsync(string assetId, CancellationToken cancellationToken = default) =>
            (await _api.GetAssetAsync(assetId, cancellationToken).ConfigureAwait(false)).Ownership;
    }
}
