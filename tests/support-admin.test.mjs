import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const ORIGIN = "http://localhost";
const MANAGER_TOKEN = "unit-test-manager-token-long-enough-2026";
const MANAGER_PASSWORD = "ManagerTest123";

function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const d1 = {
    close() { sqlite.close(); },
    get(sql, ...values) { return sqlite.prepare(sql).get(...values); },
    prepare(sql) {
      const native = sqlite.prepare(sql);
      const readsRows = /^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql);
      let values = [];
      const statement = {
        bind(...next) { values = next; return statement; },
        async first(columnName) {
          const row = native.get(...values);
          if (!row) return null;
          return columnName ? row[columnName] : { ...row };
        },
        async all() {
          return { success: true, results: native.all(...values).map((row) => ({ ...row })) };
        },
        async run() {
          if (readsRows) {
            return { success: true, results: native.all(...values).map((row) => ({ ...row })), meta: { changes: 0 } };
          }
          const result = native.run(...values);
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return d1;
}

async function createApi(db) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("support-admin-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = {
    DB: db,
    MANAGER_TOKEN,
    MANAGER_PASSWORD,
    PLAYER_SESSION_SECRET: "unit-test-player-session-secret-long-enough",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  return (path, init = {}) => worker.fetch(
    new Request(`${ORIGIN}${path}`, init),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function sameOriginHeaders(extra = {}) {
  return { origin: ORIGIN, "sec-fetch-site": "same-origin", ...extra };
}

function jsonRequest(method, body, cookie) {
  return {
    method,
    headers: sameOriginHeaders({
      accept: "application/json",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    }),
    body: JSON.stringify(body),
  };
}

function responseCookie(response, name) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, `${name} cookie must be set`);
  const cookie = header.split(";", 1)[0];
  assert.match(cookie, new RegExp(`^${name}=`));
  return cookie;
}

async function registerPlayer(api) {
  const response = await api("/api/player/register", jsonRequest("POST", {
    username: "Reporter",
    email: "reporter@example.com",
    password: "ReporterPass123",
    displayName: "Reporter Player",
    avatar: "🍀",
    color: "#a83cff",
  }));
  assert.equal(response.status, 201);
  return responseCookie(response, "__Host-lucky-player-session");
}

async function loginPlayer(api, identity, password) {
  const response = await api("/api/player/session", jsonRequest("POST", { identity, password }));
  assert.equal(response.status, 200);
  return responseCookie(response, "__Host-lucky-player-session");
}

async function loginOwner(api) {
  const response = await api("/api/manager/session", jsonRequest("POST", {
    username: "Admin",
    password: MANAGER_PASSWORD,
  }));
  assert.equal(response.status, 200);
  return responseCookie(response, "__Host-lucky-manager-session");
}

function playerSave(coins = 2_000) {
  return {
    saveVersion: 2,
    updatedAt: Date.now(),
    player: {
      coins,
      level: 1,
      ticketsPlayed: 1,
      selectedTicketId: "starter_100x",
      bestWins: {},
      lastDaily: "",
      rescueAt: 0,
      tutorialSeen: true,
      settings: { sound: true, vibration: true },
      totalSpent: 500,
      totalWon: 0,
      dailyStats: {},
      log: [{ t: Date.now(), k: "buy", a: 500, n: "test ticket" }],
    },
    ticket: null,
  };
}

test("player support and report records are authenticated, idempotent, and replyable", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const api = await createApi(db);
  const playerCookie = await registerPlayer(api);

  const submission = {
    requestId: "support-request-001",
    kind: "support",
    category: "gameplay",
    message: "My scratch card stopped responding on the second tile.",
  };
  const created = await api("/api/player/support", jsonRequest("POST", submission, playerCookie));
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.duplicate, false);
  assert.equal(createdBody.ticket.status, "open");

  const duplicate = await api("/api/player/support", jsonRequest("POST", submission, playerCookie));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM player_support_ticket").count, 1);

  const conflictingReplay = await api("/api/player/support", jsonRequest("POST", {
    ...submission,
    message: "Different content with the same request id.",
  }, playerCookie));
  assert.equal(conflictingReplay.status, 409);

  const anonymous = await api("/api/player/support");
  assert.equal(anonymous.status, 401);
  const crossOrigin = await api("/api/player/support", {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ ...submission, requestId: "support-request-002" }),
  });
  assert.equal(crossOrigin.status, 403);

  const managerCookie = await loginOwner(api);
  const inbox = await api("/api/manager/support?kind=support&status=open&limit=20", { headers: { cookie: managerCookie, accept: "application/json" } });
  assert.equal(inbox.status, 200);
  const tickets = (await inbox.json()).tickets;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].player.username, "Reporter");
  assert.equal(tickets[0].player.email, "reporter@example.com");

  const resolvedWithoutReply = await api("/api/manager/support", jsonRequest("PATCH", {
    id: createdBody.ticket.id,
    status: "resolved",
    reply: null,
  }, managerCookie));
  assert.equal(resolvedWithoutReply.status, 422);

  const replied = await api("/api/manager/support", jsonRequest("PATCH", {
    id: createdBody.ticket.id,
    status: "resolved",
    reply: "Thanks — the issue has been received and reviewed.",
  }, managerCookie));
  assert.equal(replied.status, 200);
  assert.equal((await replied.json()).ticket.status, "resolved");

  const playerHistory = await api("/api/player/support", { headers: { cookie: playerCookie, accept: "application/json" } });
  assert.equal(playerHistory.status, 200);
  const playerTickets = (await playerHistory.json()).tickets;
  assert.equal(playerTickets[0].reply, "Thanks — the issue has been received and reviewed.");
  assert.equal(playerTickets[0].status, "resolved");
});

