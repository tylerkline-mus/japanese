// charts.js — small hand-rolled SVG charts. Every mark carries data-tip for the hover/tap tooltip.
import { esc, fmt } from "./util.js";

let W = 640;
// Charts are drawn at the real container width so labels stay readable on phones.
export function setChartWidth(w) {
  W = Math.max(280, Math.min(680, Math.round(w)));
}

function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

function shortDate(key) {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

// Line chart with area wash, for the queue burn-down.
export function lineChart(points, { height = 200, unit = "" } = {}) {
  if (!points.length) return "";
  const H = height;
  const pad = { l: 44, r: 16, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const step = Math.max(1, Math.ceil(points.length / 6));
  const last = points[points.length - 1];
  const hit = points
    .map((p, i) => {
      const w = points.length === 1 ? iw : iw / (points.length - 1);
      return `<rect class="hit" x="${(x(i) - w / 2).toFixed(1)}" y="${pad.t}" width="${w.toFixed(1)}" height="${ih}" data-tip="${esc(
        `${p.label}: ${fmt(p.value)}${unit}`
      )}"/>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
    ${ticks
      .map(
        (t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="tick" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`
      )
      .join("")}
    <path class="area" d="${area}"/>
    <path class="line" d="${path}"/>
    ${points.length <= 40 ? points.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="${i === points.length - 1 ? 5 : 3}"/>`).join("") : ""}
    <text class="label-strong" x="${Math.min(x(points.length - 1), W - pad.r)}" y="${y(last.value) - 12}" text-anchor="${points.length === 1 ? "middle" : "end"}">${fmt(last.value)}</text>
    ${points
      .map((p, i) => (i % step === 0 || i === points.length - 1 ? `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>` : ""))
      .join("")}
    ${hit}
  </svg>`;
}

// Vertical bars (forecast, level pace). items: {label, value, tip, emphasis}
export function barChart(items, { height = 180, refLine = null, refLabel = "" } = {}) {
  if (!items.length) return "";
  const H = height;
  const pad = { l: 40, r: 12, t: 18, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...items.map((d) => d.value), refLine || 0));
  const slot = iw / items.length;
  const bw = Math.min(44, slot * 0.62);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const r = 4;
  const bars = items
    .map((d, i) => {
      const cx = pad.l + slot * i + slot / 2;
      const h = Math.max(0, y(0) - y(d.value));
      const x0 = cx - bw / 2;
      const top = y(d.value);
      const rr = Math.min(r, h);
      const shape =
        h > 0
          ? `<path class="bar ${d.emphasis ? "bar-em" : ""}" d="M${x0},${y(0)} V${top + rr} Q${x0},${top} ${x0 + rr},${top} H${x0 + bw - rr} Q${x0 + bw},${top} ${x0 + bw},${top + rr} V${y(0)} Z"/>`
          : "";
      const showVal = items.length <= 10;
      return `${shape}
        ${showVal ? `<text class="tick val" x="${cx}" y="${top - 5}" text-anchor="middle">${fmt(d.value)}</text>` : ""}
        <text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>
        <rect class="hit" x="${cx - slot / 2}" y="${pad.t}" width="${slot}" height="${ih}" data-tip="${esc(d.tip || `${d.label}: ${fmt(d.value)}`)}"/>`;
    })
    .join("");
  const ref =
    refLine != null
      ? `<line class="ref" x1="${pad.l}" x2="${W - pad.r}" y1="${y(refLine)}" y2="${y(refLine)}"/>
         <text class="tick" x="${W - pad.r}" y="${y(refLine) - 5}" text-anchor="end">${esc(refLabel)}</text>`
      : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
    <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
    <text class="tick" x="${pad.l - 8}" y="${y(max) + 4}" text-anchor="end">${fmt(max)}</text>
    ${bars}${ref}
  </svg>`;
}

// One horizontal stacked bar for SRS stages (ordinal blue ramp), with legend + values.
export function stackBar(segments) {
  const total = segments.reduce((s, d) => s + d.value, 0) || 1;
  const gap = 2;
  const H = 28;
  let x = 0;
  const visible = segments.filter((s) => s.value > 0);
  const avail = W - gap * Math.max(0, visible.length - 1);
  const rects = visible
    .map((s, i) => {
      const w = Math.max(2, (s.value / total) * avail);
      const isFirst = i === 0;
      const isLast = i === visible.length - 1;
      const rx = 4;
      const d = `M${x + (isFirst ? rx : 0)},0 H${x + w - (isLast ? rx : 0)} ${isLast ? `Q${x + w},0 ${x + w},${rx} V${H - rx} Q${x + w},${H} ${x + w - rx},${H}` : `V${H}`} H${x + (isFirst ? rx : 0)} ${
        isFirst ? `Q${x},${H} ${x},${H - rx} V${rx} Q${x},0 ${x + rx},0` : `V0`
      } Z`;
      const out = `<path class="seg seg-${s.key}" d="${d}" data-tip="${esc(`${s.label}: ${fmt(s.value)} (${Math.round((s.value / total) * 100)}%)`)}"/>`;
      x += w + gap;
      return out;
    })
    .join("");
  const legend = segments
    .map(
      (s) => `<div class="lg"><span class="sw seg-${s.key}"></span><span class="lg-label">${esc(s.label)}</span><span class="lg-val">${fmt(s.value)}</span></div>`
    )
    .join("");
  return `<svg class="chart stack" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="SRS breakdown">${rects}</svg>
    <div class="legend">${legend}</div>`;
}

// GitHub-style consistency calendar. counts: Map(dateKey → number)
export function heatmap(counts, endKey, weeks = 12) {
  const cell = 14;
  const gap = 3;
  const end = new Date(endKey + "T12:00:00");
  const endDow = end.getDay();
  const start = new Date(end.getTime() - ((weeks - 1) * 7 + endDow) * 86400000);
  const vals = [...counts.values()].filter((v) => v > 0);
  const max = vals.length ? Math.max(...vals) : 1;
  const level = (v) => (v <= 0 ? 0 : v < max * 0.25 ? 1 : v < max * 0.5 ? 2 : v < max * 0.75 ? 3 : 4);
  const cells = [];
  const months = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start.getTime() + (w * 7 + d) * 86400000);
      if (dt > end) continue;
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const v = counts.get(key) || 0;
      if (dt.getDate() <= 7 && d === 0) months.push({ w, label: dt.toLocaleString("en-US", { month: "short" }) });
      cells.push(
        `<rect class="hm hm-${counts.has(key) ? level(v) : "none"}" x="${28 + w * (cell + gap)}" y="${16 + d * (cell + gap)}" width="${cell}" height="${cell}" rx="3" data-tip="${esc(
          `${shortDate(key)}: ${counts.has(key) ? `${fmt(v)} items reviewed` : "no record"}`
        )}"/>`
      );
    }
  }
  const width = 28 + weeks * (cell + gap);
  const height = 16 + 7 * (cell + gap);
  const dow = ["", "M", "", "W", "", "F", ""]
    .map((l, i) => (l ? `<text class="tick" x="18" y="${16 + i * (cell + gap) + 11}" text-anchor="end">${l}</text>` : ""))
    .join("");
  const ml = months.map((m) => `<text class="tick" x="${28 + m.w * (cell + gap)}" y="11">${m.label}</text>`).join("");
  return `<svg class="chart heat" viewBox="0 0 ${width} ${height}" role="img" aria-label="Study calendar">${dow}${ml}${cells.join("")}</svg>`;
}

export function meter(value, max = 100) {
  const p = Math.max(0, Math.min(1, value / max));
  return `<div class="meter" role="meter" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="${max}"><span style="width:${(p * 100).toFixed(1)}%"></span></div>`;
}

export { shortDate };
