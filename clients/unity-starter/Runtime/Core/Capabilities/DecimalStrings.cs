// Exact arithmetic on the platform's decimal-string amounts (u64 settlement units, u128 weights): never through
// float or double, which lose digits above 2^53.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace Metafarm.Twin.Core.Capabilities
{
    public static class DecimalStrings
    {
        private static readonly Regex Canonical = new Regex("^(0|[1-9][0-9]{0,77})$", RegexOptions.CultureInvariant);

        /// <summary>A non-negative integer in canonical form (no sign, no leading zeros, no exponent, no separators).</summary>
        public static bool IsValid(string value) => value != null && Canonical.IsMatch(value);

        public static BigInteger Parse(string value)
        {
            if (!IsValid(value)) throw new FormatException("not a canonical non-negative decimal integer");
            return BigInteger.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture);
        }

        public static string Sum(IEnumerable<string> values)
        {
            if (values == null) throw new ArgumentNullException(nameof(values));
            var total = BigInteger.Zero;
            foreach (var v in values) total += Parse(v);
            return total.ToString(CultureInfo.InvariantCulture);
        }

        public static int Compare(string a, string b) => Parse(a).CompareTo(Parse(b));
    }
}
