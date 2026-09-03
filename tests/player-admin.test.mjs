import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const ACCOUNTS_KEY = "lucky_accounts_v1";
const SESSION_KEY = "lucky_session_v1";
const SAVE_PREFIX = "lucky_save_v1::";

const browserStorage = new MemoryStorage();
globalThis.window = globalThis;
globalThis.localStorage = browserStorage;

function createPlayerCloudMock() {
  const accounts = new Map();
  const calls = [];
  let sessionUsername = null;

  const publicAccount = (account) => ({
    username: account.username,
    email: account.email,
    displayName: account.displayName,
    avatar: account.avatar,
    color: account.color,
    coins: account.coins,
    createdAt: account.createdAt,
    role: account.role,
  });
  const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
  const ensureTestPlayer = () => {
    if (!accounts.has("test")) {
      accounts.set("test", {
        username: "test",
        email: "test@example.com",
        displayName: "Test",
        avatar: "🍀",
        color: "#a83cff",
        coins: 20000,
        createdAt: "2026-08-01T00:00:00.000Z",
        role: "test",
        password: "1111",
      });
    }
    return accounts.get("test");
  };

  return {
    calls,
    reset() {
      accounts.clear();
      calls.length = 0;
      sessionUsername = null;
    },
    async fetch(input, init = {}) {
      const url = new URL(typeof input === "string" ? input : input.url, "https://lucky.test");
      const method = String(init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, method, body, credentials: init.credentials });

      if (url.pathname === "/api/player/register" && method === "POST") {
        const key = body.username.toLowerCase();
        const duplicateEmail = [...accounts.values()].some((account) => account.email.toLowerCase() === body.email.toLowerCase());
        if (accounts.has(key) || duplicateEmail) return json({ error: "用户名或邮箱已被使用" }, 409);
        const account = {
          username: body.username,
          email: body.email,
          displayName: body.displayName || body.username,
          avatar: body.avatar || "🍀",
          color: body.color || "#a83cff",
          coins: 20000,
          createdAt: new Date().toISOString(),
          role: "player",
          password: body.password,
        };
        accounts.set(key, account);
        sessionUsername = key;
        return json({ authenticated: true, account: publicAccount(account) }, 201);
      }

      if (url.pathname === "/api/player/session" && method === "POST") {
        const identity = String(body.identity || "").toLowerCase();
        const account = identity === "test" || identity === "testplayer"
          ? ensureTestPlayer()
          : [...accounts.values()].find((candidate) => candidate.username.toLowerCase() === identity || candidate.email.toLowerCase() === identity);
        if (!account || account.password !== body.password) return json({ error: "用户名/邮箱或密码不正确" }, 401);
        sessionUsername = account.username.toLowerCase();
        return json({ authenticated: true, account: publicAccount(account) });
      }

      if (url.pathname === "/api/player/password" && method === "POST") {
        const account = sessionUsername ? accounts.get(sessionUsername) : null;
        if (!account) return json({ error: "你尚未登录" }, 401);
        if (account.role === "test") return json({ error: "内置测试玩家密码固定为 1111" }, 422);
        if (account.password !== body.currentPassword) return json({ error: "当前密码不正确" }, 401);
        account.password = body.newPassword;
        return json({ ok: true });
      }

      if (url.pathname === "/api/player/session" && method === "GET") {
        const account = sessionUsername ? accounts.get(sessionUsername) : null;
        return account
          ? json({ authenticated: true, account: publicAccount(account), expiresAt: Date.now() + 60000 })
          : json({ authenticated: false }, 401);
      }

      return json({ error: "Unexpected mocked player API request" }, 500);
    },
  };
}

const playerCloud = createPlayerCloudMock();
globalThis.fetch = playerCloud.fetch;

await import("../public/player-admin.js");
await import("../public/lucky-account.js");
await globalThis.LuckyAuth.ensureTestAccount();

const admin = globalThis.LuckyPlayerAdmin;

function readJson(storage, key) {
  const raw = storage.getItem(key);
  return raw == null ? null : JSON.parse(raw);
}

