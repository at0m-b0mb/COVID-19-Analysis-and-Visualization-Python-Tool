/* Number and date formatting.
 *
 * Everything the reader sees passes through here, so "1.2M" means the same
 * thing in a stat tile, an axis tick and a tooltip.
 */
(function (global) {
  "use strict";

  var groups = new Intl.NumberFormat("en-US");
  var oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var DAY_MS = 86400000;

  function comma(value) {
    if (value == null || !isFinite(value)) return "—";
    return groups.format(Math.round(value));
  }

  /* Compact form for axis ticks and tiles: 1,284 / 12.9K / 4.2M / 1.03B. */
  function compact(value) {
    if (value == null || !isFinite(value)) return "—";
    var sign = value < 0 ? "-" : "";
    var size = Math.abs(value);
    if (size < 1000) return sign + (size % 1 ? oneDecimal.format(size) : String(Math.round(size)));
    if (size < 1e6) return sign + trim(size / 1e3) + "K";
    if (size < 1e9) return sign + trim(size / 1e6) + "M";
    return sign + trim(size / 1e9) + "B";
  }

  function trim(value) {
    // One decimal, but never a trailing ".0" — "12K" reads better than "12.0K".
    var rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return String(rounded);
  }

  function percent(value, decimals) {
    if (value == null || !isFinite(value)) return "—";
    return value.toFixed(decimals == null ? 2 : decimals) + "%";
  }

  function signed(value) {
    if (value == null || !isFinite(value)) return "—";
    return (value > 0 ? "+" : value < 0 ? "−" : "") + compact(Math.abs(value));
  }

  /* --- dates ------------------------------------------------------------ */

  function parseISO(text) {
    var parts = text.split("-");
    return Date.UTC(+parts[0], +parts[1] - 1, +parts[2]);
  }

  function addDays(baseMs, days) {
    return baseMs + days * DAY_MS;
  }

  function toISO(ms) {
    var date = new Date(ms);
    return date.getUTCFullYear() + "-" +
      pad(date.getUTCMonth() + 1) + "-" +
      pad(date.getUTCDate());
  }

  function pad(value) { return value < 10 ? "0" + value : String(value); }

  /* "12 Mar 2021" */
  function longDate(ms) {
    var date = new Date(ms);
    return date.getUTCDate() + " " + MONTHS[date.getUTCMonth()] + " " + date.getUTCFullYear();
  }

  /* "Mar 2021" */
  function monthYear(ms) {
    var date = new Date(ms);
    return MONTHS[date.getUTCMonth()] + " " + date.getUTCFullYear();
  }

  /* "2021-03" -> "Mar '21" for the heatmap's cramped column labels */
  function shortMonthKey(key) {
    var parts = key.split("-");
    return MONTHS[+parts[1] - 1] + " ’" + parts[0].slice(2);
  }

  function monthKeyLabel(key) {
    var parts = key.split("-");
    return MONTHS[+parts[1] - 1] + " " + parts[0];
  }

  global.Fmt = {
    comma: comma,
    compact: compact,
    percent: percent,
    signed: signed,
    parseISO: parseISO,
    addDays: addDays,
    toISO: toISO,
    longDate: longDate,
    monthYear: monthYear,
    shortMonthKey: shortMonthKey,
    monthKeyLabel: monthKeyLabel,
    DAY_MS: DAY_MS,
    MONTHS: MONTHS
  };
})(window);
