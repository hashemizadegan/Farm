namespace Metafarm.Twin.Core.Transport
{
    public sealed class TransportResponse
    {
        public TransportResponse(long status, string body)
        {
            Status = status;
            Body = body;
        }

        /// <summary>HTTP status; 0 when the request never got an answer.</summary>
        public long Status { get; }
        public string Body { get; }
        public bool IsSuccess => Status >= 200 && Status < 300;
    }
}
