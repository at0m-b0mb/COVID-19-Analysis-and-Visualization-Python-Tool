/* Dashboard wiring: state, controls, and the render pass for each section.
 *
 * One piece of state drives the whole page. Changing a filter re-renders
 * everything below it, so no two numbers on screen can disagree about which
 * slice of the data they describe.
 */
(function (global) {
  "use strict";

  var DATA = global.__COVID__ && global.__COVID__.core;
  var Fmt = global.Fmt;
  var Charts = global.Charts;

  if (!DATA) {
    document.body.innerHTML =
      '<p style="padding:40px;font:16px system-ui">Could not load <code>data/core.js</code>. ' +
      'Run <code>python3 tools/build_web_data.py</code> from the project root.</p>';
    return;
  }

  var META = DATA.meta;
  var START_MS = Fmt.parseISO(META.start);

  /* Measure identity is fixed page-wide: cases are always slot 1, deaths
     always slot 2, and the derived ratio always slot 3. */
  var MEASURES = {
    cases:  { key: "cases",  label: "cases",  one: "case",  noun: "Reported cases",  daily: "New cases",  color: "--series-1" },
    deaths: { key: "deaths", label: "deaths", one: "death", noun: "Reported deaths", daily: "New deaths", color: "--series-2" }
  };
  var CFR_COLOR = "--series-3";
  var SERIES_SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];
  var MAX_COMPARE = SERIES_SLOTS.length;

  /* Documented WHO and public-health milestones that fall inside this file's
     window. Dates only — the chart shows what was reported, and these say what
     was happening when it was reported. */
  var MILESTONES = [
    ["2020-01-30", "WHO declares a Public Health Emergency of International Concern"],
    ["2020-03-11", "WHO characterises COVID-19 as a pandemic"],
    ["2020-12-08", "First COVID-19 vaccination outside a trial (United Kingdom)"],
    ["2020-12-18", "Alpha designated a variant of concern"],
    ["2021-05-11", "Delta designated a variant of concern"],
    ["2021-11-26", "Omicron designated a variant of concern"],
    ["2022-12-07", "China begins unwinding its zero-COVID restrictions"]
  ];

  var state = {
    range: "all",
    metric: "cases",
    scale: "linear",
    country: "IN",
    compare: ["US", "IN", "BR", "GB"],
    align: false,
    milestones: true,
    sort: { key: "cases", dir: "desc" },
    tableQuery: "",
    seriesReady: false
  };

  var byCode = {};
  var byName = {};
  DATA.countries.forEach(function (item) {
    byCode[item.c] = item;
    byName[item.n.toLowerCase()] = item.c;
  });

  var cache = {};

  /* ---------------------------------------------------------------------- *
   * Derived data
   * ---------------------------------------------------------------------- */

  function periodRange() {
    if (state.range === "all") return [0, META.days - 1];
    return META.yearRanges[META.years.indexOf(state.range)];
  }

  function periodLabel() {
    if (state.range !== "all") return state.range;
    return Fmt.monthYear(START_MS) + " – " + Fmt.monthYear(Fmt.parseISO(META.end));
  }

  function periodStartMs() {
    return START_MS + periodRange()[0] * Fmt.DAY_MS;
  }

  function slice(values) {
    var span = periodRange();
    return values.slice(span[0], span[1] + 1);
  }

  function measure() { return MEASURES[state.metric]; }

  /* Totals for the current period. Whole-year presets are precomputed, so
     this is exact for every preset without touching the daily bundle. */
  function totalsFor(country) {
    if (state.range === "all") return { cases: country.tc, deaths: country.td };
    var index = META.years.indexOf(state.range);
    return { cases: country.yc[index], deaths: country.yd[index] };
  }

  function metricTotal(country) { return totalsFor(country)[state.metric]; }

  function rollingMean(values, window) {
    var out = new Array(values.length);
    var total = 0;
    for (var index = 0; index < values.length; index++) {
      total += values[index];
      if (index >= window) total -= values[index - window];
      out[index] = index >= window - 1 ? total / window : null;
    }
    return out;
  }

  function cumulative(values) {
    var out = new Array(values.length);
    var total = 0;
    for (var index = 0; index < values.length; index++) {
      total += values[index];
      out[index] = total;
    }
    return out;
  }

  /* Everything derived from a country's daily numbers, computed once. */
  function countrySeries(code) {
    if (cache[code]) return cache[code];
    var raw = global.__COVID__.series && global.__COVID__.series[code];
    if (!raw) return null;
    var record = {
      cases: raw[0],
      deaths: raw[1],
      casesAvg: rollingMean(raw[0], 7),
      deathsAvg: rollingMean(raw[1], 7),
      cumCases: cumulative(raw[0]),
      cumDeaths: cumulative(raw[1])
    };
    record.cfr = record.cumCases.map(function (cases, index) {
      return cases > 500 ? (record.cumDeaths[index] / cases) * 100 : null;
    });
    cache[code] = record;
    return record;
  }

  /* Milestones that fall inside the selected period, numbered in order. */
  function milestonesInPeriod() {
    if (!state.milestones) return [];
    var span = periodRange();
    var out = [];
    MILESTONES.forEach(function (entry) {
      var offset = Math.round((Fmt.parseISO(entry[0]) - START_MS) / Fmt.DAY_MS);
      if (offset < span[0] || offset > span[1]) return;
      out.push({
        index: offset - span[0],
        n: out.length + 1,
        date: entry[0],
        label: Fmt.longDate(Fmt.parseISO(entry[0])) + " — " + entry[1],
        text: entry[1]
      });
    });
    return out;
  }

  /* Week-on-week change in the trailing average, as a percentage. This is the
     growth-rate view the Python analytics script computes, made continuous. */
  function weeklyChange(average) {
    return average.map(function (value, index) {
      var previous = index >= 7 ? average[index - 7] : null;
      if (value == null || previous == null || previous < 1) return null;
      return ((value - previous) / previous) * 100;
    });
  }

  /* Realign a series so day 0 is the day it crossed `threshold` cumulative
     cases. Countries that never got there drop out. */
  function alignedFrom(record, key, threshold) {
    var cumulativeCases = record.cumCases;
    var start = -1;
    for (var index = 0; index < cumulativeCases.length; index++) {
      if (cumulativeCases[index] >= threshold) { start = index; break; }
    }
    if (start < 0) return null;
    return record[key].slice(start);
  }

  function peakOf(values) {
    var index = -1;
    var best = 0;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > best) { best = values[i]; index = i; }
    }
    return { index: index, value: best };
  }

  /* ---------------------------------------------------------------------- *
   * Small DOM helpers
   * ---------------------------------------------------------------------- */

  function make(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  function fill(node, children) {
    node.innerHTML = "";
    children.forEach(function (child) { node.appendChild(child); });
  }

  function statTile(config) {
    var tile = make("div", "stat");
    tile.appendChild(make("p", "stat-label", config.label));
    tile.appendChild(make("p", "stat-value", config.value));
    if (config.sub) tile.appendChild(make("p", "stat-sub", config.sub));
    if (config.spark) tile.appendChild(config.spark);
    return tile;
  }

  function segmented(container, options, current, onPick) {
    container.innerHTML = "";
    options.forEach(function (option) {
      var button = make("button", null, option.label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(option.value === current));
      button.addEventListener("click", function () { onPick(option.value); });
      container.appendChild(button);
    });
  }

  /* ---------------------------------------------------------------------- *
   * Sections
   * ---------------------------------------------------------------------- */

  function renderHero() {
    document.querySelectorAll("[data-bind]").forEach(function (node) {
      var key = node.getAttribute("data-bind");
      if (key === "meta.start") node.textContent = Fmt.longDate(START_MS);
      else if (key === "meta.end") node.textContent = Fmt.longDate(Fmt.parseISO(META.end));
      else if (key === "meta.countries") node.textContent = Fmt.comma(META.countries);
      else if (key === "meta.generated") node.textContent = Fmt.longDate(Fmt.parseISO(META.generated));
      else if (key === "meta.corrections") node.textContent = Fmt.comma(META.corrections);
      else if (key === "regions.otherCases") {
        var other = DATA.regions.filter(function (r) { return r.k === "Other"; })[0];
        node.textContent = Fmt.comma(other ? other.tc : 0);
      }
    });
    document.getElementById("hero-value").textContent = Fmt.comma(META.totalCases);
  }

  function renderKpis() {
    var casesTotal = 0;
    var deathsTotal = 0;
    DATA.countries.forEach(function (country) {
      var totals = totalsFor(country);
      casesTotal += totals.cases;
      deathsTotal += totals.deaths;
    });

    var dailyCases = slice(DATA.global.cases);
    var dailyDeaths = slice(DATA.global.deaths);
    var casesPeak = peakOf(dailyCases);
    var deathsPeak = peakOf(dailyDeaths);
    var offset = periodRange()[0];
    var days = dailyCases.length;

    var reporting = DATA.countries.filter(function (country) {
      return totalsFor(country).cases > 0;
    }).length;

    fill(document.getElementById("kpi-row"), [
      statTile({
        label: "Reported cases · " + periodLabel(),
        value: Fmt.compact(casesTotal),
        sub: Fmt.comma(casesTotal) + " over " + Fmt.comma(days) + " days",
        spark: sparkTile(dailyCases, "--series-1")
      }),
      statTile({
        label: "Reported deaths · " + periodLabel(),
        value: Fmt.compact(deathsTotal),
        sub: Fmt.comma(deathsTotal) + " over the same days",
        spark: sparkTile(dailyDeaths, "--series-2")
      }),
      statTile({
        label: "Case fatality rate",
        value: casesTotal ? Fmt.percent((deathsTotal / casesTotal) * 100) : "—",
        sub: "Reported deaths per reported case"
      }),
      statTile({
        label: "Busiest day",
        value: Fmt.compact(casesPeak.value),
        sub: casesPeak.index < 0 ? "—" : "cases on " + Fmt.longDate(START_MS + (offset + casesPeak.index) * Fmt.DAY_MS)
      }),
      statTile({
        label: "Deadliest day",
        value: Fmt.compact(deathsPeak.value),
        sub: deathsPeak.index < 0 ? "—" : "deaths on " + Fmt.longDate(START_MS + (offset + deathsPeak.index) * Fmt.DAY_MS)
      }),
      statTile({
        label: "Countries reporting",
        value: Fmt.comma(reporting),
        sub: "of " + Fmt.comma(META.countries) + " countries and areas in the file"
      })
    ]);
  }

  function sparkTile(values, colorToken) {
    var wrapper = make("div", "stat-spark");
    wrapper.appendChild(Charts.sparkline(values, Charts.token(colorToken), 180, 30));
    return wrapper;
  }

  function renderCurve() {
    var unit = measure();
    var values = slice(DATA.global[unit.key]);
    var average = slice(DATA.global[unit.key === "cases" ? "casesAvg" : "deathsAvg"]);

    document.getElementById("curve-sub").textContent =
      "Every " + unit.one + " the WHO recorded worldwide, " + periodLabel() +
      ". Switch the measure or the scale above; a logarithmic axis makes the early months legible next to the peaks.";
    document.getElementById("curve-title").textContent =
      unit.noun + " per day worldwide · " + periodLabel() +
      (state.scale === "log" ? " · log scale" : "");

    var marks = milestonesInPeriod();
    Charts.timeSeries(document.getElementById("chart-curve"), {
      startMs: periodStartMs(),
      values: values,
      average: average,
      label: unit.daily,
      color: unit.color,
      scale: state.scale,
      height: 340,
      annotations: marks
    });

    renderMilestoneKey(marks);
    renderCallouts(values, average, unit);
  }

  function renderMilestoneKey(marks) {
    var host = document.getElementById("milestone-key");
    host.innerHTML = "";
    if (!marks.length) {
      host.appendChild(make("p", "chart-note",
        state.milestones ? "No milestones fall inside this period."
                         : "Milestones are hidden."));
      return;
    }
    marks.forEach(function (mark) {
      var item = make("li", "milestone");
      item.appendChild(make("span", "milestone-n", String(mark.n)));
      var body = make("span", "milestone-body");
      body.appendChild(make("span", "milestone-date",
        Fmt.longDate(Fmt.parseISO(mark.date))));
      body.appendChild(document.createTextNode(mark.text));
      item.appendChild(body);
      host.appendChild(item);
    });
  }

  /* Callouts are read out of the selected slice, never written by hand. */
  function renderCallouts(values, average, unit) {
    var offset = periodRange()[0];
    var total = values.reduce(function (sum, value) { return sum + value; }, 0);
    var items = [];

    var peak = peakOf(average.map(function (value) { return value == null ? 0 : value; }));
    if (peak.index >= 0) {
      items.push({
        when: "Steepest week",
        html: ["At its worst the world was reporting ", strong(Fmt.comma(Math.round(peak.value))),
               " " + unit.label + " a day, in the week to ",
               strong(Fmt.longDate(START_MS + (offset + peak.index) * Fmt.DAY_MS)), "."]
      });
    }

    var running = 0;
    var halfway = -1;
    for (var index = 0; index < values.length; index++) {
      running += values[index];
      if (halfway < 0 && running >= total / 2) { halfway = index; break; }
    }
    if (halfway >= 0) {
      items.push({
        when: "Halfway point",
        html: ["Half of all " + unit.label + " in this period had been reported by ",
               strong(Fmt.longDate(START_MS + (offset + halfway) * Fmt.DAY_MS)),
               " — day " + Fmt.comma(halfway + 1) + " of " + Fmt.comma(values.length) + "."]
      });
    }

    // How concentrated the period was: the share carried by its worst 90 days.
    var sorted = values.slice().sort(function (a, b) { return b - a; });
    var window = Math.min(90, sorted.length);
    var top = sorted.slice(0, window).reduce(function (sum, value) { return sum + value; }, 0);
    if (total > 0) {
      items.push({
        when: "Concentration",
        html: [strong(Math.round((top / total) * 100) + "%"),
               " of the period's " + unit.label + " landed on its busiest " + window + " days."]
      });
    }

    var quiet = 0;
    values.forEach(function (value) { if (value === 0) quiet++; });
    items.push({
      when: "Reporting gaps",
      html: [strong(Fmt.comma(quiet)), " day" + (quiet === 1 ? "" : "s") +
             " in this period recorded no " + unit.label + " anywhere in the world — " +
             "almost always a reporting pause rather than a true zero."]
    });

    var host = document.getElementById("curve-callouts");
    host.innerHTML = "";
    items.forEach(function (item) {
      var card = make("div", "callout");
      card.appendChild(make("p", "callout-when", item.when));
      var body = make("p", "callout-what");
      item.html.forEach(function (part) {
        body.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
      });
      card.appendChild(body);
      host.appendChild(card);
    });
  }

  function strong(value) { return make("strong", null, value); }

  function renderMap() {
    var unit = measure();
    var values = {};
    DATA.countries.forEach(function (country) {
      values[country.c] = metricTotal(country);
    });
    var names = {};
    DATA.countries.forEach(function (country) { names[country.c] = country.n; });

    document.getElementById("map-title").textContent =
      unit.noun + " by country · " + periodLabel();

    Charts.choropleth(document.getElementById("chart-map"), {
      viewBox: DATA.map.viewBox,
      paths: DATA.map.paths,
      values: values,
      names: names,
      measure: unit.noun.toLowerCase(),
      activeKey: state.country,
      onBreaks: renderMapLegend,
      rowsFor: function (code) {
        var country = byCode[code];
        var totals = totalsFor(country);
        return [
          { color: Charts.token("--series-1"), label: "Cases", value: Fmt.comma(totals.cases) },
          { color: Charts.token("--series-2"), label: "Deaths", value: Fmt.comma(totals.deaths) },
          { color: null, label: "WHO region", value: regionName(country.r) }
        ];
      },
      onSelect: selectCountry
    });

    document.getElementById("map-foot").textContent =
      Object.keys(DATA.map.paths).length + " countries are drawn here. " +
      DATA.map.missing.length + " small states and territories — Singapore, Malta, " +
      "Mauritius and the island territories among them — have no outline at this map's " +
      "resolution; they are all present in the table below.";
  }

  function renderMapLegend(breaks) {
    var host = document.getElementById("map-legend");
    host.innerHTML = "";
    host.appendChild(make("span", null, "under " + Fmt.compact(breaks[0])));
    var scale = make("div", "map-legend-scale");
    for (var index = 0; index < 7; index++) {
      var step = make("span", "map-legend-step");
      step.style.background = Charts.rampColor(index);
      step.title = (index === 0 ? "under " + Fmt.compact(breaks[0])
        : index >= breaks.length ? Fmt.compact(breaks[breaks.length - 1]) + " and above"
        : Fmt.compact(breaks[index - 1]) + " – " + Fmt.compact(breaks[index]));
      scale.appendChild(step);
    }
    host.appendChild(scale);
    host.appendChild(make("span", null, Fmt.compact(breaks[breaks.length - 1]) + "+"));
  }

  function renderRank() {
    var unit = measure();
    var top = DATA.countries.slice().sort(function (a, b) {
      return metricTotal(b) - metricTotal(a);
    }).slice(0, 15);

    document.getElementById("rank-title").textContent =
      "Top 15 by " + unit.label + " · " + periodLabel();

    Charts.barsH(document.getElementById("chart-rank"), {
      items: top.map(function (country) {
        var totals = totalsFor(country);
        return {
          key: country.c,
          label: country.n.length > 20 ? country.n.slice(0, 19) + "…" : country.n,
          value: metricTotal(country),
          rows: [
            { color: Charts.token("--series-1"), label: "Cases", value: Fmt.comma(totals.cases) },
            { color: Charts.token("--series-2"), label: "Deaths", value: Fmt.comma(totals.deaths) }
          ]
        };
      }),
      color: unit.color,
      rowHeight: 28,
      onSelect: selectCountry,
      ariaLabel: "The fifteen countries with the most reported " + unit.label + " in " + periodLabel() + "."
    });
  }

  function regionName(key) {
    var match = DATA.regions.filter(function (region) { return region.k === key; })[0];
    return match ? match.n : key;
  }

  function regionColor(key) {
    var index = DATA.regions.map(function (region) { return region.k; }).indexOf(key);
    return "--series-" + Math.min(8, index + 1);
  }

  function renderRegions() {
    var unit = measure();
    var span = periodRange();
    var firstWeek = Math.floor(span[0] / 7);
    var lastWeek = Math.floor(span[1] / 7);

    var series = DATA.regions.filter(function (region) {
      return region.k !== "Other";
    }).map(function (region) {
      return {
        name: region.n,
        color: regionColor(region.k),
        key: region.k,
        values: region[unit.key].slice(firstWeek, lastWeek + 1),
        visible: hiddenRegions[region.k] !== true
      };
    });

    document.getElementById("regions-title").textContent =
      "Weekly reported " + unit.label + " by WHO region · " + periodLabel();

    var legend = document.getElementById("regions-legend");
    legend.innerHTML = "";
    series.forEach(function (item) {
      var button = make("button", "legend-item");
      button.type = "button";
      button.setAttribute("aria-pressed", String(item.visible));
      var key = make("span", "legend-key legend-key--block");
      key.style.background = Charts.token(item.color);
      button.appendChild(key);
      button.appendChild(document.createTextNode(item.name));
      button.addEventListener("click", function () {
        hiddenRegions[item.key] = item.visible;
        renderRegions();
      });
      legend.appendChild(button);
    });

    Charts.stackedArea(document.getElementById("chart-regions"), {
      startMs: START_MS + firstWeek * 7 * Fmt.DAY_MS,
      step: 7,
      series: series,
      height: 340,
      labelAt: function (index) {
        var weekStart = START_MS + (firstWeek + index) * 7 * Fmt.DAY_MS;
        return "Week of " + Fmt.longDate(weekStart);
      },
      ariaLabel: "Weekly reported " + unit.label + " stacked by WHO region, " + periodLabel() + "."
    });

    var cards = document.getElementById("region-cards");
    cards.innerHTML = "";
    var grandTotal = DATA.regions.reduce(function (sum, region) {
      return sum + regionTotal(region);
    }, 0);
    DATA.regions.filter(function (region) { return region.k !== "Other"; })
      .slice().sort(function (a, b) { return regionTotal(b) - regionTotal(a); })
      .forEach(function (region) {
        var card = make("div", "region-card");
        var name = make("div", "region-card-name");
        var key = make("span", "legend-key legend-key--block");
        key.style.background = Charts.token(regionColor(region.k));
        name.appendChild(key);
        name.appendChild(document.createTextNode(region.n));
        card.appendChild(name);
        card.appendChild(make("p", "region-card-value", Fmt.compact(regionTotal(region))));
        card.appendChild(make("p", "region-card-sub",
          Math.round((regionTotal(region) / grandTotal) * 100) + "% of world " + unit.label));
        cards.appendChild(card);
      });
  }

  var hiddenRegions = {};

  function regionTotal(region) {
    var unit = measure();
    var span = periodRange();
    var firstWeek = Math.floor(span[0] / 7);
    var lastWeek = Math.floor(span[1] / 7);
    return region[unit.key].slice(firstWeek, lastWeek + 1)
      .reduce(function (sum, value) { return sum + value; }, 0);
  }

  function renderWaves() {
    var host = document.getElementById("chart-waves");
    Charts.heatmap(host, {
      columns: DATA.waves.months,
      rows: DATA.waves.rows.map(function (row) {
        return { label: row.n, values: row.v, raw: row.a, key: row.c };
      })
    });

    var legend = document.getElementById("waves-legend");
    legend.innerHTML = "";
    legend.appendChild(make("span", null, "quiet"));
    var scale = make("div", "map-legend-scale");
    for (var index = 0; index < 7; index++) {
      var step = make("span", "map-legend-step");
      step.style.background = Charts.rampColor(index);
      scale.appendChild(step);
    }
    legend.appendChild(scale);
    legend.appendChild(make("span", null, "its worst month"));
  }

  /* ---------------------------------------------------------------------- *
   * Country panel
   * ---------------------------------------------------------------------- */

  function selectCountry(code) {
    if (!byCode[code]) return;
    state.country = code;
    var input = document.getElementById("country-select");
    input.value = byCode[code].n;
    renderCountry();
    markActiveRow();
    writeState();
    var mapHost = document.getElementById("chart-map");
    if (mapHost.__setActive) mapHost.__setActive(code);
    document.getElementById("country").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderCountry() {
    var panel = document.getElementById("country-panel");
    var record = countrySeries(state.country);
    panel.setAttribute("aria-busy", String(!record));
    if (!record) return;

    var country = byCode[state.country];
    var unit = measure();
    var span = periodRange();
    var startMs = periodStartMs();

    var cases = slice(record.cases);
    var deaths = slice(record.deaths);
    var casesAvg = slice(record.casesAvg);
    var deathsAvg = slice(record.deathsAvg);
    var totals = totalsFor(country);

    var casesPeak = peakOf(cases);
    var worldTotal = DATA.countries.reduce(function (sum, item) {
      return sum + totalsFor(item)[state.metric];
    }, 0);

    fill(document.getElementById("country-kpis"), [
      statTile({
        label: country.n + " · reported cases",
        value: Fmt.compact(totals.cases),
        sub: Fmt.comma(totals.cases) + " in " + periodLabel()
      }),
      statTile({
        label: "Reported deaths",
        value: Fmt.compact(totals.deaths),
        sub: totals.cases ? Fmt.percent((totals.deaths / totals.cases) * 100) + " of its reported cases" : "—"
      }),
      statTile({
        label: "Busiest day",
        value: Fmt.compact(casesPeak.value),
        sub: casesPeak.index < 0 ? "no cases reported"
          : "cases on " + Fmt.longDate(START_MS + (span[0] + casesPeak.index) * Fmt.DAY_MS)
      }),
      statTile({
        label: "Share of world " + unit.label,
        value: worldTotal ? Fmt.percent((totals[state.metric] / worldTotal) * 100) : "—",
        sub: regionName(country.r) + " region"
      })
    ]);

    document.getElementById("cd-cases-title").textContent =
      "New cases per day · " + country.n;
    Charts.timeSeries(document.getElementById("chart-cd-cases"), {
      startMs: startMs, values: cases, average: casesAvg,
      label: "New cases", color: "--series-1", scale: state.scale, height: 260
    });

    document.getElementById("cd-deaths-title").textContent =
      "New deaths per day · " + country.n;
    Charts.timeSeries(document.getElementById("chart-cd-deaths"), {
      startMs: startMs, values: deaths, average: deathsAvg,
      label: "New deaths", color: "--series-2", scale: state.scale, height: 260
    });

    var cumulativeValues = slice(record[unit.key === "cases" ? "cumCases" : "cumDeaths"]);
    document.getElementById("cd-cum-title").textContent =
      "Cumulative " + unit.label + " · " + country.n;
    Charts.timeSeries(document.getElementById("chart-cd-cum"), {
      startMs: startMs, values: cumulativeValues,
      label: "Total " + unit.label, color: unit.color,
      scale: state.scale, height: 260, markPeak: false
    });

    var cfr = slice(record.cfr);
    document.getElementById("cd-cfr-title").textContent =
      "Case fatality rate · " + country.n;
    Charts.timeSeries(document.getElementById("chart-cd-cfr"), {
      startMs: startMs, values: cfr.map(function (value) { return value == null ? 0 : value; }),
      label: "CFR (%)", color: CFR_COLOR, height: 260, markPeak: false,
      formatValue: function (value) { return value.toFixed(1) + "%"; },
      formatTooltip: function (value) { return value.toFixed(2) + "%"; },
      note: "Cumulative deaths ÷ cumulative cases, from the first 500 cases."
    });

    document.getElementById("cd-growth-title").textContent =
      "Week-on-week change in " + unit.label + " · " + country.n;
    Charts.divergingArea(document.getElementById("chart-cd-growth"), {
      startMs: startMs,
      values: slice(weeklyChange(record[unit.key === "cases" ? "casesAvg" : "deathsAvg"])),
      label: "Change vs the week before",
      // Growth is the "bad" direction here, so it takes the warm arm of the
      // diverging pair and decline takes the cool one.
      upColor: "--series-8", downColor: "--series-1",
      clamp: 200, height: 260,
      note: "Capped at ±200% so one restated week cannot flatten the rest."
    });
  }

  /* ---------------------------------------------------------------------- *
   * Compare
   * ---------------------------------------------------------------------- */

  function renderCompare() {
    var unit = measure();
    var chips = document.getElementById("compare-chips");
    chips.innerHTML = "";

    state.compare.forEach(function (code, position) {
      var country = byCode[code];
      if (!country) return;
      var chip = make("span", "chip");
      var key = make("span", "chip-key");
      key.style.background = Charts.token(SERIES_SLOTS[position]);
      chip.appendChild(key);
      chip.appendChild(document.createTextNode(country.n));
      var remove = make("button", null, "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + country.n);
      remove.addEventListener("click", function () {
        state.compare = state.compare.filter(function (item) { return item !== code; });
        renderCompare();
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    });

    if (!state.compare.length) {
      chips.appendChild(make("span", "chip", "No countries selected"));
    }

    var legend = document.getElementById("compare-legend");
    legend.innerHTML = "";

    var averageKey = unit.key === "cases" ? "casesAvg" : "deathsAvg";
    var series = state.compare.map(function (code, position) {
      var record = countrySeries(code);
      if (!record) return null;
      // Aligned mode ignores the period filter on purpose: an outbreak's own
      // clock starts when it starts, and clipping it to a calendar year would
      // silently compare a country's week 3 with another's week 60.
      var values = state.align
        ? alignedFrom(record, averageKey, 100)
        : slice(record[averageKey]);
      if (!values) return null;
      var item = {
        name: byCode[code].n,
        color: SERIES_SLOTS[position],
        values: values
      };
      var entry = make("span", "legend-item");
      var key = make("span", "legend-key");
      key.style.background = Charts.token(item.color);
      entry.appendChild(key);
      entry.appendChild(document.createTextNode(item.name));
      legend.appendChild(entry);
      return item;
    }).filter(Boolean);

    document.getElementById("compare-title").textContent =
      "7-day average of new " + unit.label +
      (state.align ? " · aligned on each country's 100th case"
                   : " · " + periodLabel()) +
      (state.scale === "log" ? " · log scale" : "");

    document.getElementById("compare-note").textContent = state.align
      ? "Day 0 is the day each country passed 100 cumulative cases, so the waves line up by outbreak age rather than by date. The period filter does not apply in this view."
      : "Trailing 7-day average on shared calendar dates.";

    Charts.multiLine(document.getElementById("chart-compare"), {
      startMs: periodStartMs(),
      series: series,
      scale: state.scale,
      height: 380,
      xMode: state.align ? "index" : "time",
      xLabel: "days since the 100th case",
      ariaSuffix: "Trailing 7-day average of new " + unit.label +
        (state.align ? ", aligned on each country's 100th case." : " in " + periodLabel() + ".")
    });
  }

  /* ---------------------------------------------------------------------- *
   * Table — the readable twin of every chart above
   * ---------------------------------------------------------------------- */

  function tableRows() {
    var query = state.tableQuery.trim().toLowerCase();
    var rows = DATA.countries.map(function (country) {
      var totals = totalsFor(country);
      var record = state.seriesReady ? countrySeries(country.c) : null;
      var peak = record ? peakOf(slice(record[state.metric])) : null;
      return {
        code: country.c,
        name: country.n,
        region: regionName(country.r),
        cases: totals.cases,
        deaths: totals.deaths,
        cfr: totals.cases ? (totals.deaths / totals.cases) * 100 : null,
        peakValue: peak ? peak.value : null,
        peakIndex: peak ? peak.index : null,
        spark: record ? slice(record[state.metric]) : null
      };
    });

    if (query) {
      rows = rows.filter(function (row) {
        return row.name.toLowerCase().indexOf(query) >= 0 ||
               row.region.toLowerCase().indexOf(query) >= 0;
      });
    }

    var key = state.sort.key;
    var direction = state.sort.dir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      if (key === "name" || key === "region") {
        return a[key].localeCompare(b[key]) * direction;
      }
      var left = key === "rank" ? b.cases : a[key === "peak" ? "peakValue" : key];
      var right = key === "rank" ? a.cases : b[key === "peak" ? "peakValue" : key];
      if (left == null) return 1;
      if (right == null) return -1;
      return (left - right) * (key === "rank" ? 1 : direction);
    });
    return rows;
  }

  var sparkObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      sparkObserver.unobserve(entry.target);
      if (entry.target.__draw) entry.target.__draw();
    });
  }, { root: null, rootMargin: "200px" });

  function renderTable() {
    var body = document.getElementById("table-body");
    var rows = tableRows();
    sparkObserver.disconnect();
    body.innerHTML = "";

    if (!rows.length) {
      var empty = make("tr");
      var cell = make("td", "table-empty", "No country matches that filter.");
      cell.colSpan = 8;
      empty.appendChild(cell);
      body.appendChild(empty);
    }

    var color = Charts.token(measure().color);
    rows.forEach(function (row, position) {
      var tr = make("tr");
      tr.dataset.code = row.code;
      if (row.code === state.country) tr.className = "is-active";

      tr.appendChild(make("td", "col-rank", String(position + 1)));
      tr.appendChild(make("td", "td-name", row.name));
      tr.appendChild(make("td", "td-region col-region", row.region));
      tr.appendChild(make("td", "num", Fmt.comma(row.cases)));
      tr.appendChild(make("td", "num", Fmt.comma(row.deaths)));
      tr.appendChild(make("td", "num", row.cfr == null ? "—" : Fmt.percent(row.cfr)));

      var peakCell = make("td", "num col-peak",
        row.peakValue == null ? "—" : Fmt.compact(row.peakValue));
      if (row.peakIndex != null && row.peakIndex >= 0) {
        peakCell.title = Fmt.longDate(START_MS + (periodRange()[0] + row.peakIndex) * Fmt.DAY_MS);
      }
      tr.appendChild(peakCell);

      var sparkCell = make("td", "col-spark");
      // 237 sparklines at once is a lot of SVG for one paint; draw each only
      // when its row is actually scrolled into view.
      if (row.spark) {
        sparkCell.__draw = function () {
          sparkCell.appendChild(Charts.sparkline(row.spark, color, 116, 26));
        };
        sparkObserver.observe(sparkCell);
      }
      tr.appendChild(sparkCell);

      tr.addEventListener("click", function () { selectCountry(row.code); });
      body.appendChild(tr);
    });

    document.getElementById("table-foot").textContent =
      "Showing " + Fmt.comma(rows.length) + " of " + Fmt.comma(DATA.countries.length) +
      " countries and areas · " + periodLabel() +
      (state.seriesReady ? "" : " · peak day and curves load in a moment");

    document.querySelectorAll("#data-table thead th").forEach(function (th) {
      var button = th.querySelector("button");
      if (!button) return;
      if (button.dataset.sort === state.sort.key) {
        th.setAttribute("aria-sort", state.sort.dir === "asc" ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });
  }

  function markActiveRow() {
    document.querySelectorAll("#table-body tr").forEach(function (tr) {
      tr.classList.toggle("is-active", tr.dataset.code === state.country);
    });
  }

  function downloadCsv() {
    var rows = tableRows();
    var head = ["rank", "code", "country", "who_region", "cases", "deaths", "cfr_percent", "peak_day_value"];
    var lines = [head.join(",")];
    rows.forEach(function (row, position) {
      lines.push([
        position + 1,
        row.code,
        '"' + row.name.replace(/"/g, '""') + '"',
        '"' + row.region + '"',
        row.cases,
        row.deaths,
        row.cfr == null ? "" : row.cfr.toFixed(4),
        row.peakValue == null ? "" : row.peakValue
      ].join(","));
    });

    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "covid-" + state.metric + "-" + state.range + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------------------- *
   * Render pass
   * ---------------------------------------------------------------------- */

  function renderAll() {
    renderKpis();
    renderCurve();
    renderMap();
    renderRank();
    renderRegions();
    renderCountry();
    renderCompare();
    renderTable();
    writeState();
  }

  /* ---------------------------------------------------------------------- *
   * Controls
   * ---------------------------------------------------------------------- */

  function buildControls() {
    var ranges = [{ label: "All", value: "all" }].concat(META.years.map(function (year) {
      return { label: year, value: year };
    }));

    segmented(document.getElementById("range-control"), ranges, state.range, function (value) {
      state.range = value;
      buildControls();
      renderAll();
    });

    segmented(document.getElementById("metric-control"), [
      { label: "Cases", value: "cases" },
      { label: "Deaths", value: "deaths" }
    ], state.metric, function (value) {
      state.metric = value;
      if (state.sort.key === "cases" || state.sort.key === "deaths") state.sort.key = value;
      buildControls();
      renderAll();
    });

    segmented(document.getElementById("scale-control"), [
      { label: "Linear", value: "linear" },
      { label: "Log", value: "log" }
    ], state.scale, function (value) {
      state.scale = value;
      buildControls();
      renderCurve();
      renderCountry();
      renderCompare();
      writeState();
    });

    segmented(document.getElementById("align-control"), [
      { label: "By date", value: "date" },
      { label: "By outbreak age", value: "align" }
    ], state.align ? "align" : "date", function (value) {
      state.align = value === "align";
      buildControls();
      renderCompare();
      writeState();
    });

    var milestoneToggle = document.getElementById("milestone-toggle");
    milestoneToggle.setAttribute("aria-pressed", String(state.milestones));
    milestoneToggle.textContent = state.milestones ? "Hide milestones" : "Show milestones";
  }

  function buildCountryList() {
    var list = document.getElementById("country-list");
    var fragment = document.createDocumentFragment();
    DATA.countries.slice().sort(function (a, b) { return a.n.localeCompare(b.n); })
      .forEach(function (country) {
        var option = document.createElement("option");
        option.value = country.n;
        fragment.appendChild(option);
      });
    list.appendChild(fragment);
  }

  function codeFromInput(value) {
    var needle = value.trim().toLowerCase();
    if (byName[needle]) return byName[needle];
    var matches = DATA.countries.filter(function (country) {
      return country.n.toLowerCase().indexOf(needle) === 0;
    });
    return matches.length === 1 ? matches[0].c : null;
  }

  function bindEvents() {
    document.getElementById("theme-toggle").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem("covid-theme", next); } catch (error) { /* private mode */ }
      renderAll();
    });

    var countryInput = document.getElementById("country-select");
    countryInput.addEventListener("change", function () {
      var code = codeFromInput(countryInput.value);
      if (code) selectCountry(code);
    });

    var compareInput = document.getElementById("compare-select");
    compareInput.addEventListener("change", function () {
      var code = codeFromInput(compareInput.value);
      compareInput.value = "";
      if (!code || state.compare.indexOf(code) >= 0) return;
      if (state.compare.length >= MAX_COMPARE) state.compare.shift();
      state.compare.push(code);
      renderCompare();
    });

    document.getElementById("compare-reset").addEventListener("click", function () {
      state.compare = ["US", "IN", "BR", "GB"].filter(function (code) { return byCode[code]; });
      renderCompare();
    });

    var search = document.getElementById("table-search");
    var searchTimer = 0;
    search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.tableQuery = search.value;
        renderTable();
      }, 120);
    });

    document.getElementById("download-csv").addEventListener("click", downloadCsv);
    document.getElementById("copy-link").addEventListener("click", copyLink);

    document.getElementById("milestone-toggle").addEventListener("click", function () {
      state.milestones = !state.milestones;
      buildControls();
      renderCurve();
      writeState();
    });

    // Every chart card can hand over the SVG the reader is looking at.
    document.querySelectorAll("[data-export]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = document.getElementById(button.dataset.export);
        if (target) Charts.exportSvg(target, button.dataset.export + "-" + state.range);
      });
    });

    document.querySelectorAll("#data-table thead button").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.dataset.sort;
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort.key = key;
          state.sort.dir = (key === "name" || key === "region") ? "asc" : "desc";
        }
        renderTable();
      });
    });

    // Highlight the section the reader is actually looking at.
    var links = {};
    document.querySelectorAll(".site-nav a").forEach(function (link) {
      links[link.getAttribute("href").slice(1)] = link;
    });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = links[entry.target.id];
        if (link && entry.isIntersecting) {
          Object.keys(links).forEach(function (id) { links[id].removeAttribute("aria-current"); });
          link.setAttribute("aria-current", "true");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    Object.keys(links).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) observer.observe(section);
    });

    global.addEventListener("scroll", function () { Charts.tooltip.hide(); }, { passive: true });
  }

  /* ---------------------------------------------------------------------- *
   * Shareable state — the view lives in the URL hash
   * ---------------------------------------------------------------------- */

  function writeState() {
    var parts = [
      "range=" + state.range,
      "metric=" + state.metric,
      "scale=" + state.scale,
      "country=" + state.country,
      "compare=" + state.compare.join(",")
    ];
    if (state.align) parts.push("align=1");
    if (!state.milestones) parts.push("marks=0");
    // replaceState, not a hash assignment: this should not add history entries
    // or jump the page to an element that happens to match.
    history.replaceState(null, "", "#" + parts.join("&"));
  }

  function readState() {
    var hash = location.hash.replace(/^#/, "");
    if (!hash || hash.indexOf("=") < 0) return;
    var found = {};
    hash.split("&").forEach(function (pair) {
      var split = pair.indexOf("=");
      if (split > 0) found[pair.slice(0, split)] = decodeURIComponent(pair.slice(split + 1));
    });

    if (found.range === "all" || META.years.indexOf(found.range) >= 0) state.range = found.range;
    if (MEASURES[found.metric]) state.metric = found.metric;
    if (found.scale === "log" || found.scale === "linear") state.scale = found.scale;
    if (found.country && byCode[found.country]) state.country = found.country;
    if (found.compare != null) {
      var codes = found.compare.split(",").filter(function (code) { return byCode[code]; });
      state.compare = codes.slice(0, MAX_COMPARE);
    }
    state.align = found.align === "1";
    state.milestones = found.marks !== "0";
  }

  function copyLink() {
    var button = document.getElementById("copy-link");
    var done = function (message) {
      button.textContent = message;
      setTimeout(function () { button.textContent = "Copy link"; }, 1800);
    };
    var url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done("Copied"); },
                                             function () { done("Press ⌘C"); });
    } else {
      done("Press ⌘C");
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("theme-toggle").setAttribute("aria-pressed", String(theme === "light"));
  }

  /* The daily bundle is an order of magnitude larger than the rest, and only
     the sections below the fold need it. Load it after the first paint so the
     page is interactive immediately. */
  function loadSeries() {
    var script = document.createElement("script");
    script.src = "data/series.js";
    script.async = true;
    script.onload = function () {
      state.seriesReady = true;
      renderCountry();
      renderCompare();
      renderTable();
    };
    script.onerror = function () {
      document.getElementById("country-panel").setAttribute("aria-busy", "false");
      document.getElementById("table-foot").textContent =
        "Could not load data/series.js — the per-country charts are unavailable.";
    };
    document.head.appendChild(script);
  }

  function boot() {
    var stored = null;
    try { stored = localStorage.getItem("covid-theme"); } catch (error) { /* private mode */ }
    applyTheme(stored || (global.matchMedia &&
      global.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

    state.compare = state.compare.filter(function (code) { return byCode[code]; });
    readState();
    if (!byCode[state.country]) state.country = DATA.countries[0].c;

    renderHero();
    buildControls();
    buildCountryList();
    document.getElementById("country-select").value = byCode[state.country].n;
    bindEvents();

    renderKpis();
    renderCurve();
    renderMap();
    renderRank();
    renderRegions();
    renderWaves();
    renderCompare();
    renderTable();
    writeState();

    requestAnimationFrame(loadSeries);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
