import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory hash that the mocked redis client reads/writes against. Reset
// in beforeEach so cases don't leak state.
let store: Record<string, unknown> = {};

vi.mock("../../lib/cache/redis", () => ({
  redis: () => ({
    hgetall: async () => (Object.keys(store).length === 0 ? null : { ...store }),
    hdel: async (_key: string, ...fields: string[]) => {
      let n = 0;
      for (const f of fields) {
        if (f in store) {
          delete store[f];
          n += 1;
        }
      }
      return n;
    },
  }),
}));

vi.mock("../../lib/cache/keys", () => ({
  k: { snapshot: () => "nrxi:snapshot" },
}));

import { pruneStaleSnapshots } from "./prune-snapshots";

const TODAY = "2026-05-02";
const YESTERDAY = "2026-05-01";

function row(officialDate: string, gamePk: number) {
  return JSON.stringify({ gamePk, officialDate, status: "Pre" });
}

describe("pruneStaleSnapshots", () => {
  beforeEach(() => {
    store = {};
  });

  it("is a no-op when the hash is empty", async () => {
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    expect(result).toEqual({ total: 0, kept: 0, deleted: 0 });
  });

  it("keeps every row when all officialDates match today", async () => {
    store["100"] = row(TODAY, 100);
    store["200"] = row(TODAY, 200);
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    expect(result).toEqual({ total: 2, kept: 2, deleted: 0 });
    expect(Object.keys(store).sort()).toEqual(["100", "200"]);
  });

  it("deletes every row when all officialDates are older than today", async () => {
    store["100"] = row(YESTERDAY, 100);
    store["200"] = row(YESTERDAY, 200);
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    expect(result).toEqual({ total: 2, kept: 0, deleted: 2 });
    expect(store).toEqual({});
  });

  it("only deletes the older rows in a mixed hash", async () => {
    store["100"] = row(YESTERDAY, 100);
    store["200"] = row(TODAY, 200);
    store["300"] = row(YESTERDAY, 300);
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    expect(result).toEqual({ total: 3, kept: 1, deleted: 2 });
    expect(Object.keys(store)).toEqual(["200"]);
  });

  it("keeps malformed values rather than wiping them (conservative)", async () => {
    store["100"] = "not-json";
    store["200"] = JSON.stringify({ gamePk: 200 }); // no officialDate
    store["300"] = row(TODAY, 300);
    store["400"] = row(YESTERDAY, 400);
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    // Only the dated-yesterday row is removed; malformed + missing-field rows stay.
    expect(result).toEqual({ total: 4, kept: 3, deleted: 1 });
    expect(Object.keys(store).sort()).toEqual(["100", "200", "300"]);
  });

  it("tolerates Upstash auto-parsed objects (object value, not string)", async () => {
    // Upstash auto-parses JSON strings → objects on read; the prune code must
    // handle both shapes.
    store["100"] = { gamePk: 100, officialDate: YESTERDAY };
    store["200"] = { gamePk: 200, officialDate: TODAY };
    const result = await pruneStaleSnapshots({ todayET: TODAY });
    expect(result).toEqual({ total: 2, kept: 1, deleted: 1 });
    expect(Object.keys(store)).toEqual(["200"]);
  });

  it("defaults todayET to America/New_York when not provided", async () => {
    // Sanity check that the function runs without an explicit cutoff. We
    // can't assert deletion without freezing time, but we can assert the
    // call shape and that it returns a result object.
    store["100"] = row("1970-01-01", 100);
    const result = await pruneStaleSnapshots();
    // 1970 is unambiguously before any current date → row gets deleted.
    expect(result.deleted).toBe(1);
    expect(store).toEqual({});
  });
});
