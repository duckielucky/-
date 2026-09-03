/* ============================================================
   Lucky Scratch — cloud account bridge
   ------------------------------------------------------------
   D1 and an HttpOnly signed session are authoritative. localStorage
   remains a last-known cache so screens can render during brief
   network interruptions and old device-only accounts can be claimed
   on their first successful cloud login.
   ============================================================ */
(function (global) {
  "use strict";

  var ACCOUNTS_KEY = "lucky_accounts_v1";
  var SESSION_KEY = "lucky_session_v1";
  var GAME_SAVE_KEY = "lucky_save_v1";
  var GAME_REVISION_KEY = "lucky_save_revision_v1";
  var GAME_DIRTY_KEY = "lucky_save_dirty_v1";
  var PLAYER_REGISTER_API = "/api/player/register";
  var PLAYER_SESSION_API = "/api/player/session";
  var PLAYER_PROFILE_API = "/api/player/profile";
  var PLAYER_PASSWORD_API = "/api/player/password";
  var PLAYER_ACCOUNT_API = "/api/player/account";
  var PLAYER_SAVE_API = "/api/player/save";
  var PBKDF2_ITERATIONS = 150000;
  var START_COINS = 20000;

  var AVATARS = ["🍀", "🎰", "💎", "👑", "🎲", "⭐", "🔮", "🦄", "🐯", "🌈"];
  var COLORS = ["#a83cff", "#2ce9d3", "#ffd76e", "#ff5db1", "#5e8bff", "#ff8a3c"];

  // ---- low-level helpers ---------------------------------------------------
  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function randomHex(nBytes) {
    var b = new Uint8Array(nBytes);
    crypto.getRandomValues(b);
    return bytesToHex(b);
  }
  // constant-time-ish compare of two equal-length hex strings
  function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function derive(password, saltHex) {
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
    );
    var bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      keyMaterial, 256
    );
    return bytesToHex(new Uint8Array(bits));
  }

  // ---- store ---------------------------------------------------------------
  // Null-prototype store so usernames like "__proto__"/"constructor" are plain
  // keys (no prototype-chain surprises, no accidental pollution).
  function readStore() {
    var out = Object.create(null);
    try {
      var raw = localStorage.getItem(ACCOUNTS_KEY);
      if (!raw) return out;
      var obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
      }
      return out;
    } catch (e) { return out; }
  }
  // Fail-soft: returns false if storage is full/blocked instead of throwing.
  function writeStore(store) {
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store)); return true; }
    catch (e) { return false; }
  }
  async function apiRequest(path, options) {
    var response;
    try {
      response = await fetch(path, Object.assign({
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" }
      }, options || {}));
    } catch (e) {
      return { ok: false, status: 0, error: "无法连接云端，请检查网络后重试" };
    }
    var payload = null;
    try { payload = await response.json(); } catch (e) {}
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload && typeof payload.error === "string" ? payload.error : "云端服务暂时不可用",
        code: payload && payload.code,
        payload: payload
      };
    }
    return { ok: true, status: response.status, payload: payload || {} };
  }
  function jsonOptions(method, body) {
    return {
      method: method,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body)
    };
  }
  var STORAGE_ERR = "保存失败，浏览器存储已满或被禁用";
  function findByEmail(store, email) {
    var lc = String(email).toLowerCase();
    for (var k in store) if (store[k] && String(store[k].email).toLowerCase() === lc) return store[k];
    return null;
  }

  // ---- validation ----------------------------------------------------------
  var USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var RESERVED_NAMES = ["__proto__", "constructor", "prototype", "hasownproperty", "admin", "root", "test", "testplayer"];

  function validateUsername(u) {
    if (!u) return "请输入用户名";
    if (!USERNAME_RE.test(u)) return "用户名为 3-20 位字母、数字或下划线";
    if (RESERVED_NAMES.indexOf(u.toLowerCase()) >= 0) return "该用户名不可用";
    return null;
  }
  function validateEmail(e) {
    if (!e) return "请输入邮箱";
    if (e.length > 254) return "邮箱过长";
    if (!EMAIL_RE.test(e)) return "邮箱格式不正确";
    return null;
  }
  function passwordScore(pw) {
    if (!pw) return 0;
    var score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    else if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += 0;
    return Math.min(4, score);
  }
  function validatePassword(pw) {
    if (!pw) return "请设置密码";
    if (pw.length < 4) return "密码至少 4 位";
    if (pw.length > 128) return "密码最多 128 位";
    return null;
  }

  // ---- session -------------------------------------------------------------
  function setSession(username) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ u: username, at: new Date().toISOString() }));
    } catch (e) {}
  }
  function cacheRemoteAccount(account) {
    if (!account || typeof account.username !== "string") return null;
    var store = readStore();
    var key = account.username.toLowerCase();
    var existing = store[key] || {};
    store[key] = Object.assign({}, existing, account, {
      username: account.username,
      role: account.role === "test" ? "test" : "player",
      coins: Number.isSafeInteger(Number(account.coins)) ? Number(account.coins) : START_COINS,
      updatedAt: new Date().toISOString()
    });
    // Successful cloud auth retires the legacy device-side verifier.
    delete store[key].password;
    delete store[key].salt;
    delete store[key].hash;
    delete store[key].iterations;
    if (!writeStore(store)) return null;
    return store[key];
  }
  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && typeof s.u === "string" ? s : null;
    } catch (e) { return null; }
  }
  function current() {
    var s = readSession();
    if (!s) return null;
    var store = readStore();
    // publicView strips salt/hash, matching register()/login()/updateProfile().
    return publicView(store[s.u.toLowerCase()] || null);
  }
  async function logout() {
    // Do not clear the local identity until the server has confirmed that the
    // HttpOnly cookie was expired. Otherwise a failed request makes the login
    // page immediately rediscover the still-valid cookie and bounce back in.
    var result = await apiRequest(PLAYER_SESSION_API, { method: "DELETE", keepalive: true });
    if (!result.ok && result.status !== 401) return { ok: false, error: result.error, status: result.status };
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    return { ok: true };
  }
  // The game save is scoped to the signed-in user so accounts don't share
  // progress on a shared device (guests use the bare key).
  function gameStorageKeys() {
    var s = readSession();
    var suffix = s && s.u ? "::" + s.u.toLowerCase() : "";
    return {
      save: GAME_SAVE_KEY + suffix,
      revision: GAME_REVISION_KEY + suffix,
      dirty: GAME_DIRTY_KEY + suffix
    };
  }
  function gameSaveKey() { return gameStorageKeys().save; }
  function gameRevisionKey() {
    return gameStorageKeys().revision;
  }
  function gameDirtyKey() {
    return gameStorageKeys().dirty;
  }
  function readGameRevision(key) {
    try {
      var value = Number(localStorage.getItem(key || gameRevisionKey()));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch (e) { return 0; }
  }
  function writeGameRevision(value, key) {
    try { localStorage.setItem(key || gameRevisionKey(), String(value)); } catch (e) {}
  }
  function readGameDirty(key) {
    try { return localStorage.getItem(key || gameDirtyKey()) === "1"; } catch (e) { return false; }
  }
  function writeGameDirty(dirty, key) {
    try {
      var storageKey = key || gameDirtyKey();
      if (dirty) localStorage.setItem(storageKey, "1");
      else localStorage.removeItem(storageKey);
    } catch (e) {}
  }
  function clearGameCacheForUsername(username) {
    var suffix = "::" + String(username || "").toLowerCase();
    try {
      localStorage.removeItem(GAME_SAVE_KEY + suffix);
      localStorage.removeItem(GAME_REVISION_KEY + suffix);
      localStorage.removeItem(GAME_DIRTY_KEY + suffix);
    } catch (e) {}
  }

  // strip secrets before returning an account to page code
  function publicView(acc) {
    if (!acc) return null;
    var normalized = String(acc.username || "").toLowerCase();
    var role = acc.role === "test" || normalized === "test" || normalized === "testplayer" ? "test" : "player";
    return {
      username: acc.username, email: acc.email, displayName: acc.displayName,
      avatar: acc.avatar, color: acc.color, coins: acc.coins, createdAt: acc.createdAt,
      role: role
    };
  }

  // ---- public API ----------------------------------------------------------
  async function register(input) {
    var username = (input.username || "").trim();
    var email = (input.email || "").trim();
    var password = input.password || "";
    var displayName = (input.displayName || "").trim() || username;

    var err = validateUsername(username) || validateEmail(email) || validatePassword(password);
    if (err) return { ok: false, error: err };
    if (displayName.length > 40 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      return { ok: false, error: "昵称过长或含有无效字符（最多 40 字）" };
    }

    var result = await apiRequest(PLAYER_REGISTER_API, jsonOptions("POST", {
      username: username,
      email: email,
      password: password,
      displayName: displayName,
      avatar: AVATARS.indexOf(input.avatar) >= 0 ? input.avatar : AVATARS[0],
      color: COLORS.indexOf(input.color) >= 0 ? input.color : COLORS[0]
    }));
    if (!result.ok) return { ok: false, error: result.error };
    // A deleted account may leave an optional local cache behind. A newly
    // registered owner of the same username must never inherit that progress.
    clearGameCacheForUsername(result.payload.account.username);
    var cached = cacheRemoteAccount(result.payload.account);
    if (!cached) return { ok: false, error: STORAGE_ERR };
    setSession(cached.username);
    writeGameRevision(0);
    return { ok: true, account: publicView(cached) };
  }

  async function login(input) {
    var id = (input.identity || "").trim();
    var password = input.password || "";
    if (!id || !password) return { ok: false, error: "请输入用户名和密码" };

    var cloud = await apiRequest(PLAYER_SESSION_API, jsonOptions("POST", { identity: id, password: password }));
    if (!cloud.ok && cloud.status === 401) {
      // One-time migration for accounts created before cloud sync existed.
      var legacyStore = readStore();
      var legacy = legacyStore[id.toLowerCase()] || findByEmail(legacyStore, id);
      if (legacy && typeof legacy.salt === "string" && typeof legacy.hash === "string") {
        var candidate = await derive(password, legacy.salt);
        if (safeEqual(candidate, legacy.hash) && publicView(legacy).role !== "test") {
          var claimed = await apiRequest(PLAYER_REGISTER_API, jsonOptions("POST", {
            username: legacy.username,
            email: legacy.email,
            password: password,
            displayName: legacy.displayName,
            avatar: legacy.avatar,
            color: legacy.color
          }));
          if (claimed.ok) cloud = claimed;
          else if (claimed.status === 409) cloud = await apiRequest(PLAYER_SESSION_API, jsonOptions("POST", { identity: id, password: password }));
        }
      }
    }
    if (!cloud.ok) return { ok: false, error: cloud.error };
    var cached = cacheRemoteAccount(cloud.payload.account);
    if (!cached) return { ok: false, error: STORAGE_ERR };
    setSession(cached.username);
    return { ok: true, account: publicView(cached) };
  }

  async function refreshSession() {
    var result = await apiRequest(PLAYER_SESSION_API, { method: "GET" });
    if (!result.ok) {
      if (result.status === 401) try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      return { ok: false, status: result.status, error: result.error };
    }
    var cached = cacheRemoteAccount(result.payload.account);
    if (!cached) return { ok: false, status: 0, error: STORAGE_ERR };
    setSession(cached.username);
    return { ok: true, account: publicView(cached), expiresAt: result.payload.expiresAt };
  }

  async function updateProfile(patch) {
    var s = readSession();
    if (!s) return { ok: false, error: "你尚未登录" };
    var result = await apiRequest(PLAYER_PROFILE_API, jsonOptions("PATCH", patch));
    if (!result.ok) return { ok: false, error: result.error };
    var cached = cacheRemoteAccount(result.payload.account);
    return cached ? { ok: true, account: publicView(cached) } : { ok: false, error: STORAGE_ERR };
  }

  async function changePassword(currentPw, newPw) {
    var pe = validatePassword(newPw);
    if (pe) return { ok: false, error: pe };
    var result = await apiRequest(PLAYER_PASSWORD_API, jsonOptions("POST", {
      currentPassword: currentPw || "",
      newPassword: newPw
    }));
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  async function deleteAccount(alsoWipeGame) {
    var s = readSession();
    if (!s) return { ok: false, error: "你尚未登录" };
    var keys = gameStorageKeys();
    var remote = await apiRequest(PLAYER_ACCOUNT_API, { method: "DELETE" });
    if (!remote.ok) return { ok: false, error: remote.error };
    var store = readStore();
    delete store[s.u.toLowerCase()];
    if (!writeStore(store)) return { ok: false, error: STORAGE_ERR };
    // Wipe only THIS account's game save (compute the key before clearing session).
    if (alsoWipeGame) { try { localStorage.removeItem(keys.save); } catch (e) {} }
    try { localStorage.removeItem(keys.revision); } catch (e) {}
    try { localStorage.removeItem(keys.dirty); } catch (e) {}
    // The successful account-delete response already expires the HttpOnly
    // cookie, so only the local cache remains to be cleared here.
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    return { ok: true };
  }

  // ---- game bridge (read-only view of the local save) ----------------------
  function gameProgress() {
    try {
      var raw = localStorage.getItem(gameSaveKey());
      if (!raw) return null;
      var save = JSON.parse(raw);
      var p = save && save.player;
      if (!p) return null;
      var best = 0;
      if (p.bestWins) for (var k in p.bestWins) best = Math.max(best, Number(p.bestWins[k]) || 0);
      return {
        coins: Number(p.coins) || 0,
        level: Number(p.level) || 1,
        ticketsPlayed: Number(p.ticketsPlayed) || 0,
        bestWin: best,
        totalSpent: Number(p.totalSpent) || 0,
        totalWon: Number(p.totalWon) || 0,
        dailyStats: p.dailyStats && typeof p.dailyStats === "object" && !Array.isArray(p.dailyStats) ? p.dailyStats : {},
        log: Array.isArray(p.log) ? p.log : [],
        settings: { sound: p.settings ? !!p.settings.sound : true, vibration: p.settings ? !!p.settings.vibration : true }
      };
    } catch (e) { return null; }
  }
  function setGameSettings(patch) {
    try {
      var keys = gameStorageKeys();
      var raw = localStorage.getItem(keys.save);
      if (!raw) return false;
      var save = JSON.parse(raw);
      if (!save || !save.player) return false;
      save.player.settings = save.player.settings || {};
      if (patch.sound != null) save.player.settings.sound = !!patch.sound;
      if (patch.vibration != null) save.player.settings.vibration = !!patch.vibration;
      save.updatedAt = Date.now();
      localStorage.setItem(keys.save, JSON.stringify(save));
      writeGameDirty(true, keys.dirty);
      void syncGameSave();
      return true;
    } catch (e) { return false; }
  }

  async function refreshGameSave() {
    var keys = gameStorageKeys();
    var beforeRaw = null;
    try { beforeRaw = localStorage.getItem(keys.save); } catch (e) {}
    var result = await apiRequest(PLAYER_SAVE_API, { method: "GET" });
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    // A logout/login while the request was in flight must not route the old
    // account's response into the newly active account's local cache.
    if (gameStorageKeys().save !== keys.save) {
      return { ok: false, status: 409, stale: true, error: "登录账户已切换，请重试" };
    }
    var revision = Number(result.payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return { ok: false, status: 0, error: "云存档格式不正确" };
    var localRaw = null;
    try { localRaw = localStorage.getItem(keys.save); } catch (e) {}
    var updatedAt = Number(result.payload.updatedAt) || 0;

    function preserveLocal(raw) {
      // Rebase the pending local snapshot on the revision just observed. A
      // concurrent server write is still rejected by the PUT CAS and retried.
      writeGameRevision(revision, keys.revision);
      writeGameDirty(true, keys.dirty);
      if (raw !== null) void syncGameSave();
      if (raw === null) return { ok: true, save: null, revision: revision, cloudRevision: revision, updatedAt: updatedAt, pending: true };
      try {
        return { ok: true, save: JSON.parse(raw), revision: revision, cloudRevision: revision, updatedAt: updatedAt, pending: true };
      } catch (e) {
        return { ok: false, status: 0, error: "本机存档格式不正确" };
      }
    }

    // Compare both the pre-request snapshot and the dirty marker. This catches
    // a settings/game mutation made in another tab while the GET was pending.
    if (localRaw !== beforeRaw || readGameDirty(keys.dirty)) return preserveLocal(localRaw);

    try {
      // Re-read immediately before applying the response. The check narrows the
      // remaining cross-tab window and avoids replacing a just-written value.
      var latestRaw = localStorage.getItem(keys.save);
      if (latestRaw !== localRaw || readGameDirty(keys.dirty)) return preserveLocal(latestRaw);
      if (result.payload.save != null) localStorage.setItem(keys.save, JSON.stringify(result.payload.save));
      else localStorage.removeItem(keys.save);
    } catch (e) {
      return { ok: false, status: 0, error: STORAGE_ERR };
    }
    writeGameRevision(revision, keys.revision);
    writeGameDirty(false, keys.dirty);
    return { ok: true, save: result.payload.save || null, revision: revision, updatedAt: updatedAt };
  }

  var gameSaveSyncQueue = Promise.resolve();
  async function performGameSaveSync() {
    // A later local write can land while a PUT is in flight. Retry it against
    // the newly acknowledged/conflicting revision instead of replacing it.
    for (var attempt = 0; attempt < 4; attempt++) {
      var keys = gameStorageKeys();
      if (!readGameDirty(keys.dirty)) return { ok: true, skipped: true, revision: readGameRevision(keys.revision) };
      var save;
      var raw;
      var baseRevision = readGameRevision(keys.revision);
      try {
        raw = localStorage.getItem(keys.save);
        if (!raw) return { ok: true, skipped: true, revision: baseRevision };
        save = JSON.parse(raw);
      } catch (e) { return { ok: false, error: "本机存档格式不正确" }; }
      var result = await apiRequest(PLAYER_SAVE_API, jsonOptions("PUT", {
        baseRevision: baseRevision,
        save: save
      }));
      if (gameStorageKeys().save !== keys.save) {
        return { ok: false, status: 409, stale: true, error: "登录账户已切换，请重试" };
      }
      var currentRaw = null;
      try { currentRaw = localStorage.getItem(keys.save); } catch (e) {}
      var payload = result.payload || {};
      if (result.ok) {
        var revision = Number(payload.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) return { ok: false, error: "云存档格式不正确" };
        writeGameRevision(revision, keys.revision);
        if (currentRaw === raw) {
          try { currentRaw = localStorage.getItem(keys.save); } catch (e) {}
          if (currentRaw === raw) {
            writeGameDirty(false, keys.dirty);
            return { ok: true, save: payload.save || save, revision: revision };
          }
        }
        writeGameDirty(true, keys.dirty);
        if (currentRaw === null) return { ok: true, pending: true, save: null, revision: revision };
        continue;
      }
      if (result.status === 409) {
        var conflictRevision = Number(payload.revision);
        if (!Number.isSafeInteger(conflictRevision) || conflictRevision < 0) {
          return { ok: false, conflict: true, error: result.error || "云存档格式不正确" };
        }
        writeGameRevision(conflictRevision, keys.revision);
        if (currentRaw === raw) {
          try { currentRaw = localStorage.getItem(keys.save); } catch (e) {}
        }
        if (currentRaw !== raw) {
          writeGameDirty(true, keys.dirty);
          if (currentRaw === null) {
            return { ok: false, conflict: true, pending: true, save: null, revision: conflictRevision, error: result.error };
          }
          continue;
        }
        try {
          if (payload.save != null) localStorage.setItem(keys.save, JSON.stringify(payload.save));
          else localStorage.removeItem(keys.save);
        } catch (e) {
          writeGameDirty(true, keys.dirty);
          return { ok: false, conflict: true, error: STORAGE_ERR };
        }
        writeGameDirty(false, keys.dirty);
        return { ok: false, conflict: true, save: payload.save || null, revision: conflictRevision, error: result.error };
      }
      return { ok: false, error: result.error, status: result.status };
    }
    return { ok: false, pending: true, error: "本机有较新的更改，将稍后重试" };
  }

  function syncGameSave() {
    // Serialize profile/settings writes so rapid toggles cannot send the same
    // base revision concurrently and undo one another on the 409 response.
    var run = function () { return performGameSaveSync(); };
    gameSaveSyncQueue = gameSaveSyncQueue.then(run, run);
    return gameSaveSyncQueue;
  }

  // ---- safe same-origin redirect (no open-redirect) ------------------------
  function safeNext(fallback) {
    fallback = fallback || "/";
    try {
      var raw = new URLSearchParams(location.search).get("next");
      if (!raw) return fallback;
      // only relative, same-site paths; block protocol-relative & absolute URLs
      if (raw[0] !== "/" || raw[1] === "/" || raw.indexOf("\\") >= 0) return fallback;
      return raw;
    } catch (e) { return fallback; }
  }

  function requireAuthOr(redirectTo) {
    if (current()) return true;
    var next = encodeURIComponent(location.pathname + location.search);
    location.replace((redirectTo || "/login.html") + "?next=" + next);
    return false;
  }

  var formatCoins = function (n) {
    try { return new Intl.NumberFormat("en-US").format(n); } catch (e) { return String(n); }
  };

  // ---- fixed built-in test account (test / 1111) ---------------------------
  // Seeded on load so it's always available on any device without registering.
  // Only created if missing — never overwrites an existing "test" account.
  var TEST_USER = "test", TEST_PASS = "1111";
  var ensureTestPromise = null;
  function ensureTestAccount() {
    // Fast path: already present (re-checked every call, so a later reset re-seeds).
    try { if (readStore()[TEST_USER]) return Promise.resolve(true); } catch (e) {}
    if (ensureTestPromise) return ensureTestPromise;   // dedupe concurrent creation
    ensureTestPromise = (async function () {
      try {
        var store = readStore();
        if (store[TEST_USER]) return true;
        var salt = randomHex(16);
        var hash = await derive(TEST_PASS, salt);
        store = readStore();
        if (store[TEST_USER]) return true;
        var now = new Date().toISOString();
        store[TEST_USER] = {
          username: TEST_USER, email: "test@example.com", displayName: "Test",
          avatar: AVATARS[0], color: COLORS[0],
          role: "test",
          salt: salt, hash: hash, iterations: PBKDF2_ITERATIONS,
          coins: START_COINS, createdAt: now, updatedAt: now
        };
        return writeStore(store);
      } catch (e) { return false; }
      finally { ensureTestPromise = null; }
    })();
    return ensureTestPromise;
  }

  global.LuckyAuth = {
    AVATARS: AVATARS, COLORS: COLORS, START_COINS: START_COINS,
    register: register, login: login, logout: logout, current: current, refreshSession: refreshSession,
    updateProfile: updateProfile, changePassword: changePassword, deleteAccount: deleteAccount,
    validateUsername: validateUsername, validateEmail: validateEmail,
    validatePassword: validatePassword, passwordScore: passwordScore,
    gameProgress: gameProgress, setGameSettings: setGameSettings,
    refreshGameSave: refreshGameSave, syncGameSave: syncGameSave,
    readGameRevision: readGameRevision,
    safeNext: safeNext, requireAuthOr: requireAuthOr, formatCoins: formatCoins,
    ensureTestAccount: ensureTestAccount, TEST_USER: TEST_USER, TEST_PASS: TEST_PASS
  };

  ensureTestAccount(); // fire on load
})(window);
