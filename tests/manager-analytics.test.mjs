import assert from "node:assert/strict";
import test from "node:test";

await import("../public/player-analytics.js");

const analytics = globalThis.LuckyManagerAnalytics;
const dayOne = Date.parse("2026-08-30T10:00:00+08:00");
const dayTwo = Date.parse("2026-08-31T10:00:00+08:00");

test("summarises each player's lifetime winnings, spend, loss, and net", () => {
  const alice = analytics.summarisePlayer(
    "alice",
    { displayName: "Alice" },
    { player: { coins: 800, level: 3, ticketsPlayed: 9, totalWon: 620, totalSpent: 500, log: [] } },
  );
  const bob = analytics.summarisePlayer(
    "bob",
    null,
    { player: { totalWon: 50, totalSpent: 400, log: [] } },
  );

  assert.deepEqual(
    { name: alice.displayName, won: alice.won, spent: alice.spent, loss: alice.loss, net: alice.net },
    { name: "Alice", won: 620, spent: 500, loss: 0, net: 120 },
  );
  assert.deepEqual(
    { name: bob.displayName, won: bob.won, spent: bob.spent, loss: bob.loss, net: bob.net },
    { name: "bob", won: 50, spent: 400, loss: 350, net: -350 },
  );
});

test("groups daily winnings and ticket spend while ignoring top-ups and developer credits", () => {
  const players = [
    {
      log: [
        { t: dayOne, k: "buy", a: 300 },
        { t: dayOne, k: "win", a: 120 },
        { t: dayTwo, k: "buy", a: 200 },
        { t: dayTwo, k: "win", a: 500 },
        { t: dayTwo, k: "topup", a: 1000 },
      ],
    },
    {
      log: [
        { t: dayOne, k: "buy", a: 150 },
        { t: dayTwo, k: "buy", a: 250 },
        { t: dayTwo, k: "win", a: 50 },
        { t: dayTwo, k: "developer", a: 999 },
      ],
    },
  ];

  assert.deepEqual(
    analytics.aggregateDailyPlayerActivity(players, { dayCount: 2, now: dayTwo }),
    [
      { key: "2026-08-30", label: "08/30", won: 120, spent: 450 },
      { key: "2026-08-31", label: "08/31", won: 550, spent: 450 },
    ],
  );
});

test("prefers durable daily rollups and falls back to legacy logs for missing days", () => {
  const player = {
    dailyStats: { "2026-08-31": { won: 700, spent: 250 } },
    log: [
      { t: dayOne, k: "buy", a: 100 },
      { t: dayOne, k: "win", a: 40 },
      { t: dayTwo, k: "buy", a: 999 },
      { t: dayTwo, k: "win", a: 999 },
    ],
  };

  assert.deepEqual(
    analytics.aggregateDailyPlayerActivity([player], { dayCount: 2, now: dayTwo }),
    [
      { key: "2026-08-30", label: "08/30", won: 40, spent: 100 },
      { key: "2026-08-31", label: "08/31", won: 700, spent: 250 },
    ],
  );
});
