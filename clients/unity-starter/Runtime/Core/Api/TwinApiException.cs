using System;
using Metafarm.Twin.Core.Models;

namespace Metafarm.Twin.Core.Api
{
    public sealed class TwinApiException : Exception
    {
        public TwinApiException(long status, ApiError error, string fallbackMessage)
            : base(error?.Message ?? fallbackMessage)
        {
            Status = status;
            Error = error;
        }

        public long Status { get; }
        /// <summary>The API's error body (error code, message, request id), when it sent one.</summary>
        public ApiError Error { get; }
    }
}
