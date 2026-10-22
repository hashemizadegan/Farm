// Polling with bounded retry, exponential backoff and cancellation: the default update path for every read.
// Retries: transport failures, 429 and 5xx. Not retried: other 4xx (the request itself is wrong) and malformed
// responses (retrying cannot fix them). Cancellation ends the loop quietly.
using System;
using System.Threading;
using System.Threading.Tasks;
using Metafarm.Twin.Core.Api;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Capabilities
{
    public interface IDelay
    {
        Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken);
    }

    public sealed class TaskDelay : IDelay
    {
        public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken) => Task.Delay(duration, cancellationToken);
    }

    public sealed class PollingOptions
    {
        public TimeSpan Interval { get; set; } = TimeSpan.FromSeconds(30);
        /// <summary>Consecutive failed attempts tolerated before giving up (0 = fail on the first error).</summary>
        public int MaxRetries { get; set; } = 5;
        public TimeSpan BackoffBase { get; set; } = TimeSpan.FromSeconds(1);
        public TimeSpan BackoffMax { get; set; } = TimeSpan.FromMinutes(2);

        /// <summary>The wait before retry <paramref name="attempt"/> (1-based): base * 2^(attempt-1), capped.</summary>
        public TimeSpan Backoff(int attempt)
        {
            if (attempt < 1) throw new ArgumentOutOfRangeException(nameof(attempt));
            var ticks = BackoffBase.Ticks * Math.Pow(2, Math.Min(attempt - 1, 30));
            return ticks >= BackoffMax.Ticks ? BackoffMax : TimeSpan.FromTicks((long)ticks);
        }
    }

    public static class Poller
    {
        public static bool IsRetryable(Exception e) =>
            e switch
            {
                TwinApiException api => api.Status == 429 || api.Status >= 500 || api.Status == 0,
                JsonException => false,
                ArgumentException => false,
                OperationCanceledException => false,
                CapabilityUnavailableException => false,
                _ => true,
            };

        /// <summary>One read, retried per the options; throws the last error when retries are exhausted.</summary>
        public static async Task<T> FetchWithRetryAsync<T>(Func<CancellationToken, Task<T>> fetch, PollingOptions options, IDelay delay, CancellationToken cancellationToken)
        {
            if (fetch == null) throw new ArgumentNullException(nameof(fetch));
            options ??= new PollingOptions();
            delay ??= new TaskDelay();
            for (var attempt = 0; ; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    return await fetch(cancellationToken).ConfigureAwait(false);
                }
                catch (Exception e) when (IsRetryable(e) && attempt < options.MaxRetries && !cancellationToken.IsCancellationRequested)
                {
                    await delay.DelayAsync(options.Backoff(attempt + 1), cancellationToken).ConfigureAwait(false);
                }
            }
        }

        /// <summary>
        /// Calls <paramref name="onValue"/> with each successful read, every Interval, until cancelled. Returns normally on
        /// cancellation; throws when a read fails beyond its retries or with a non-retryable error.
        /// </summary>
        public static async Task RunAsync<T>(Func<CancellationToken, Task<T>> fetch, Action<T> onValue, PollingOptions options, IDelay delay, CancellationToken cancellationToken)
        {
            if (onValue == null) throw new ArgumentNullException(nameof(onValue));
            options ??= new PollingOptions();
            delay ??= new TaskDelay();
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    onValue(await FetchWithRetryAsync(fetch, options, delay, cancellationToken).ConfigureAwait(false));
                    await delay.DelayAsync(options.Interval, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Cancelled by the caller: stop quietly.
            }
        }
    }

    /// <summary>
    /// Keeps a yield cycle list current. Polling is the only mode until the platform has a push endpoint: an Enabled
    /// realtime channel is not used yet (its contract is not final), so behaviour cannot change underneath the client.
    /// </summary>
    public sealed class YieldCycleWatcher
    {
        private readonly IYieldReadApi _api;
        private readonly PollingOptions _options;
        private readonly IDelay _delay;

        public YieldCycleWatcher(IYieldReadApi api, PollingOptions options = null, IDelay delay = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _options = options ?? new PollingOptions();
            _delay = delay ?? new TaskDelay();
        }

        public string Mode => "polling";

        public Task WatchAsync(Action<Models.YieldCycleList> onList, CancellationToken cancellationToken, int limit = 50) =>
            Poller.RunAsync(ct => _api.ListCyclesAsync(limit: limit, cancellationToken: ct), onList, _options, _delay, cancellationToken);
    }
}
