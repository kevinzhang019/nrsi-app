"use client";

import { useEffect, useReducer } from "react";
import type { GameState } from "@/lib/state/game-state";

type Action =
  | { type: "snapshot"; games: GameState[] }
  | { type: "update"; game: GameState };

type State = { byPk: Map<number, GameState>; freshIds: Set<number> };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot": {
      const next = new Map<number, GameState>();
      for (const g of action.games) next.set(g.gamePk, g);
      return { byPk: next, freshIds: new Set() };
    }
    case "update": {
      const next = new Map(state.byPk);
      next.set(action.game.gamePk, action.game);
      const fresh = new Set(state.freshIds);
      fresh.add(action.game.gamePk);
      return { byPk: next, freshIds: fresh };
    }
  }
}

export function useGameStream(initial: GameState[]) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    byPk: new Map(initial.map((g) => [g.gamePk, g])),
    freshIds: new Set<number>(),
  }));

  useEffect(() => {
    // SSE is hosted on the Railway "web" service (see bin/web.ts), not on
    // Vercel — Fluid Compute's per-request provisioned-memory billing makes
    // long-lived connections prohibitively expensive. NEXT_PUBLIC_NRXI_API_BASE
    // is set per-environment on Vercel and falls back to a relative path so
    // local dev can proxy via `vercel dev` if needed.
    const apiBase = process.env.NEXT_PUBLIC_NRXI_API_BASE ?? "";
    const es = new EventSource(`${apiBase}/stream`);
    es.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (Array.isArray(data.games)) dispatch({ type: "snapshot", games: data.games });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("update", (e) => {
      try {
        const game = JSON.parse((e as MessageEvent).data) as GameState;
        dispatch({ type: "update", game });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("error", () => {
      // EventSource auto-reconnects
    });
    return () => es.close();
  }, []);

  return Array.from(state.byPk.values());
}
