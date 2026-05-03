#!/usr/bin/env node
// One-time fetch of all 30 MLB team logos to public/logos/{teamId}.svg.
//
// Usage: npm run build:team-logos
// Sources:
//   teams list: https://statsapi.mlb.com/api/v1/teams?sportId=1
//   logo SVG:   https://www.mlbstatic.com/team-logos/{teamId}.svg

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TEAMS_URL = "https://statsapi.mlb.com/api/v1/teams?sportId=1&activeStatus=Y";
const LOGO_URL = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

const OUT_LOGOS_DIR = resolve(REPO_ROOT, "public/logos");
const OUT_META_PATH = resolve(REPO_ROOT, "lib/teams/team-meta.json");

async function main() {
  console.log(`fetching ${TEAMS_URL}`);
  const teamsRes = await fetch(TEAMS_URL, {
    headers: { "User-Agent": "nrxi-app/0.1 (logo fetch)" },
  });
  if (!teamsRes.ok) {
    throw new Error(`teams fetch failed: ${teamsRes.status} ${teamsRes.statusText}`);
  }
  const teamsJson = await teamsRes.json();
  const teams = (teamsJson.teams ?? []).filter(
    (t) => t?.sport?.id === 1 && typeof t?.id === "number",
  );
  console.log(`got ${teams.length} MLB teams`);
  if (teams.length !== 30) {
    console.warn(`warn: expected 30 MLB teams, got ${teams.length}`);
  }

  mkdirSync(OUT_LOGOS_DIR, { recursive: true });
  mkdirSync(dirname(OUT_META_PATH), { recursive: true });

  const meta = {};
  for (const t of teams) {
    const url = LOGO_URL(t.id);
    process.stdout.write(`  ${String(t.id).padStart(3)}  ${t.name.padEnd(28)} `);
    const res = await fetch(url, {
      headers: { "User-Agent": "nrxi-app/0.1 (logo fetch)" },
    });
    if (!res.ok) {
      console.log(`FAILED ${res.status}`);
      throw new Error(`logo fetch failed for ${t.id}: ${res.status} ${res.statusText}`);
    }
    const svg = await res.text();
    const outPath = resolve(OUT_LOGOS_DIR, `${t.id}.svg`);
    writeFileSync(outPath, svg);
    meta[String(t.id)] = {
      name: t.name,
      abbreviation: t.abbreviation,
      teamCode: t.teamCode,
    };
    console.log(`${(svg.length / 1024).toFixed(1)} KB`);
  }

  const sortedMeta = Object.fromEntries(
    Object.entries(meta).sort(([a], [b]) => Number(a) - Number(b)),
  );
  writeFileSync(OUT_META_PATH, JSON.stringify(sortedMeta, null, 2) + "\n");
  console.log(`wrote ${OUT_META_PATH}`);
  console.log(`done: ${teams.length} logos in ${OUT_LOGOS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
