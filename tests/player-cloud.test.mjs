import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const ORIGIN = "http://localhost";
const SIGNING_SECRET = "unit-test-player-session-secret-2026-09-03";
const PLAYER_COOKIE = "__Host-lucky-player-session";

function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return {
    close() { sqlite.close(); },
    get(sql, ...values) { return sqlite.prepare(sql).get(...values); },
    all(sql, ...values) { return sqlite.prepare(sql).all(...values); },
    prepare(sql) {
      const native = sqlite.prepare(sql);
      let values = [];
      const statement = {
        bind(...next) { values = next; return statement; },
        async first(columnName) {
          const row = native.get(...values);
          if (!row) return null;
          return columnName ? row[columnName] : { ...row };
        },
        async run() {
          const result = native.run(...values);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return statement;
    },
  };
}

async function apiFetch(db, path, init = {}, env = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("player-api-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, init),
    {
      DB: db,
      MANAGER_TOKEN: SIGNING_SECRET,
      MANAGER_PASSWORD: "ManagerTest123",
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      ...env,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function sameOriginHeaders(extra = {}) {
  return { origin: ORIGIN, "sec-fetch-site": "same-origin", ...extra };
}

function jsonRequest(method, body, headers = {}) {
  return {
    method,
    headers: sameOriginHeaders({ "content-type": "application/json", ...headers }),
    body: JSON.stringify(body),
  };
}

function readPlayerCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "player response must set a cookie");
  assert.match(setCookie, new RegExp(`^${PLAYER_COOKIE}=`));
  return { setCookie, cookie: setCookie.split(";", 1)[0] };
}

async function register(db, username = "Alice", email = "alice@example.com", password = "AlicePass123", env = {}) {
  return apiFetch(db, "/api/player/register", jsonRequest("POST", {
    username,
    email,
    password,
    displayName: username,
    avatar: "🍀",
    color: "#a83cff",
  }), env);
}

async function login(db, identity, password, env = {}) {
  return apiFetch(db, "/api/player/session", jsonRequest("POST", { identity, password }), env);
}

function makeSave(label, coins) {
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
      log: [{ t: Date.now(), k: "buy", a: 500, n: label }],
    },
    ticket: null,
  };
}

test("registers cloud players with a signed session and no plaintext password", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const response = await register(db);
  assert.equal(response.status, 201);
  const body = await response.clone().json();
  assert.equal(body.authenticated, true);
  assert.equal(body.account.username, "Alice");
  assert.equal(body.account.email, "alice@example.com");
  assert.equal(body.account.role, "player");
  assert.equal("password" in body.account, false);
  const { setCookie, cookie } = readPlayerCookie(response);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);

  const row = db.get("SELECT * FROM player_account WHERE username_normalized = ?", "alice");
  assert.ok(row);
  assert.notEqual(row.password_hash, "AlicePass123");
  assert.equal(JSON.stringify(row).includes("AlicePass123"), false);

  const session = await apiFetch(db, "/api/player/session", { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.username, "Alice");

  const duplicateUsername = await register(db, "alice", "different@example.com", "AnotherPass123");
  assert.equal(duplicateUsername.status, 409);
  const duplicateEmail = await register(db, "Different", "ALICE@example.com", "AnotherPass123");
  assert.equal(duplicateEmail.status, 409);
});

test("logs in case-insensitively and fails closed for bad or cross-origin credentials", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  await register(db);
  const byUsername = await login(db, "aLiCe", "AlicePass123");
  assert.equal(byUsername.status, 200);
  const byEmail = await login(db, "ALICE@EXAMPLE.COM", "AlicePass123");
  assert.equal(byEmail.status, 200);
  const wrongUser = await login(db, "missing", "AlicePass123");
  const wrongPassword = await login(db, "Alice", "wrong-password");
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongUser.json()).error, (await wrongPassword.json()).error);

  const crossOrigin = await apiFetch(db, "/api/player/session", {
    method: "POST",
    headers: { origin: "https://example.com", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ identity: "Alice", password: "AlicePass123" }),
  });
  assert.equal(crossOrigin.status, 403);
});

