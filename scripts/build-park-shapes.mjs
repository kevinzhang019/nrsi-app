#!/usr/bin/env node
// Builds lib/parks/shapes.json from GeomMLBStadiums polygon CSV.
//
// Usage: npm run build:park-shapes
// Source: https://github.com/bdilday/GeomMLBStadiums

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CSV_URL =
  "https://raw.githubusercontent.com/bdilday/GeomMLBStadiums/master/inst/extdata/mlb_stadia_paths.csv";

// Segments that form the recognizable park silhouette.
// foul_lines = the wedge from home plate to outfield corners.
// outfield_outer = the outfield wall.
// Skip infield/mound/home_plate at small sizes — they collapse into noise.
const KEEP_SEGMENTS = new Set(["foul_lines", "outfield_outer"]);

// Output viewBox is 100 x 100 with 4-unit padding so strokes don't clip.
const VIEW_SIZE = 100;
const PAD = 4;

async function main() {
  const teamToVenueModule = await import(
    pathToFileURL(resolve(REPO_ROOT, "lib/parks/team-to-venue.ts")).href
  ).catch(() => null);

  // tsx isn't a dep — read the file as text and eval-extract the maps instead.
  const { readFileSync } = await import("node:fs");
  const teamToVenueSrc = readFileSync(
    resolve(REPO_ROOT, "lib/parks/team-to-venue.ts"),
    "utf8",
  );
  const TEAM_TO_VENUE_ID = parseRecordLiteral(teamToVenueSrc, "TEAM_TO_VENUE_ID");
  const VENUE_ID_TO_NAME = parseRecordLiteral(teamToVenueSrc, "VENUE_ID_TO_NAME");

  console.log(`fetching ${CSV_URL}`);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const csv = await res.text();
  console.log(`got ${csv.length.toLocaleString()} bytes`);

  const rows = parseCsv(csv);
  console.log(`parsed ${rows.length.toLocaleString()} rows`);

  // Group by team → segment → ordered (x, y) points.
  /** @type {Map<string, Map<string, Array<[number, number]>>>} */
  const byTeam = new Map();
  for (const r of rows) {
    if (!KEEP_SEGMENTS.has(r.segment)) continue;
    if (!byTeam.has(r.team)) byTeam.set(r.team, new Map());
    const segs = byTeam.get(r.team);
    if (!segs.has(r.segment)) segs.set(r.segment, []);
    segs.get(r.segment).push([r.x, r.y]);
  }

  /** @type {Record<string, { name: string; viewBox: string; d: string }>} */
  const out = {};
  let skipped = 0;
  for (const [team, segs] of byTeam) {
    const venueId = TEAM_TO_VENUE_ID[team];
    if (venueId == null) {
      if (team !== "generic") console.warn(`  skip ${team}: no venueId`);
      skipped += 1;
      continue;
    }
    const name = VENUE_ID_TO_NAME[venueId] ?? team;
    const allPoints = [];
    for (const pts of segs.values()) allPoints.push(...pts);
    if (allPoints.length === 0) {
      console.warn(`  skip ${team}: no points kept`);
      skipped += 1;
      continue;
    }

    // Bounding box across kept points
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [x, y] of allPoints) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const inner = VIEW_SIZE - 2 * PAD;
    const scale = Math.min(inner / w, inner / h);
    // Center the polygon inside the padded viewBox
    const offX = (VIEW_SIZE - w * scale) / 2;
    const offY = (VIEW_SIZE - h * scale) / 2;

    const tx = (x) => round(offX + (x - minX) * scale);
    // Flip y so home plate (low CSV y) sits at the BOTTOM of the SVG
    const ty = (y) => round(VIEW_SIZE - (offY + (y - minY) * scale));

    const parts = [];
    // Draw foul_lines first so they connect home plate to the corners,
    // then outfield_outer as a separate sub-path.
    const order = ["foul_lines", "outfield_outer"];
    for (const segName of order) {
      const pts = segs.get(segName);
      if (!pts || pts.length === 0) continue;
      const cmds = [];
      cmds.push(`M${tx(pts[0][0])} ${ty(pts[0][1])}`);
      for (let i = 1; i < pts.length; i += 1) {
        cmds.push(`L${tx(pts[i][0])} ${ty(pts[i][1])}`);
      }
      parts.push(cmds.join(""));
    }

    out[String(venueId)] = {
      name,
      viewBox: `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`,
      d: parts.join(" "),
    };
  }

  // Sort keys numerically for deterministic output.
  const sorted = Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)),
  );

  const outPath = resolve(REPO_ROOT, "lib/parks/shapes.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `\nwrote ${outPath} (${Object.keys(sorted).length} parks, ${skipped} skipped)`,
  );
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const idx = {
    team: header.indexOf("team"),
    x: header.indexOf("x"),
    y: header.indexOf("y"),
    segment: header.indexOf("segment"),
  };
  if (Object.values(idx).some((i) => i < 0)) {
    throw new Error(`unexpected CSV header: ${header.join(",")}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cells = parseCsvLine(line);
    const x = Number(cells[idx.x]);
    const y = Number(cells[idx.y]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    rows.push({
      team: cells[idx.team],
      x,
      y,
      segment: cells[idx.segment],
    });
  }
  return rows;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
    } else if (c === "," && !inQ) {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseRecordLiteral(src, name) {
  // Crude but sufficient: extract the object literal that follows
  // `export const NAME: ... = { ... };`
  const re = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\};`,
    "m",
  );
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from team-to-venue.ts`);
  const body = m[1];
  /** @type {Record<string, number | string>} */
  const obj = {};
  // Match `key: value,` ignoring comment-only lines
  const lineRe = /^\s*([A-Za-z0-9_]+)\s*:\s*(?:"([^"]*)"|(\d+))\s*,?\s*(?:\/\/.*)?$/;
  for (const line of body.split(/\r?\n/)) {
    const lm = line.match(lineRe);
    if (!lm) continue;
    const key = lm[1];
    const val = lm[2] !== undefined ? lm[2] : Number(lm[3]);
    obj[key] = val;
  }
  return obj;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
