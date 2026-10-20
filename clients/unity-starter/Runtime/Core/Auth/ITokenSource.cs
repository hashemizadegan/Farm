// Supplies the signed-in user's OIDC access token (authorization code with PKCE in the system
// browser). Implemented by the game; the starter ships no implementation that holds a real token,
// and nothing here may embed tokens, API keys or credentialed URLs in a build.
using System.Threading;
using System.Threading.Tasks;

namespace Metafarm.Twin.Core.Auth
{
    public interface ITokenSource
    {
        /// <returns>The access token, or null when nobody is signed in.</returns>
        Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default);
    }
}