test("the shared test account cannot expose private support or report history", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const api = await createApi(db);
  const testCookie = await loginPlayer(api, "test", "1111");

  const history = await api("/api/player/support", {
    headers: { cookie: testCookie, accept: "application/json" },
  });
  assert.equal(history.status, 403);
  assert.equal((await history.json()).code, "shared_test_account");

  for (const kind of ["support", "report"]) {
    const submission = await api("/api/player/support", jsonRequest("POST", {
      requestId: `shared-test-${kind}`,
      kind,
      category: kind === "support" ? "account" : "player",
      message: `This ${kind} must not be stored on a shared account.`,
    }, testCookie));
    assert.equal(submission.status, 403);
    assert.equal((await submission.json()).code, "shared_test_account");
  }
});

test("only the owner can create and disable independently authenticated admin profiles", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const api = await createApi(db);
  const ownerCookie = await loginOwner(api);

  const initial = await api("/api/manager/admins", { headers: { cookie: ownerCookie, accept: "application/json" } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).admins[0].role, "owner");

  const created = await api("/api/manager/admins", jsonRequest("POST", {
    username: "Support01",
    password: "SupportPass123",
    currentPassword: MANAGER_PASSWORD,
  }, ownerCookie));
  assert.equal(created.status, 201);
  const admin = (await created.json()).admin;
  assert.equal(admin.role, "admin");
  assert.equal(admin.active, true);

  const secondaryLogin = await api("/api/manager/session", jsonRequest("POST", {
    username: "support01",
    password: "SupportPass123",
  }));
  assert.equal(secondaryLogin.status, 200);
  const secondaryCookie = responseCookie(secondaryLogin, "__Host-lucky-manager-session");
  const secondarySession = await api("/api/manager/session", { headers: { cookie: secondaryCookie, accept: "application/json" } });
  assert.equal(secondarySession.status, 200);
  assert.equal((await secondarySession.json()).role, "admin");

  const forbiddenCreate = await api("/api/manager/admins", jsonRequest("POST", {
    username: "Escalated",
    password: "EscalatedPass123",
    currentPassword: "SupportPass123",
  }, secondaryCookie));
  assert.equal(forbiddenCreate.status, 403);

  const disabled = await api("/api/manager/admins", jsonRequest("PATCH", {
    managerId: admin.managerId,
    active: false,
    currentPassword: MANAGER_PASSWORD,
  }, ownerCookie));
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).admin.active, false);

  const invalidated = await api("/api/manager/session", { headers: { cookie: secondaryCookie, accept: "application/json" } });
  assert.equal(invalidated.status, 401);
  const disabledLogin = await api("/api/manager/session", jsonRequest("POST", {
    username: "Support01",
    password: "SupportPass123",
  }));
  assert.equal(disabledLogin.status, 401);
});

