using System.Threading;
using System.Threading.Tasks;

namespace Metafarm.Twin.Core.Auth
{
    /// <summary>For offline samples and tests: nobody is signed in.</summary>
    public sealed class NoTokenSource : ITokenSource
    {
        public Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult<string>(null);
    }
}