function seedPlayer({ username = "alice", role = "player", includeSave = true } = {}) {
  const account = {
    username,
    email: `${username}@example.com`,
    displayName: "Alice",
    avatar: "🍀",
    color: "#a83cff",
    role,
    salt: "01".repeat(16),
    hash: "original-hash",
    iterations: 150000,
    coins: 900,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const save = {
    saveVersion: 1,
    revision: 4,
    player: {
      coins: 900,
      level: 3,
      ticketsPlayed: 11,
      totalWon: 800,
      totalSpent: 550,
      selectedTicketId: "classic",
      bestWins: { classic: 200 },
      tutorialSeen: false,
      settings: { sound: true, vibration: true },
      rescueAt: 123456,
      log: [
        { t: 100, k: "buy", a: 100 },
        { t: 200, k: "win", a: 40 },
      ],
      dailyStats: { "2026-08-01": { won: 40, spent: 100 } },
    },
    ticket: { id: "ticket-in-progress", scratched: [1, 2] },
  };
  const initial = {
    [ACCOUNTS_KEY]: JSON.stringify({ [username.toLowerCase()]: account }),
    [SESSION_KEY]: JSON.stringify({ u: username, at: "2026-08-02T00:00:00.000Z" }),
  };
  if (includeSave) initial[SAVE_PREFIX + username.toLowerCase()] = JSON.stringify(save);
  return new MemoryStorage(initial);
}

function completePatch(overrides = {}) {
  return {
    username: "alice",
    email: "alice@example.com",
    displayName: "Alice",
    avatar: "🍀",
    color: "#a83cff",
    coins: 900,
    ticketsPlayed: 11,
    totalWon: 800,
    totalSpent: 550,
    selectedTicketId: "classic",
    bestWins: { classic: 200 },
    tutorialSeen: false,
    sound: true,
    vibration: true,
    rescueReady: false,
    clearHistory: false,
    newPassword: "",
    ...overrides,
  };
}

test("edits all supported player fields without exposing or replacing password secrets", async () => {
  const storage = seedPlayer();
  const beforeAccount = readJson(storage, ACCOUNTS_KEY).alice;

  const result = await admin.updatePlayer(
    "alice",
    completePatch({
      email: "alice.new@example.com",
      displayName: "Lucky Alice",
      avatar: "👑",
      color: "#2ce9d3",
      coins: 1250,
      ticketsPlayed: 19,
      totalWon: 1700,
      totalSpent: 1000,
      selectedTicketId: "royal_100x",
      bestWins: { classic: 450, royal_100x: 1200 },
      tutorialSeen: true,
      sound: false,
      vibration: false,
      rescueReady: true,
      clearHistory: true,
    }),
    storage,
  );

  assert.deepEqual(result, { ok: true, username: "alice", role: "player", hasSave: true });

  const account = readJson(storage, ACCOUNTS_KEY).alice;
  assert.equal(account.email, "alice.new@example.com");
  assert.equal(account.displayName, "Lucky Alice");
  assert.equal(account.avatar, "👑");
  assert.equal(account.color, "#2ce9d3");
  assert.equal(account.coins, 1250);
  assert.equal(account.role, "player");
  assert.equal(account.salt, beforeAccount.salt);
  assert.equal(account.hash, beforeAccount.hash);

  const save = readJson(storage, SAVE_PREFIX + "alice");
  assert.deepEqual(
    {
      coins: save.player.coins,
      ticketsPlayed: save.player.ticketsPlayed,
      level: save.player.level,
      totalWon: save.player.totalWon,
      totalSpent: save.player.totalSpent,
      selectedTicketId: save.player.selectedTicketId,
      bestWins: save.player.bestWins,
      tutorialSeen: save.player.tutorialSeen,
      settings: save.player.settings,
      rescueAt: save.player.rescueAt,
    },
    {
      coins: 1250,
      ticketsPlayed: 19,
      level: 4,
      totalWon: 1700,
      totalSpent: 1000,
      selectedTicketId: "royal_100x",
      bestWins: { classic: 450, royal_100x: 1200 },
      tutorialSeen: true,
      settings: { sound: false, vibration: false },
      rescueAt: 0,
    },
  );
  assert.deepEqual(save.player.dailyStats, {});
  assert.equal(save.player.log.length, 1);
  assert.deepEqual(
    { kind: save.player.log[0].k, amount: save.player.log[0].a, note: save.player.log[0].n },
    { kind: "developer", amount: 350, note: "运营后台编辑余额" },
  );
  assert.deepEqual(save.ticket, { id: "ticket-in-progress", scratched: [1, 2] });
  assert.equal(save.saveVersion, 2);
  assert.equal(save.revision, 5);

  const inspected = admin.inspectPlayer("alice", storage);
  assert.equal(inspected.account.displayName, "Lucky Alice");
  assert.equal(Object.hasOwn(inspected.account, "salt"), false);
  assert.equal(Object.hasOwn(inspected.account, "hash"), false);
});

test("renames a player atomically across account, save, and active session", async () => {
  const storage = seedPlayer();
  const result = await admin.updatePlayer(
    "ALICE",
    completePatch({ username: "Alice_New", email: "alice.new@example.com" }),
    storage,
  );

  assert.equal(result.ok, true);
  assert.equal(result.username, "alice_new");
  const accounts = readJson(storage, ACCOUNTS_KEY);
  assert.equal(accounts.alice, undefined);
  assert.equal(accounts.alice_new.username, "Alice_New");
  assert.equal(storage.getItem(SAVE_PREFIX + "alice"), null);
  assert.equal(readJson(storage, SAVE_PREFIX + "alice_new").player.coins, 900);
  assert.equal(readJson(storage, SESSION_KEY).u, "Alice_New");
});

test("never renames over an orphaned save or into a protected test identity", async () => {
  const storage = seedPlayer();
  storage.setItem(SAVE_PREFIX + "bob", JSON.stringify({ player: { coins: 77 } }));
  const orphanBefore = storage.getItem(SAVE_PREFIX + "bob");

  const collision = await admin.updatePlayer("alice", completePatch({ username: "bob" }), storage);
  assert.deepEqual(collision, { ok: false, error: "该用户名已被占用" });
  assert.equal(storage.getItem(SAVE_PREFIX + "bob"), orphanBefore);
  assert.notEqual(storage.getItem(SAVE_PREFIX + "alice"), null);

  const protectedName = await admin.updatePlayer("alice", completePatch({ username: "testplayer" }), storage);
  assert.deepEqual(protectedName, { ok: false, error: "该用户名不可用" });
});

test("rejects duplicate identity and invalid progress without partially writing data", async () => {
  const storage = seedPlayer();
  const accounts = readJson(storage, ACCOUNTS_KEY);
  accounts.bob = {
    ...accounts.alice,
    username: "bob",
    email: "bob@example.com",
    displayName: "Bob",
  };
  storage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  const before = {
    accounts: storage.getItem(ACCOUNTS_KEY),
    save: storage.getItem(SAVE_PREFIX + "alice"),
    session: storage.getItem(SESSION_KEY),
  };

  const duplicateName = await admin.updatePlayer("alice", completePatch({ username: "bob" }), storage);
  assert.deepEqual(duplicateName, { ok: false, error: "该用户名已被占用" });

  const duplicateEmail = await admin.updatePlayer(
    "alice",
    completePatch({ email: "BOB@example.com" }),
    storage,
  );
  assert.deepEqual(duplicateEmail, { ok: false, error: "该邮箱已被其他账户使用" });

  const badTickets = await admin.updatePlayer(
    "alice",
    completePatch({ ticketsPlayed: -1 }),
    storage,
  );
  assert.equal(badTickets.ok, false);
  assert.match(badTickets.error, /已刮票数/);
  assert.deepEqual(
    {
      accounts: storage.getItem(ACCOUNTS_KEY),
      save: storage.getItem(SAVE_PREFIX + "alice"),
      session: storage.getItem(SESSION_KEY),
    },
    before,
  );
});

test("resets a password with a fresh PBKDF2 secret and keeps it private", async () => {
  const storage = seedPlayer({ includeSave: false });
  const before = readJson(storage, ACCOUNTS_KEY).alice;
  const result = await admin.updatePlayer(
    "alice",
    completePatch({ newPassword: "NewSecure123!" }),
    storage,
  );

  assert.equal(result.ok, true);
  assert.equal(result.hasSave, false);
  const account = readJson(storage, ACCOUNTS_KEY).alice;
  assert.notEqual(account.salt, before.salt);
  assert.notEqual(account.hash, before.hash);
  assert.equal(account.iterations, 150000);
  assert.equal(account.password, undefined);
  assert.equal(storage.getItem(SESSION_KEY), null, "a password reset must revoke the active player session");
  assert.equal(Object.hasOwn(admin.inspectPlayer("alice", storage).account, "hash"), false);
});

test("resets progress and deletes ordinary players, but protects the built-in test player", () => {
  const storage = seedPlayer();
  assert.deepEqual(admin.resetProgress("alice", storage), { ok: true });
  assert.equal(readJson(storage, ACCOUNTS_KEY).alice.coins, admin.START_COINS);
  assert.equal(storage.getItem(SAVE_PREFIX + "alice"), null);

  assert.deepEqual(admin.deletePlayer("alice", storage), { ok: true });
  assert.equal(readJson(storage, ACCOUNTS_KEY).alice, undefined);
  assert.equal(storage.getItem(SESSION_KEY), null);

  const testStorage = seedPlayer({ username: "test", role: "test" });
  assert.deepEqual(admin.deletePlayer("test", testStorage), {
    ok: false,
    error: "内置测试玩家不能删除",
  });
  return admin.updatePlayer("test", completePatch({ username: "test", newPassword: "Changed111" }), testStorage).then((result) => {
    assert.deepEqual(result, { ok: false, error: "内置测试玩家密码固定为 1111" });
  });
});

test("public registration always creates a player account even if a role is supplied", async () => {
  browserStorage.clear();
  playerCloud.reset();
  await globalThis.LuckyAuth.ensureTestAccount();

  const result = await globalThis.LuckyAuth.register({
    username: "NewPlayer",
    email: "new.player@example.com",
    displayName: "New Player",
    password: "Aaaa1111",
    avatar: "💎",
    color: "#ffd76e",
    role: "test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.account.role, "player");
  assert.equal(result.account.coins, 20000);
  assert.equal(Object.hasOwn(result.account, "hash"), false);
  assert.equal(Object.hasOwn(result.account, "salt"), false);

  const stored = readJson(browserStorage, ACCOUNTS_KEY).newplayer;
  assert.equal(stored.role, "player");
  assert.equal(stored.password, undefined);
  assert.equal(stored.hash, undefined, "password hashes must remain server-side");
  assert.equal(stored.salt, undefined, "password salts must remain server-side");
  assert.equal(readJson(browserStorage, SESSION_KEY).u, "NewPlayer");
  assert.equal(globalThis.LuckyAuth.validateUsername("test"), "该用户名不可用");

  const registerRequest = playerCloud.calls.find((call) => call.path === "/api/player/register");
  assert.ok(registerRequest, "registration must use the cloud player API");
  assert.equal(registerRequest.method, "POST");
  assert.equal(registerRequest.credentials, "same-origin");
  assert.equal(registerRequest.body.role, undefined, "the browser must not be able to assign an account role");
});

test("simultaneous public registrations merge without losing either player", async () => {
  browserStorage.clear();
  playerCloud.reset();
  const [alice, bob] = await Promise.all([
    globalThis.LuckyAuth.register({ username: "Alice_2", email: "alice2@example.com", password: "Aaaa1111" }),
    globalThis.LuckyAuth.register({ username: "Bob_2", email: "bob2@example.com", password: "Bbbb2222" }),
  ]);

  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
  const accounts = readJson(browserStorage, ACCOUNTS_KEY);
  assert.equal(accounts.alice_2.role, "player");
  assert.equal(accounts.bob_2.role, "player");
  assert.equal(playerCloud.calls.filter((call) => call.path === "/api/player/register").length, 2);
});

test("test-account seeding and immediate registration preserve both accounts", async () => {
  browserStorage.clear();
  playerCloud.reset();
  const [seeded, player] = await Promise.all([
    globalThis.LuckyAuth.ensureTestAccount(),
    globalThis.LuckyAuth.register({ username: "FastPlayer", email: "fast@example.com", password: "Ffff4444" }),
  ]);

  assert.equal(seeded, true);
  assert.equal(player.ok, true);
  const accounts = readJson(browserStorage, ACCOUNTS_KEY);
  assert.equal(accounts.test.role, "test");
  assert.equal(accounts.fastplayer.role, "player");
});

test("the built-in test account cannot change its fixed password", async () => {
  browserStorage.clear();
  playerCloud.reset();
  await globalThis.LuckyAuth.ensureTestAccount();
  const login = await globalThis.LuckyAuth.login({ identity: "test", password: "1111" });
  assert.equal(login.ok, true);
  assert.deepEqual(await globalThis.LuckyAuth.changePassword("1111", "Changed111"), {
    ok: false,
    error: "内置测试玩家密码固定为 1111",
  });
  assert.deepEqual(
    playerCloud.calls.slice(-2).map((call) => [call.path, call.method]),
    [["/api/player/session", "POST"], ["/api/player/password", "POST"]],
  );
});