test("synchronizes two devices and rejects a stale device without overwriting the latest save", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const deviceA = readPlayerCookie(await register(db)).cookie;
  const deviceB = readPlayerCookie(await login(db, "alice@example.com", "AlicePass123")).cookie;
  assert.notEqual(deviceA, deviceB);

  const empty = await apiFetch(db, "/api/player/save", { headers: { cookie: deviceA } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { save: null, revision: 0, updatedAt: 0 });

  const saveA = makeSave("phone-1", 19_500);
  const writeA = await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: 0, save: saveA }, { cookie: deviceA }));
  assert.equal(writeA.status, 200);
  assert.equal((await writeA.clone().json()).revision, 1);

  const phone2Read = await apiFetch(db, "/api/player/save", { headers: { cookie: deviceB } });
  assert.equal(phone2Read.status, 200);
  assert.deepEqual((await phone2Read.json()).save, saveA);

  const saveB = makeSave("phone-2", 19_000);
  const writeB = await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: 1, save: saveB }, { cookie: deviceB }));
  assert.equal(writeB.status, 200);
  assert.equal((await writeB.json()).revision, 2);

  const staleA = await apiFetch(db, "/api/player/save", jsonRequest("PUT", {
    baseRevision: 1,
    save: makeSave("stale-phone-1", 999_999),
  }, { cookie: deviceA }));
  assert.equal(staleA.status, 409);
  const conflict = await staleA.json();
  assert.equal(conflict.revision, 2);
  assert.deepEqual(conflict.save, saveB);

  const finalRead = await apiFetch(db, "/api/player/save", { headers: { cookie: deviceA } });
  assert.equal(finalRead.status, 200);
  const final = await finalRead.json();
  assert.equal(final.revision, 2);
  assert.deepEqual(final.save, saveB);
  assert.equal(db.get("SELECT revision FROM player_save").revision, 2);
});

test("uses one shared cloud identity for the built-in test player", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const reservedEmail = await register(db, "NotTheTest", "test@example.com", "SafePassword123");
  assert.equal(reservedEmail.status, 422);
  assert.equal((await reservedEmail.json()).code, "reserved_email");
  const first = await login(db, "test", "1111");
  const second = await login(db, "TEST@EXAMPLE.COM", "1111");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.clone().json()).account.role, "test");
  assert.equal(db.all("SELECT id FROM player_account WHERE username_normalized = 'test'").length, 1);
  const firstCookie = readPlayerCookie(first).cookie;
  const secondCookie = readPlayerCookie(second).cookie;
  const shared = makeSave("shared-test", 12_345);
  const written = await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: 0, save: shared }, { cookie: firstCookie }));
  assert.equal(written.status, 200);
  const readBySecond = await apiFetch(db, "/api/player/save", { headers: { cookie: secondCookie } });
  assert.equal(readBySecond.status, 200);
  assert.deepEqual((await readBySecond.json()).save, shared);
});

test("password verification survives rotation of the session-signing secret", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const firstSecret = "first-player-session-secret-for-rotation-test";
  const secondSecret = "second-player-session-secret-for-rotation-test";
  const registered = await register(db, "RotateMe", "rotate@example.com", "RotatePass123", { PLAYER_SESSION_SECRET: firstSecret });
  assert.equal(registered.status, 201);
  const oldCookie = readPlayerCookie(registered).cookie;

  const expiredSession = await apiFetch(db, "/api/player/session", { headers: { cookie: oldCookie } }, { PLAYER_SESSION_SECRET: secondSecret });
  assert.equal(expiredSession.status, 401, "rotating the signer invalidates old sessions");
  const freshLogin = await login(db, "RotateMe", "RotatePass123", { PLAYER_SESSION_SECRET: secondSecret });
  assert.equal(freshLogin.status, 200, "password hashes stay usable after signer rotation");
});

test("isolates player saves and validates authenticated writes", async (t) => {
  const db = createD1();
  t.after(() => db.close());
  const alice = readPlayerCookie(await register(db)).cookie;
  const bob = readPlayerCookie(await register(db, "Bobby", "bob@example.com", "BobbyPass123")).cookie;
  const aliceSave = makeSave("alice-only", 2_000);
  assert.equal((await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: 0, save: aliceSave }, { cookie: alice }))).status, 200);
  const bobRead = await apiFetch(db, "/api/player/save", { headers: { cookie: bob } });
  assert.deepEqual(await bobRead.json(), { save: null, revision: 0, updatedAt: 0 });

  const anonymous = await apiFetch(db, "/api/player/save");
  assert.equal(anonymous.status, 401);
  const badRevision = await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: -1, save: aliceSave }, { cookie: alice }));
  assert.equal(badRevision.status, 422);
  const badShape = await apiFetch(db, "/api/player/save", jsonRequest("PUT", { baseRevision: 1, save: { player: null } }, { cookie: alice }));
  assert.equal(badShape.status, 422);
  const crossOrigin = await apiFetch(db, "/api/player/save", {
    method: "PUT",
    headers: { cookie: alice, origin: "https://example.com", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 1, save: aliceSave }),
  });
  assert.equal(crossOrigin.status, 403);
});
