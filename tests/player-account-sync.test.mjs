import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  constructor() {
    this.values = new Map();
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const storage = new MemoryStorage();
let fetchHandler = async () => json({ error: "Unexpected mocked request" }, 500);

globalThis.window = globalThis;
globalThis.localStorage = storage;
globalThis.fetch = (...args) => fetchHandler(...args);

await import(`../public/lucky-account.js?sync-races=${Date.now()}`);
await globalThis.LuckyAuth.ensureTestAccount();

const SAVE_KEY = "lucky_save_v1::alice";
const REVISION_KEY = "lucky_save_revision_v1::alice";
const DIRTY_KEY = "lucky_save_dirty_v1::alice";
const SESSION_KEY = "lucky_session_v1";

function makeSave({ coins = 100, sound = true, vibration = true } = {}) {
  return {
    saveVersion: 2,
    updatedAt: 1,
    player: {
      coins,
      level: 1,
      ticketsPlayed: 0,
      totalWon: 0,
      totalSpent: 0,
      bestWins: {},
      log: [],
      dailyStats: {},
      settings: { sound, vibration },
    },
    ticket: null,
  };
}

function seed(save, revision, dirty) {
  storage.clear();
  storage.setItem(SESSION_KEY, JSON.stringify({ u: "Alice" }));
  storage.setItem("lucky_accounts_v1", JSON.stringify({
    alice: {
      username: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      avatar: "🍀",
      color: "#a83cff",
      role: "player",
      coins: 20000,
    },
  }));
  storage.setItem(SAVE_KEY, JSON.stringify(save));
  storage.setItem(REVISION_KEY, String(revision));
  if (dirty) storage.setItem(DIRTY_KEY, "1");
}

test("a 409 response never overwrites a newer local save and retries it", async () => {
  const sent = makeSave({ coins: 100, sound: false });
  const newer = makeSave({ coins: 777, sound: false, vibration: false });
  const remote = makeSave({ coins: 500, sound: true, vibration: true });
  seed(sent, 1, true);

  const firstPutStarted = deferred();
  const releaseFirstPut = deferred();
  const puts = [];
  fetchHandler = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url, "https://lucky.test").pathname;
    const method = String(init.method || "GET").toUpperCase();
    assert.equal(path, "/api/player/save");
    assert.equal(method, "PUT");
    const body = JSON.parse(String(init.body));
    puts.push(body);
    if (puts.length === 1) {
      firstPutStarted.resolve();
      await releaseFirstPut.promise;
      return json({ error: "云存档已更新", save: remote, revision: 2, updatedAt: 2 }, 409);
    }
    return json({ save: body.save, revision: 3, updatedAt: 3 });
  };

  const syncing = globalThis.LuckyAuth.syncGameSave();
  await firstPutStarted.promise;
  storage.setItem(SAVE_KEY, JSON.stringify(newer));
  storage.setItem(DIRTY_KEY, "1");
  releaseFirstPut.resolve();

  const result = await syncing;
  assert.equal(result.ok, true);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].baseRevision, 1);
  assert.equal(puts[1].baseRevision, 2);
  assert.deepEqual(puts[1].save, newer);
  assert.deepEqual(JSON.parse(storage.getItem(SAVE_KEY)), newer);
  assert.equal(storage.getItem(REVISION_KEY), "3");
  assert.equal(storage.getItem(DIRTY_KEY), null);
});

test("a GET refresh preserves and uploads a save changed while GET was pending", async () => {
  const before = makeSave({ coins: 100 });
  const newer = makeSave({ coins: 222, sound: false });
  const remote = makeSave({ coins: 150 });
  seed(before, 1, false);

  const getStarted = deferred();
  const releaseGet = deferred();
  const puts = [];
  fetchHandler = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url, "https://lucky.test").pathname;
    const method = String(init.method || "GET").toUpperCase();
    assert.equal(path, "/api/player/save");
    if (method === "GET") {
      getStarted.resolve();
      await releaseGet.promise;
      return json({ save: remote, revision: 2, updatedAt: 2 });
    }
    assert.equal(method, "PUT");
    const body = JSON.parse(String(init.body));
    puts.push(body);
    return json({ save: body.save, revision: 3, updatedAt: 3 });
  };

  const refreshing = globalThis.LuckyAuth.refreshGameSave();
  await getStarted.promise;
  storage.setItem(SAVE_KEY, JSON.stringify(newer));
  storage.setItem(DIRTY_KEY, "1");
  releaseGet.resolve();

  const refreshed = await refreshing;
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.pending, true);
  assert.deepEqual(refreshed.save, newer);
  // Wait behind the upload queued by refreshGameSave(). A clean queue pass is
  // skipped, so this does not create a second network write.
  await globalThis.LuckyAuth.syncGameSave();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].baseRevision, 2);
  assert.deepEqual(puts[0].save, newer);
  assert.deepEqual(JSON.parse(storage.getItem(SAVE_KEY)), newer);
  assert.equal(storage.getItem(REVISION_KEY), "3");
  assert.equal(storage.getItem(DIRTY_KEY), null);
});

test("logout waits for server confirmation and retains the session on failure", async () => {
  seed(makeSave(), 1, false);
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  fetchHandler = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url, "https://lucky.test").pathname;
    assert.equal(path, "/api/player/session");
    assert.equal(String(init.method).toUpperCase(), "DELETE");
    deleteStarted.resolve();
    await releaseDelete.promise;
    return json({ authenticated: false });
  };

  const loggingOut = globalThis.LuckyAuth.logout();
  await deleteStarted.promise;
  assert.notEqual(storage.getItem(SESSION_KEY), null);
  releaseDelete.resolve();
  assert.deepEqual(await loggingOut, { ok: true });
  assert.equal(storage.getItem(SESSION_KEY), null);

  seed(makeSave(), 1, false);
  fetchHandler = async () => json({ error: "暂时不可用" }, 503);
  const failed = await globalThis.LuckyAuth.logout();
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.notEqual(storage.getItem(SESSION_KEY), null);
});
