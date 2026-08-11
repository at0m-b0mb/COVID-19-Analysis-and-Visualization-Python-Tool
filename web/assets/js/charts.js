/* A small SVG chart engine, written for this dashboard.
 *
 * There is no charting library here. Every mark is emitted as SVG, which keeps
 * the page dependency-free and means the marks follow one fixed spec:
 *
 *   lines 2px round-capped · area fills ~10% of the series hue · bars capped at
 *   24px with a 4px rounded data-end · gridlines hairline, solid, recessive ·
 *   markers >= 8px carrying a 2px surface ring so they stay legible where they
 *   overlap · a legend whenever there are two or more series · text in text
 *   tokens, never in the series colour.
 *
 * Charts re-render on resize rather than scaling a viewBox, so labels stay the
 * same size and the tick density suits the width actually available.
 */
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var Fmt = global.Fmt;

  /* ---------------------------------------------------------------------- *
   * DOM helpers
   * ---------------------------------------------------------------------- */

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(node, value) {
    node.textContent = value;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------------------------------------------------------------------- *
   * Tooltip — one shared element for every chart on the page
   * ---------------------------------------------------------------------- */

  var tooltip = {
    node: null,
    ensure: function () {
      if (!this.node) this.node = document.getElementById("tooltip");
      return this.node;
    },
    /* rows: [{color, label, value, keyShape}] — labels are data, so they are
       always inserted as text nodes, never as markup. */
    show: function (x, y, title, rows, note) {
      var node = this.ensure();
      if (!node) return;
      clear(node);

      var head = document.createElement("div");
      head.className = "tt-title";
      head.textContent = title;
      node.appendChild(head);

      rows.forEach(function (row) {
        var line = document.createElement("div");
        line.className = "tt-row";
        if (row.color) {
          var key = document.createElement("span");
          key.className = "tt-key";
          key.style.background = row.color;
          if (row.keyShape === "block") {
            key.style.height = "9px";
            key.style.width = "9px";
            key.style.borderRadius = "2px";
          }
          line.appendChild(key);
        }
        var label = document.createElement("span");
        label.className = "tt-label";
        label.textContent = row.label;
        line.appendChild(label);
        var value = document.createElement("span");
        value.className = "tt-value";
        value.textContent = row.value;
        line.appendChild(value);
        node.appendChild(line);
      });

      if (note) {
        var foot = document.createElement("div");
        foot.className = "tt-note";
        foot.textContent = note;
        node.appendChild(foot);
      }

      node.classList.add("is-visible");
      this.place(x, y);
    },
    place: function (x, y) {
      var node = this.node;
      if (!node) return;
      var box = node.getBoundingClientRect();
      var left = Math.min(Math.max(x, box.width / 2 + 8), global.innerWidth - box.width / 2 - 8);
      var top = y - 14;
      // Flip below the pointer when there is no room above.
      if (top - box.height < 8) {
        node.style.transform = "translate(-50%, 0)";
        top = y + 22;
      } else {
        node.style.transform = "translate(-50%, -100%)";
      }
      node.style.left = left + "px";
      node.style.top = top + "px";
    },
    hide: function () {
      if (this.node) this.node.classList.remove("is-visible");
    }
  };

  /* ---------------------------------------------------------------------- *
   * Scales & ticks
   * ---------------------------------------------------------------------- */

  function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    var raw = (max - min) / count;
    var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var error = raw / magnitude;
    var step = magnitude * (error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1);
    var ticks = [];
    for (var value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) {
      ticks.push(Math.round(value * 1e6) / 1e6);
    }
    return ticks;
  }

  function logTicks(max) {
    var ticks = [];
    for (var power = 0; Math.pow(10, power) <= max * 1.5; power++) {
      ticks.push(Math.pow(10, power));
    }
    return ticks;
  }

  /* Log plots cannot show zero; 0.7 sits just under 1 so a zero day reads as
     "floor" rather than vanishing off the bottom of the plot. */
  var LOG_FLOOR = 0.7;

  function makeY(options) {
    var isLog = options.scale === "log";
    var max = options.max;
    var top = options.top;
    var bottom = options.bottom;

    if (isLog) {
      var logMax = Math.log(Math.max(max, 10)) / Math.LN10;
      var logMin = Math.log(LOG_FLOOR) / Math.LN10;
      return {
        isLog: true,
        max: max,
        of: function (value) {
          var safe = Math.max(value, LOG_FLOOR);
          var position = (Math.log(safe) / Math.LN10 - logMin) / (logMax - logMin);
          return bottom - position * (bottom - top);
        },
        ticks: logTicks(max)
      };
    }

    var ceiling = options.ticksHint === false ? max : null;
    var ticks = niceTicks(0, max || 1, options.tickCount || 4);
    ceiling = Math.max(max, ticks.length ? ticks[ticks.length - 1] : 1) || 1;
    return {
      isLog: false,
      max: ceiling,
      of: function (value) {
        return bottom - (value / ceiling) * (bottom - top);
      },
      ticks: ticks
    };
  }

  /* Date ticks that land on real calendar boundaries, thinned to the width. */
  function timeTicks(startMs, days, width) {
    var slots = Math.max(2, Math.floor(width / 92));
    var out = [];
    var first = new Date(startMs);
    var last = new Date(startMs + (days - 1) * Fmt.DAY_MS);

    function push(ms, label) {
      var offset = Math.round((ms - startMs) / Fmt.DAY_MS);
      if (offset >= 0 && offset < days) out.push({ offset: offset, label: label });
    }

    var months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 +
      (last.getUTCMonth() - first.getUTCMonth());

    if (months >= slots * 6) {
      for (var year = first.getUTCFullYear(); year <= last.getUTCFullYear(); year++) {
        push(Date.UTC(year, 0, 1), String(year));
      }
    } else {
      var stride = Math.max(1, Math.ceil((months + 1) / slots));
      // Prefer strides that land on quarters/half-years rather than odd counts.
      if (stride > 1 && stride < 3) stride = 3;
      else if (stride > 3 && stride < 6) stride = 6;
      else if (stride > 6 && stride < 12) stride = 12;
      var cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
      var index = 0;
      while (cursor <= last.getTime()) {
        var date = new Date(cursor);
        if (index % stride === 0) {
          push(cursor, date.getUTCMonth() === 0
            ? String(date.getUTCFullYear())
            : Fmt.MONTHS[date.getUTCMonth()] + (stride >= 6 ? " " + String(date.getUTCFullYear()).slice(2) : ""));
        }
        cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
        index++;
      }
    }
    if (!out.length) push(startMs, Fmt.longDate(startMs));
    return out;
  }

  /* ---------------------------------------------------------------------- *
   * Mount — measures the container and re-renders when its width changes
   * ---------------------------------------------------------------------- */

  var mounted = new WeakMap();

  function mount(container, render) {
    var record = mounted.get(container);
    if (record) record.observer.disconnect();

    var frame = 0;
    var lastWidth = 0;

    function draw() {
      var width = container.clientWidth;
      if (width < 40) return;
      lastWidth = width;
      clear(container);
      render(container, width);
    }

    var observer = new ResizeObserver(function () {
      if (Math.abs(container.clientWidth - lastWidth) < 2) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(container);
    mounted.set(container, { observer: observer, draw: draw });
    draw();
  }

  /* Attach the pointer + keyboard layer shared by every time-based chart. */
  function bindCrosshair(options) {
    var container = options.container;
    var svg = options.svg;
    var plot = options.plot;
    var count = options.count;
    var onIndex = options.onIndex;
    var onLeave = options.onLeave;

    var hit = el("rect", {
      x: plot.left, y: plot.top,
      width: Math.max(0, plot.right - plot.left),
      height: Math.max(0, plot.bottom - plot.top),
      "class": "c-hit"
    }, svg);

    function indexAt(clientX) {
      var box = svg.getBoundingClientRect();
      var x = clientX - box.left;
      var span = plot.right - plot.left;
      var ratio = span > 0 ? (x - plot.left) / span : 0;
      return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    }

    function move(event) {
      onIndex(indexAt(event.clientX), event.clientX, event.clientY);
    }

    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", function () {
      tooltip.hide();
      if (onLeave) onLeave();
    });

    // Keyboard reaches the same readout as hover.
    container.tabIndex = 0;
    if (!container.hasAttribute("role")) container.setAttribute("role", "img");
    var cursor = count - 1;
    container.onkeydown = function (event) {
      var step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!step) {
        if (event.key === "Home") cursor = 0;
        else if (event.key === "End") cursor = count - 1;
        else if (event.key === "Escape") { tooltip.hide(); if (onLeave) onLeave(); return; }
        else return;
      }
      event.preventDefault();
      cursor = Math.max(0, Math.min(count - 1, cursor + step * (event.shiftKey ? 7 : 1)));
      var box = svg.getBoundingClientRect();
      var x = box.left + plot.left + (plot.right - plot.left) * (count > 1 ? cursor / (count - 1) : 0);
      onIndex(cursor, x, box.top + plot.top + 20);
    };
    container.onblur = function () { tooltip.hide(); if (onLeave) onLeave(); };
  }

  function drawFrame(svg, plot, y, formatValue) {
    y.ticks.forEach(function (value) {
      var position = y.of(value);
      if (position < plot.top - 1 || position > plot.bottom + 1) return;
      el("line", {
        x1: plot.left, x2: plot.right, y1: position, y2: position, "class": "c-grid"
      }, svg);
      text(el("text", {
        x: plot.left - 8, y: position + 4, "text-anchor": "end", "class": "c-tick"
      }, svg), formatValue(value));
    });
    el("line", {
      x1: plot.left, x2: plot.right, y1: plot.bottom, y2: plot.bottom, "class": "c-axis"
    }, svg);
  }

  function drawTimeAxis(svg, plot, startMs, count, width) {
    var xOf = function (index) {
      return plot.left + (count > 1 ? (index / (count - 1)) * (plot.right - plot.left) : 0);
    };
    timeTicks(startMs, count, plot.right - plot.left).forEach(function (tick) {
      var x = xOf(tick.offset);
      text(el("text", {
        x: x, y: plot.bottom + 18, "text-anchor": "middle", "class": "c-tick"
      }, svg), tick.label);
    });
    return xOf;
  }

  /* Plain numeric x-axis, for series aligned on "days since" rather than dates. */
  function drawIndexAxis(svg, plot, count, unitLabel) {
    var xOf = function (index) {
      return plot.left + (count > 1 ? (index / (count - 1)) * (plot.right - plot.left) : 0);
    };
    niceTicks(0, count - 1, Math.max(2, Math.floor((plot.right - plot.left) / 90)))
      .forEach(function (value) {
        if (value > count - 1) return;
        text(el("text", {
          x: xOf(value), y: plot.bottom + 18, "text-anchor": "middle", "class": "c-tick"
        }, svg), Fmt.comma(value));
      });
    text(el("text", {
      x: (plot.left + plot.right) / 2, y: plot.bottom + 34,
      "text-anchor": "middle", "class": "c-tick"
    }, svg), unitLabel);
    return xOf;
  }

  /* Milestone rules. Drawn before the data so they sit behind it, and keyed by
     a number rather than inline text — labels on a dense time axis collide. */
  function drawAnnotations(svg, plot, xOf, count, annotations) {
    var lastBadge = -Infinity;
    annotations.forEach(function (note) {
      if (note.index < 0 || note.index >= count) return;
      var x = xOf(note.index);
      el("line", {
        x1: x, x2: x, y1: plot.top + 10, y2: plot.bottom, "class": "c-annot"
      }, svg);
      // Two milestones ten days apart put their badges on top of each other.
      // The rule stays on the true date; only the badge slides clear.
      var badgeX = Math.max(x, lastBadge + 18);
      lastBadge = badgeX;
      var group = el("g", { "class": "c-annot-pin" }, svg);
      el("circle", { cx: badgeX, cy: plot.top + 1, r: 8 }, group);
      text(el("text", { x: badgeX, y: plot.top + 5, "text-anchor": "middle" }, group),
        String(note.n));
      text(el("title", null, group), note.label);
    });
  }

  function emptyState(container, width, height, message) {
    var svg = el("svg", { width: width, height: height }, container);
    text(el("text", {
      x: width / 2, y: height / 2, "text-anchor": "middle", "class": "c-empty"
    }, svg), message);
  }

  /* Build an SVG path from values, skipping gaps where a value is null. */
  function linePath(values, xOf, yOf) {
    var parts = [];
    var open = false;
    for (var index = 0; index < values.length; index++) {
      var value = values[index];
      if (value == null || !isFinite(value)) { open = false; continue; }
      parts.push((open ? "L" : "M") + round(xOf(index)) + " " + round(yOf(value)));
      open = true;
    }
    return parts.join("");
  }

  function round(value) { return Math.round(value * 10) / 10; }

  /* ---------------------------------------------------------------------- *
   * Time series — one measure, area wash for the raw days + average line
   * ---------------------------------------------------------------------- */

  function timeSeries(container, config) {
    mount(container, function (node, width) {
      var height = config.height || 300;
      var plot = {
        left: config.padLeft || 56,
        right: width - (config.padRight || 14),
        top: 12,
        bottom: height - 30
      };
      if (plot.right <= plot.left) return;

      var values = config.values;
      var average = config.average;
      var count = values.length;
      if (!count) return emptyState(node, width, height, "No data in this period");

      var peak = 0;
      for (var index = 0; index < count; index++) {
        if (values[index] > peak) peak = values[index];
      }
      if (peak <= 0) peak = 1;

      var svg = el("svg", { width: width, height: height }, node);
      var y = makeY({ scale: config.scale, max: peak, top: plot.top, bottom: plot.bottom });
      drawFrame(svg, plot, y, config.formatValue || Fmt.compact);
      var xOf = drawTimeAxis(svg, plot, config.startMs, count, width);
      if (config.annotations) drawAnnotations(svg, plot, xOf, count, config.annotations);

      var color = token(config.color || "--series-1");
      var baseline = y.of(config.scale === "log" ? LOG_FLOOR : 0);

      // Raw daily values as a 10% wash: present, but never competing with the trend.
      var area = ["M" + round(xOf(0)) + " " + round(baseline)];
      for (var i = 0; i < count; i++) {
        area.push("L" + round(xOf(i)) + " " + round(y.of(values[i])));
      }
      area.push("L" + round(xOf(count - 1)) + " " + round(baseline) + "Z");
      el("path", { d: area.join(""), fill: color, "fill-opacity": 0.1 }, svg);

      if (average) {
        el("path", {
          d: linePath(average, xOf, y.of),
          fill: "none", stroke: color, "stroke-width": 2,
          "stroke-linejoin": "round", "stroke-linecap": "round"
        }, svg);
      }

      // Direct-label the extreme — the one point worth naming on this chart.
      if (config.markPeak !== false) {
        var peakIndex = 0;
        var source = average && average.some(function (v) { return v != null; }) ? average : values;
        for (var p = 0; p < count; p++) {
          if (source[p] != null && source[p] > (source[peakIndex] == null ? -1 : source[peakIndex])) peakIndex = p;
        }
        var peakValue = source[peakIndex];
        if (peakValue != null && peakValue > 0) {
          var px = xOf(peakIndex);
          var py = y.of(peakValue);
          el("circle", {
            cx: px, cy: py, r: 4, fill: color,
            stroke: token("--surface"), "stroke-width": 2
          }, svg);
          var anchor = px > plot.right - 90 ? "end" : px < plot.left + 90 ? "start" : "middle";
          text(el("text", {
            x: px + (anchor === "end" ? 6 : anchor === "start" ? -6 : 0),
            y: py - 12, "text-anchor": anchor, "class": "c-endlabel"
          }, svg), "peak " + Fmt.compact(peakValue));
        }
      }

      var crosshair = el("line", {
        x1: 0, x2: 0, y1: plot.top, y2: plot.bottom,
        "class": "c-crosshair", opacity: 0
      }, svg);
      var dot = el("circle", {
        r: 4.5, fill: color, stroke: token("--surface"), "stroke-width": 2, opacity: 0
      }, svg);

      container.setAttribute("aria-label", config.ariaLabel ||
        (config.label + " from " + Fmt.longDate(config.startMs) + " to " +
         Fmt.longDate(config.startMs + (count - 1) * Fmt.DAY_MS) +
         ", peaking at " + Fmt.comma(peak) + "."));

      bindCrosshair({
        container: container, svg: svg, plot: plot, count: count,
        onIndex: function (index, clientX, clientY) {
          var x = xOf(index);
          crosshair.setAttribute("x1", x);
          crosshair.setAttribute("x2", x);
          crosshair.setAttribute("opacity", 1);
          var marker = average && average[index] != null ? average[index] : values[index];
          dot.setAttribute("cx", x);
          dot.setAttribute("cy", y.of(marker));
          dot.setAttribute("opacity", 1);

          var format = config.formatTooltip || Fmt.comma;
          var rows = [{ color: color, label: config.label, value: format(values[index]) }];
          if (average && average[index] != null) {
            rows.push({ color: color, label: config.averageLabel || "7-day average", value: format(average[index]) });
          }
          // Surface a milestone when the crosshair is near its rule.
          var note = config.note;
          (config.annotations || []).forEach(function (item) {
            if (Math.abs(item.index - index) <= 3) note = item.label;
          });
          tooltip.show(clientX, clientY,
            Fmt.longDate(config.startMs + index * Fmt.DAY_MS), rows, note);
        },
        onLeave: function () {
          crosshair.setAttribute("opacity", 0);
          dot.setAttribute("opacity", 0);
        }
      });
    });
  }

  /* ---------------------------------------------------------------------- *
   * Multi-line — several countries on one axis
   * ---------------------------------------------------------------------- */

  function multiLine(container, config) {
    mount(container, function (node, width) {
      var height = config.height || 340;
      var series = config.series.filter(function (item) { return item.visible !== false; });
      var labelRoom = width > 620 ? 96 : 16;
      var plot = {
        left: 56, right: width - labelRoom, top: 14, bottom: height - 30
      };
      if (plot.right <= plot.left) return;
      if (!series.length) return emptyState(node, width, height, "Choose a country to compare");

      var count = 0;
      var peak = 0;
      series.forEach(function (item) {
        count = Math.max(count, item.values.length);
        item.values.forEach(function (value) {
          if (value != null && value > peak) peak = value;
        });
      });
      if (!count) return emptyState(node, width, height, "No data in this period");
      if (peak <= 0) peak = 1;

      var byIndex = config.xMode === "index";
      if (byIndex) plot.bottom -= 16;   // room for the axis caption

      var svg = el("svg", { width: width, height: height }, node);
      var y = makeY({ scale: config.scale, max: peak, top: plot.top, bottom: plot.bottom });
      drawFrame(svg, plot, y, Fmt.compact);
      var xOf = byIndex
        ? drawIndexAxis(svg, plot, count, config.xLabel || "days")
        : drawTimeAxis(svg, plot, config.startMs, count, width);

      var surface = token("--surface");

      series.forEach(function (item) {
        var color = token(item.color);
        el("path", {
          d: linePath(item.values, xOf, y.of),
          fill: "none", stroke: color, "stroke-width": 2,
          "stroke-linejoin": "round", "stroke-linecap": "round"
        }, svg);
      });

      // Direct end-labels when there is room; nudge apart only enough to stop
      // overlap, and drop them entirely on narrow screens where the legend rules.
      if (labelRoom > 40) {
        var ends = series.map(function (item) {
          var last = null;
          for (var index = item.values.length - 1; index >= 0; index--) {
            if (item.values[index] != null) { last = index; break; }
          }
          return last == null ? null : {
            name: item.name, color: token(item.color),
            x: xOf(last), y: y.of(item.values[last])
          };
        }).filter(Boolean).sort(function (a, b) { return a.y - b.y; });

        for (var k = 1; k < ends.length; k++) {
          if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
        }
        ends.forEach(function (end) {
          el("circle", {
            cx: end.x, cy: y.of(0) === end.y ? end.y : end.y, r: 4,
            fill: end.color, stroke: surface, "stroke-width": 2, opacity: 0.001
          }, svg);
          text(el("text", {
            x: plot.right + 10, y: Math.min(plot.bottom, Math.max(plot.top + 4, end.y)) + 4,
            "class": "c-endlabel"
          }, svg), end.name.length > 13 ? end.name.slice(0, 12) + "…" : end.name);
        });
      }

      var crosshair = el("line", {
        x1: 0, x2: 0, y1: plot.top, y2: plot.bottom, "class": "c-crosshair", opacity: 0
      }, svg);
      var dots = series.map(function (item) {
        return el("circle", {
          r: 4.5, fill: token(item.color), stroke: surface, "stroke-width": 2, opacity: 0
        }, svg);
      });

      container.setAttribute("aria-label", "Comparison of " +
        series.map(function (item) { return item.name; }).join(", ") + ". " + (config.ariaSuffix || ""));

      bindCrosshair({
        container: container, svg: svg, plot: plot, count: count,
        onIndex: function (index, clientX, clientY) {
          var x = xOf(index);
          crosshair.setAttribute("x1", x);
          crosshair.setAttribute("x2", x);
          crosshair.setAttribute("opacity", 1);

          var rows = series.map(function (item, position) {
            var value = item.values[index];
            var dot = dots[position];
            if (value == null) {
              dot.setAttribute("opacity", 0);
            } else {
              dot.setAttribute("cx", x);
              dot.setAttribute("cy", y.of(value));
              dot.setAttribute("opacity", 1);
            }
            return {
              color: token(item.color), label: item.name,
              value: value == null ? "—" : Fmt.comma(value),
              sort: value == null ? -1 : value
            };
          }).sort(function (a, b) { return b.sort - a.sort; });

          tooltip.show(clientX, clientY,
            byIndex
              ? (config.xLabel || "Day") + " " + Fmt.comma(index)
              : Fmt.longDate(config.startMs + index * Fmt.DAY_MS),
            rows, config.note);
        },
        onLeave: function () {
          crosshair.setAttribute("opacity", 0);
          dots.forEach(function (dot) { dot.setAttribute("opacity", 0); });
        }
      });
    });
  }

  /* ---------------------------------------------------------------------- *
   * Stacked area — part-to-whole over time
   * ---------------------------------------------------------------------- */

  function stackedArea(container, config) {
    mount(container, function (node, width) {
      var height = config.height || 330;
      var plot = { left: 56, right: width - 14, top: 14, bottom: height - 30 };
      if (plot.right <= plot.left) return;

      var series = config.series.filter(function (item) { return item.visible !== false; });
      if (!series.length) return emptyState(node, width, height, "Every band is hidden");

      var count = series[0].values.length;
      var totals = new Array(count).fill(0);
      series.forEach(function (item) {
        for (var index = 0; index < count; index++) totals[index] += item.values[index] || 0;
      });
      var peak = Math.max.apply(null, totals) || 1;

      var svg = el("svg", { width: width, height: height }, node);
      var y = makeY({ max: peak, top: plot.top, bottom: plot.bottom });
      drawFrame(svg, plot, y, Fmt.compact);

      var xOf = function (index) {
        return plot.left + (count > 1 ? (index / (count - 1)) * (plot.right - plot.left) : 0);
      };
      timeTicks(config.startMs, count * config.step, plot.right - plot.left).forEach(function (tick) {
        var x = xOf(tick.offset / config.step);
        text(el("text", {
          x: x, y: plot.bottom + 18, "text-anchor": "middle", "class": "c-tick"
        }, svg), tick.label);
      });

      // Draw top band first so lower bands paint over the seam; the 2px surface
      // gap below does the separating, never a stroke around the fill.
      var running = new Array(count).fill(0);
      var layers = series.map(function (item) {
        var lower = running.slice();
        for (var index = 0; index < count; index++) running[index] += item.values[index] || 0;
        return { item: item, lower: lower, upper: running.slice() };
      });

      layers.slice().reverse().forEach(function (layer) {
        var parts = [];
        for (var index = 0; index < count; index++) {
          parts.push((index ? "L" : "M") + round(xOf(index)) + " " + round(y.of(layer.upper[index])));
        }
        for (var back = count - 1; back >= 0; back--) {
          parts.push("L" + round(xOf(back)) + " " + round(y.of(layer.lower[back])));
        }
        var color = token(layer.item.color);
        el("path", { d: parts.join("") + "Z", fill: color, "fill-opacity": 0.92 }, svg);
        // 2px of surface between touching bands.
        el("path", {
          d: linePath(layer.upper, xOf, y.of),
          fill: "none", stroke: token("--surface"), "stroke-width": 2
        }, svg);
      });

      var crosshair = el("line", {
        x1: 0, x2: 0, y1: plot.top, y2: plot.bottom, "class": "c-crosshair", opacity: 0
      }, svg);

      container.setAttribute("aria-label", config.ariaLabel || "Stacked weekly totals by region.");

      bindCrosshair({
        container: container, svg: svg, plot: plot, count: count,
        onIndex: function (index, clientX, clientY) {
          var x = xOf(index);
          crosshair.setAttribute("x1", x);
          crosshair.setAttribute("x2", x);
          crosshair.setAttribute("opacity", 1);

          var rows = series.map(function (item) {
            return {
              color: token(item.color), label: item.name, keyShape: "block",
              value: Fmt.comma(item.values[index] || 0), sort: item.values[index] || 0
            };
          }).sort(function (a, b) { return b.sort - a.sort; });
          rows.push({ color: null, label: "Total", value: Fmt.comma(totals[index]) });

          tooltip.show(clientX, clientY,
            config.labelAt ? config.labelAt(index) : String(index), rows, config.note);
        },
        onLeave: function () { crosshair.setAttribute("opacity", 0); }
      });
    });
  }

  /* ---------------------------------------------------------------------- *
   * Diverging area — a rate that can sit either side of a baseline
   * ---------------------------------------------------------------------- */

  function divergingArea(container, config) {
    mount(container, function (node, width) {
      var height = config.height || 260;
      var plot = { left: 56, right: width - 14, top: 12, bottom: height - 30 };
      if (plot.right <= plot.left) return;

      var values = config.values;
      var count = values.length;
      if (!count) return emptyState(node, width, height, "No data in this period");

      // Symmetric around zero, so "up" and "down" are the same distance for the
      // same magnitude — the whole point of a diverging encoding.
      var limit = 0;
      values.forEach(function (value) {
        if (value != null && Math.abs(value) > limit) limit = Math.abs(value);
      });
      limit = Math.min(limit, config.clamp || Infinity) || 1;

      var svg = el("svg", { width: width, height: height }, node);
      var span = plot.bottom - plot.top;
      var yOf = function (value) {
        var clamped = Math.max(-limit, Math.min(limit, value));
        return plot.top + span / 2 - (clamped / limit) * (span / 2);
      };

      niceTicks(-limit, limit, 4).forEach(function (value) {
        var position = yOf(value);
        el("line", {
          x1: plot.left, x2: plot.right, y1: position, y2: position, "class": "c-grid"
        }, svg);
        text(el("text", {
          x: plot.left - 8, y: position + 4, "text-anchor": "end", "class": "c-tick"
        }, svg), (value > 0 ? "+" : "") + Math.round(value) + "%");
      });

      var xOf = drawTimeAxis(svg, plot, config.startMs, count, width);
      var zero = yOf(0);
      el("line", { x1: plot.left, x2: plot.right, y1: zero, y2: zero, "class": "c-axis" }, svg);

      // Two arms of the diverging pair, clipped at the zero line.
      ["up", "down"].forEach(function (side) {
        var clipId = "clip-" + side + "-" + Math.random().toString(36).slice(2, 8);
        var clip = el("clipPath", { id: clipId }, svg);
        el("rect", {
          x: plot.left, y: side === "up" ? plot.top : zero,
          width: plot.right - plot.left,
          height: Math.max(0, side === "up" ? zero - plot.top : plot.bottom - zero)
        }, clip);

        var parts = ["M" + round(xOf(0)) + " " + round(zero)];
        for (var index = 0; index < count; index++) {
          parts.push("L" + round(xOf(index)) + " " + round(yOf(values[index] == null ? 0 : values[index])));
        }
        parts.push("L" + round(xOf(count - 1)) + " " + round(zero) + "Z");

        var color = token(side === "up" ? (config.upColor || "--series-8")
                                        : (config.downColor || "--series-1"));
        el("path", {
          d: parts.join(""), fill: color, "fill-opacity": 0.24,
          "clip-path": "url(#" + clipId + ")"
        }, svg);
        el("path", {
          d: parts.join(""), fill: "none", stroke: color, "stroke-width": 2,
          "stroke-linejoin": "round", "clip-path": "url(#" + clipId + ")"
        }, svg);
      });

      var crosshair = el("line", {
        x1: 0, x2: 0, y1: plot.top, y2: plot.bottom, "class": "c-crosshair", opacity: 0
      }, svg);

      container.setAttribute("aria-label", config.ariaLabel ||
        "Week-on-week change, above and below zero.");

      bindCrosshair({
        container: container, svg: svg, plot: plot, count: count,
        onIndex: function (index, clientX, clientY) {
          var x = xOf(index);
          crosshair.setAttribute("x1", x);
          crosshair.setAttribute("x2", x);
          crosshair.setAttribute("opacity", 1);
          var value = values[index];
          tooltip.show(clientX, clientY,
            Fmt.longDate(config.startMs + index * Fmt.DAY_MS),
            [{
              color: token(value > 0 ? (config.upColor || "--series-8")
                                     : (config.downColor || "--series-1")),
              label: config.label || "Change vs previous week",
              value: value == null ? "—" : (value > 0 ? "+" : "") + value.toFixed(1) + "%"
            }], config.note);
        },
        onLeave: function () { crosshair.setAttribute("opacity", 0); }
      });
    });
  }

  /* ---------------------------------------------------------------------- *
   * Horizontal bars — magnitude, one hue
   * ---------------------------------------------------------------------- */

  function barsH(container, config) {
    mount(container, function (node, width) {
      var items = config.items;
      if (!items.length) return emptyState(node, width, 200, "Nothing to rank");

      var rowHeight = config.rowHeight || 26;
      var barHeight = Math.min(14, rowHeight - 10); // capped: the band keeps its air
      var labelWidth = Math.min(150, Math.max(88, Math.round(width * 0.32)));
      var valueWidth = 62;
      var plot = {
        left: labelWidth + 10,
        right: width - valueWidth,
        top: 4
      };
      var height = items.length * rowHeight + 8;
      if (plot.right <= plot.left) return;

      var svg = el("svg", { width: width, height: height }, node);
      var peak = Math.max.apply(null, items.map(function (item) { return item.value; })) || 1;
      var color = token(config.color || "--series-1");
      var span = plot.right - plot.left;

      items.forEach(function (item, index) {
        var y = plot.top + index * rowHeight;
        var barWidth = Math.max(2, (item.value / peak) * span);
        var group = el("g", { "class": "bar-row", tabindex: config.onSelect ? 0 : null,
          role: config.onSelect ? "button" : null }, svg);
        if (config.onSelect) group.style.cursor = "pointer";

        // Hit area spans the whole row, so the pointer never has to find the bar.
        el("rect", {
          x: 0, y: y, width: width, height: rowHeight, "class": "c-hit"
        }, group);

        text(el("text", {
          x: labelWidth, y: y + rowHeight / 2 + 4, "text-anchor": "end", "class": "c-label"
        }, group), item.label);

        el("rect", {
          x: plot.left, y: y + (rowHeight - barHeight) / 2,
          width: barWidth, height: barHeight,
          rx: 4, fill: color, "class": "c-bar"
        }, group);
        // Square off the baseline end: only the data end is rounded.
        el("rect", {
          x: plot.left, y: y + (rowHeight - barHeight) / 2,
          width: Math.min(4, barWidth), height: barHeight, fill: color
        }, group);

        text(el("text", {
          x: plot.left + barWidth + 8, y: y + rowHeight / 2 + 4, "class": "c-tick"
        }, group), Fmt.compact(item.value));

        group.addEventListener("pointermove", function (event) {
          tooltip.show(event.clientX, event.clientY, item.label,
            (item.rows || [{ color: color, label: config.valueLabel || "Total", value: Fmt.comma(item.value) }]));
        });
        group.addEventListener("pointerleave", tooltip.hide);
        if (config.onSelect) {
          group.addEventListener("click", function () { config.onSelect(item.key); });
          group.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              config.onSelect(item.key);
            }
          });
          group.setAttribute("aria-label", item.label + ", " + Fmt.comma(item.value));
        }
      });

      container.setAttribute("aria-label", config.ariaLabel || "Ranked bar chart.");
    });
  }

  /* ---------------------------------------------------------------------- *
   * Choropleth
   * ---------------------------------------------------------------------- */

  /* Seven classes on round breaks. Quantiles would fit the data better, but
     round numbers are what a reader can actually hold in their head.
     The ladder is built up to the maximum and then the top six rungs are
     kept, so the darkest class always lands near the real maximum. */
  function magnitudeBreaks(max) {
    var ladder = [];
    var value = 1;
    while (value < max) {
      ladder.push(value, value * 5);
      value *= 10;
    }
    ladder = ladder.filter(function (step) { return step < max; });
    return ladder.length <= 6 ? ladder : ladder.slice(ladder.length - 6);
  }

  function classOf(value, breaks) {
    if (!(value > 0)) return -1;
    for (var index = 0; index < breaks.length; index++) {
      if (value < breaks[index]) return index;
    }
    return breaks.length;
  }

  function rampColor(index) {
    return token("--seq-" + Math.min(7, Math.max(1, index + 1)));
  }

  function choropleth(container, config) {
    mount(container, function (node, width) {
      var viewBox = config.viewBox;
      var height = Math.round(width * (viewBox[3] / viewBox[2]));
      var svg = el("svg", {
        viewBox: viewBox.join(" "), width: width, height: height,
        preserveAspectRatio: "xMidYMid meet"
      }, node);

      var max = 0;
      for (var code in config.values) {
        if (config.values[code] > max) max = config.values[code];
      }
      var breaks = magnitudeBreaks(max);
      config.onBreaks(breaks);

      var shapes = {};
      Object.keys(config.paths).forEach(function (code) {
        var value = config.values[code] || 0;
        var bucket = classOf(value, breaks);
        var path = el("path", {
          d: config.paths[code],
          fill: bucket < 0 ? token("--seq-empty") : rampColor(bucket),
          "class": "map-country" + (bucket < 0 ? " is-empty" : ""),
          tabindex: bucket < 0 ? null : 0,
          role: bucket < 0 ? null : "button"
        }, svg);
        shapes[code] = path;
        if (bucket < 0) return;

        var name = config.names[code] || code;
        path.setAttribute("aria-label", name + ", " + Fmt.comma(value) + " " + config.measure);

        function show(event) {
          tooltip.show(event.clientX, event.clientY, name, config.rowsFor(code));
        }
        path.addEventListener("pointermove", show);
        path.addEventListener("pointerleave", tooltip.hide);
        path.addEventListener("click", function () { config.onSelect(code); });
        path.addEventListener("focus", function () {
          var box = path.getBoundingClientRect();
          tooltip.show(box.left + box.width / 2, box.top, name, config.rowsFor(code));
        });
        path.addEventListener("blur", tooltip.hide);
        path.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            config.onSelect(code);
          }
        });
      });

      container.__setActive = function (code) {
        Object.keys(shapes).forEach(function (key) {
          shapes[key].classList.toggle("is-active", key === code);
        });
      };
      if (config.activeKey) container.__setActive(config.activeKey);

      container.setAttribute("role", "img");
      container.setAttribute("aria-label",
        "World map shaded by " + config.measure + ". The full ranking is in the table below.");
    });
  }

  /* ---------------------------------------------------------------------- *
   * Heatmap
   * ---------------------------------------------------------------------- */

  function heatmap(container, config) {
    mount(container, function (node, width) {
      var rows = config.rows;
      var columns = config.columns;
      var labelWidth = 150;
      var rowHeight = 22;
      var gap = 2;                                  // the surface gap, again
      var chartWidth = Math.max(width, labelWidth + columns.length * 18);
      var cellWidth = (chartWidth - labelWidth - 8) / columns.length;
      var height = rows.length * rowHeight + 34;

      var svg = el("svg", { width: chartWidth, height: height }, node);

      columns.forEach(function (key, index) {
        // Label only January, so the axis stays readable at any width.
        if (!/-01$/.test(key)) return;
        text(el("text", {
          x: labelWidth + index * cellWidth + cellWidth / 2,
          y: 12, "text-anchor": "middle", "class": "c-tick"
        }, svg), key.slice(0, 4));
      });

      rows.forEach(function (row, rowIndex) {
        var y = 22 + rowIndex * rowHeight;
        // Right-aligned labels run off the left edge if they are too long to
        // fit the gutter, so shorten rather than let the SVG clip them.
        var label = row.label.length > 22 ? row.label.slice(0, 21) + "…" : row.label;
        var title = text(el("text", {
          x: labelWidth - 12, y: y + rowHeight / 2 + 3,
          "text-anchor": "end", "class": "c-label"
        }, svg), label);
        if (label !== row.label) text(el("title", null, title), row.label);

        row.values.forEach(function (share, columnIndex) {
          var bucket = share <= 0 ? -1 : Math.min(6, Math.floor(share * 7));
          var cell = el("rect", {
            x: labelWidth + columnIndex * cellWidth,
            y: y + gap / 2,
            width: Math.max(1, cellWidth - gap),
            height: rowHeight - gap,
            rx: 2,
            fill: bucket < 0 ? token("--seq-empty") : rampColor(bucket),
            "class": "heat-cell"
          }, svg);

          cell.addEventListener("pointermove", function (event) {
            tooltip.show(event.clientX, event.clientY,
              row.label + " · " + Fmt.monthKeyLabel(columns[columnIndex]),
              [
                { color: rampColor(Math.max(0, bucket)), label: "Reported cases", value: Fmt.comma(row.raw[columnIndex]) },
                { color: null, label: "Of its worst month", value: Math.round(share * 100) + "%" }
              ]);
          });
          cell.addEventListener("pointerleave", tooltip.hide);
        });
      });

      container.setAttribute("role", "img");
      container.setAttribute("aria-label",
        "Heatmap of monthly reported cases for the 24 largest countries, each row shaded against its own peak month. The underlying totals are in the table below.");
    });
  }

  /* ---------------------------------------------------------------------- *
   * Sparkline — no axes, no tooltip; it is a shape, not a chart
   * ---------------------------------------------------------------------- */

  function sparkline(values, color, width, height) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    // A viewBox lets CSS shrink the sparkline to fit a narrow stat tile.
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    var peak = 0;
    for (var index = 0; index < values.length; index++) {
      if (values[index] > peak) peak = values[index];
    }
    if (!peak) peak = 1;

    var xOf = function (i) { return values.length > 1 ? (i / (values.length - 1)) * width : 0; };
    var yOf = function (v) { return height - 1 - (Math.max(0, v) / peak) * (height - 2); };

    var area = ["M0 " + height];
    for (var i = 0; i < values.length; i++) {
      area.push("L" + round(xOf(i)) + " " + round(yOf(values[i])));
    }
    area.push("L" + round(width) + " " + height + "Z");

    var fill = document.createElementNS(NS, "path");
    fill.setAttribute("d", area.join(""));
    fill.setAttribute("fill", color);
    fill.setAttribute("fill-opacity", "0.16");
    svg.appendChild(fill);

    var line = document.createElementNS(NS, "path");
    line.setAttribute("d", linePath(values, xOf, yOf));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linejoin", "round");
    svg.appendChild(line);
    return svg;
  }

  /* ---------------------------------------------------------------------- *
   * Export — hand the reader the SVG they are looking at
   * ---------------------------------------------------------------------- */

  /* The chart's colours live in the page's stylesheet, so a bare serialisation
     downloads a black-on-black file. Resolve the tokens and inline them. */
  var EXPORT_TOKENS = [
    "--surface", "--grid", "--axis", "--muted", "--text-2", "--border-firm"
  ];

  function exportSvg(container, filename) {
    var source = container.querySelector("svg");
    if (!source) return;
    var copy = source.cloneNode(true);
    copy.setAttribute("xmlns", NS);

    var computed = getComputedStyle(document.documentElement);
    var vars = EXPORT_TOKENS.map(function (name) {
      return name + ":" + computed.getPropertyValue(name).trim() + ";";
    }).join("");

    var style = document.createElementNS(NS, "style");
    style.textContent =
      "svg{" + vars + "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}" +
      ".c-grid{stroke:var(--grid);stroke-width:1;}" +
      ".c-axis{stroke:var(--axis);stroke-width:1;}" +
      ".c-tick{fill:var(--muted);font-size:11px;}" +
      ".c-label{fill:var(--text-2);font-size:12px;}" +
      ".c-endlabel{fill:var(--text-2);font-size:12px;font-weight:580;}" +
      ".c-annot{stroke:var(--border-firm);stroke-width:1;}" +
      ".c-annot-pin circle{fill:var(--surface);stroke:var(--border-firm);}" +
      ".c-annot-pin text{fill:var(--muted);font-size:10px;}" +
      ".c-crosshair,.c-hit{display:none;}";
    copy.insertBefore(style, copy.firstChild);

    // Paint the surface in, so the file is not transparent on a white page.
    var background = document.createElementNS(NS, "rect");
    background.setAttribute("width", copy.getAttribute("width") || "100%");
    background.setAttribute("height", copy.getAttribute("height") || "100%");
    background.setAttribute("fill", computed.getPropertyValue("--surface").trim());
    copy.insertBefore(background, style.nextSibling);

    var blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', new XMLSerializer().serializeToString(copy)],
      { type: "image/svg+xml;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename + ".svg";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  global.Charts = {
    timeSeries: timeSeries,
    multiLine: multiLine,
    stackedArea: stackedArea,
    divergingArea: divergingArea,
    exportSvg: exportSvg,
    barsH: barsH,
    choropleth: choropleth,
    heatmap: heatmap,
    sparkline: sparkline,
    rampColor: rampColor,
    token: token,
    tooltip: tooltip
  };
})(window);