test("manager player edits update the authoritative cloud save with revision protection", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const api = await createApi(db);
  const playerCookie = await registerPlayer(api);
  const firstSave = await api("/api/player/save", jsonRequest("PUT", {
    baseRevision: 0,
    save: playerSave(),
  }, playerCookie));
  assert.equal(firstSave.status, 200);

  const managerCookie = await loginOwner(api);
  const listed = await api("/api/manager/players", { headers: { cookie: managerCookie, accept: "application/json" } });
  assert.equal(listed.status, 200);
  const summary = (await listed.json()).players.find((player) => player.username === "Reporter");
  assert.ok(summary);
  assert.equal(Object.hasOwn(summary, "save"), false, "the player list must not return full cloud saves");
  assert.equal(summary.summary.balance, 2_000);
  assert.equal(summary.summary.tickets, 1);
  assert.deepEqual(summary.summary.log, []);
  assert.equal(summary.revision, 1);

  const detail = await api("/api/manager/players?username=Reporter", {
    headers: { cookie: managerCookie, accept: "application/json" },
  });
  assert.equal(detail.status, 200);
  const original = (await detail.json()).player;
  assert.equal(original.account.email, "reporter@example.com");
  assert.equal(original.save.player.coins, 2_000);
  assert.equal(original.save.player.log[0].n, "test ticket");
  assert.equal(original.revision, 1);

  const edited = await api("/api/manager/players", jsonRequest("PATCH", {
    targetUsername: "Reporter",
    expectedRevision: 1,
    displayName: "Updated Reporter",
    coins: 7_777,
    sound: false,
    vibration: false,
  }, managerCookie));
  assert.equal(edited.status, 200);
  const updated = (await edited.json()).player;
  assert.equal(updated.account.displayName, "Updated Reporter");
  assert.equal(updated.save.player.coins, 7_777);
  assert.deepEqual(updated.save.player.settings, { sound: false, vibration: false });
  assert.equal(updated.revision, 2);

  const stale = await api("/api/manager/players", jsonRequest("PATCH", {
    targetUsername: "Reporter",
    expectedRevision: 1,
    coins: 99_999,
  }, managerCookie));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "revision_conflict");
  assert.equal(JSON.parse(db.get("SELECT save_json AS saveJson FROM player_save").saveJson).player.coins, 7_777);

  const reset = await api("/api/manager/players", jsonRequest("PATCH", {
    targetUsername: "Reporter",
    expectedRevision: 2,
    action: "reset",
  }, managerCookie));
  assert.equal(reset.status, 200);
  const resetPlayer = (await reset.json()).player;
  assert.equal(resetPlayer.revision, 3, "reset must advance the authoritative save revision");
  assert.equal(resetPlayer.save.player.coins, 20_000);
  assert.equal(resetPlayer.save.player.ticketsPlayed, 0);
  assert.equal(resetPlayer.save.player.totalSpent, 0);
  assert.equal(resetPlayer.save.player.totalWon, 0);
  assert.deepEqual(resetPlayer.save.player.log, []);
  assert.equal(db.get("SELECT auth_revision AS authRevision FROM player_account").authRevision, 2);

  const invalidatedSession = await api("/api/player/session", {
    headers: { cookie: playerCookie, accept: "application/json" },
  });
  assert.equal(invalidatedSession.status, 401, "reset must invalidate sessions holding the old account revision");
  const invalidatedReplay = await api("/api/player/save", jsonRequest("PUT", {
    baseRevision: 2,
    save: playerSave(999_999),
  }, playerCookie));
  assert.equal(invalidatedReplay.status, 401, "an invalidated device cannot replay its cached save");

  const refreshedCookie = await loginPlayer(api, "Reporter", "ReporterPass123");
  const staleDeviceReplay = await api("/api/player/save", jsonRequest("PUT", {
    baseRevision: 2,
    save: playerSave(999_999),
  }, refreshedCookie));
  assert.equal(staleDeviceReplay.status, 409);
  const resetConflict = await staleDeviceReplay.json();
  assert.equal(resetConflict.code, "revision_conflict");
  assert.equal(resetConflict.revision, 3);
  assert.equal(resetConflict.save.player.coins, 20_000);
  assert.equal(JSON.parse(db.get("SELECT save_json AS saveJson FROM player_save").saveJson).player.coins, 20_000);

  const deleted = await api("/api/manager/players", jsonRequest("DELETE", {
    targetUsername: "Reporter",
    expectedRevision: 3,
  }, managerCookie));
  assert.equal(deleted.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM player_account").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM player_save").count, 0);
});

test("manager can delete a newly registered player before the first cloud save", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const api = await createApi(db);
  await registerPlayer(api);
  const managerCookie = await loginOwner(api);

  const detail = await api("/api/manager/players?username=Reporter", {
    headers: { cookie: managerCookie, accept: "application/json" },
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).player.revision, 0);

  const deleted = await api("/api/manager/players", jsonRequest("DELETE", {
    targetUsername: "Reporter",
    expectedRevision: 0,
  }, managerCookie));
  assert.equal(deleted.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM player_account").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM player_save").count, 0);
});
