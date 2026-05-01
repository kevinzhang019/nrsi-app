// Maps GeomMLBStadiums CSV team slug to MLB Stats API venueId.
// Source: https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026
// Polygon source: https://raw.githubusercontent.com/bdilday/GeomMLBStadiums/master/inst/extdata/mlb_stadia_paths.csv
//
// Notes:
//   - athletics → Sutter Health Park (2529): polygon is for the Oakland Coliseum;
//     close enough to recognize as A's, accuracy is approximate post-relocation.
//   - rays → Tropicana Field (12): polygon is Tropicana; if Rays continue at
//     Steinbrenner Field, shape is approximate for the season.

export const TEAM_TO_VENUE_ID: Record<string, number> = {
  angels: 1,
  astros: 2392,
  athletics: 2529,
  blue_jays: 14,
  braves: 4705,
  brewers: 32,
  cardinals: 2889,
  cubs: 17,
  diamondbacks: 15,
  dodgers: 22,
  giants: 2395,
  guardians: 5,
  mariners: 680,
  marlins: 4169,
  mets: 3289,
  nationals: 3309,
  orioles: 2,
  padres: 2680,
  phillies: 2681,
  pirates: 31,
  rangers: 5325,
  rays: 12,
  red_sox: 3,
  reds: 2602,
  rockies: 19,
  royals: 7,
  tigers: 2394,
  twins: 3312,
  white_sox: 4,
  yankees: 3313,
};

export const VENUE_ID_TO_NAME: Record<number, string> = {
  1: "Angel Stadium",
  2: "Oriole Park at Camden Yards",
  3: "Fenway Park",
  4: "Rate Field",
  5: "Progressive Field",
  7: "Kauffman Stadium",
  12: "Tropicana Field",
  14: "Rogers Centre",
  15: "Chase Field",
  17: "Wrigley Field",
  19: "Coors Field",
  22: "Dodger Stadium",
  31: "PNC Park",
  32: "American Family Field",
  680: "T-Mobile Park",
  2392: "Daikin Park",
  2394: "Comerica Park",
  2395: "Oracle Park",
  2529: "Sutter Health Park",
  2602: "Great American Ball Park",
  2680: "Petco Park",
  2681: "Citizens Bank Park",
  2889: "Busch Stadium",
  3289: "Citi Field",
  3309: "Nationals Park",
  3312: "Target Field",
  3313: "Yankee Stadium",
  4169: "loanDepot park",
  4705: "Truist Park",
  5325: "Globe Life Field",
};
