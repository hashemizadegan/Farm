// Lets the client check off-chain data itself instead of trusting the API's word.
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Verification
{
    public interface ICommitmentVerifier
    {
        /// <summary>Whether SHA-256 of the bytes is the committed hash.</summary>
        bool ContentMatches(byte[] content, string contentSha256);

        /// <summary>
        /// Whether the commitment is in the batch the proof names: its leaf is derived from the
        /// commitment's hash and the audit path leads to the root. Says nothing about on-chain
        /// anchoring, which the platform does not do yet.
        /// </summary>
        bool VerifyProof(DataCommitmentProof proof);
    }
}
