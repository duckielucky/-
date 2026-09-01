/* ============================================================
   Lucky Scratch — device-local account library
   ------------------------------------------------------------
   HONEST SCOPE: this is a front-end demo account system. Accounts
   live in this browser's localStorage only — there is NO server,
   NO cloud sync, and NO cross-device login. Passwords are hashed
   with PBKDF2-SHA256 (never stored in clear), which is correct
   practice, but client-side storage is not a substitute for real
   server-side auth. Production accounts need a backend (e.g. the
   Cloudflare D1 binding already scaffolded in this project).
   ============================================================ */
(function (global) {
  "use strict";

  var ACCOUNTS_KEY = "lucky_accounts_v1";
  var SESSION_KEY = "lucky_session_v1";
  var GAME_SAVE_KEY = "lucky_save_v1";
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
  function logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  // The game save is scoped to the signed-in user so accounts don't share
  // progress on a shared device (guests use the bare key).
  function gameSaveKey() {
    var s = readSession();
    return s && s.u ? GAME_SAVE_KEY + "::" + s.u.toLowerCase() : GAME_SAVE_KEY;
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

    var store = readStore();
    if (store[username.toLowerCase()]) return { ok: false, error: "该用户名已被占用" };
    if (findByEmail(store, email)) return { ok: false, error: "该邮箱已被注册" };

    var salt = randomHex(16);
    var hash = await derive(password, salt);
    // Password hashing yields to the event loop. Merge into the latest store so
    // simultaneous registrations and test-account seeding cannot overwrite one another.
    store = readStore();
    if (store[username.toLowerCase()]) return { ok: false, error: "该用户名已被占用" };
    if (findByEmail(store, email)) return { ok: false, error: "该邮箱已被注册" };
    var now = new Date().toISOString();
    var acc = {
      username: username, email: email, displayName: displayName,
      avatar: AVATARS.indexOf(input.avatar) >= 0 ? input.avatar : AVATARS[0],
      color: COLORS.indexOf(input.color) >= 0 ? input.color : COLORS[0],
      role: "player",
      salt: salt, hash: hash, iterations: PBKDF2_ITERATIONS,
      coins: START_COINS, createdAt: now, updatedAt: now
    };
    store[username.toLowerCase()] = acc;
    if (!writeStore(store)) return { ok: false, error: STORAGE_ERR };
    setSession(username);
    return { ok: true, account: publicView(acc) };
  }

  async function login(input) {
    var id = (input.identity || "").trim();
    var password = input.password || "";
    if (!id || !password) return { ok: false, error: "请输入用户名和密码" };

    await ensureTestAccount();   // guarantee the built-in test account exists
    var store = readStore();
    var acc = store[id.toLowerCase()] || findByEmail(store, id);
    // Always run a derive to avoid trivially leaking whether the user exists.
    var salt = acc ? acc.salt : randomHex(16);
    var candidate = await derive(password, salt);
    if (!acc || !safeEqual(candidate, acc.hash)) {
      return { ok: false, error: "用户名或密码错误" };
    }
    setSession(acc.username);
    return { ok: true, account: publicView(acc) };
  }

  function mutateCurrent(fn) {
    var s = readSession();
    if (!s) return { ok: false, error: "你尚未登录" };
    var store = readStore();
    var acc = store[s.u.toLowerCase()];
    if (!acc) return { ok: false, error: "未找到账户" };
    var res = fn(acc, store);
    if (res && res.error) return { ok: false, error: res.error };
    acc.updatedAt = new Date().toISOString();
    if (!writeStore(store)) return { ok: false, error: STORAGE_ERR };
    return { ok: true, account: publicView(acc) };
  }

  function updateProfile(patch) {
    return mutateCurrent(function (acc, store) {
      if (patch.displayName != null) {
        var dn = String(patch.displayName).trim();
        if (dn.length > 40) return { error: "昵称过长（最多 40 字）" };
        acc.displayName = dn || acc.username;
      }
      if (patch.email != null) {
        var em = String(patch.email).trim();
        var ee = validateEmail(em);
        if (ee) return { error: ee };
        var other = findByEmail(store, em);
        if (other && other.username.toLowerCase() !== acc.username.toLowerCase())
          return { error: "该邮箱已被其他账户使用" };
        acc.email = em;
      }
      if (patch.avatar != null && AVATARS.indexOf(patch.avatar) >= 0) acc.avatar = patch.avatar;
      if (patch.color != null && COLORS.indexOf(patch.color) >= 0) acc.color = patch.color;
    });
  }

  async function changePassword(currentPw, newPw) {
    var s = readSession();
    if (!s) return { ok: false, error: "你尚未登录" };
    var store = readStore();
    var acc = store[s.u.toLowerCase()];
    if (!acc) return { ok: false, error: "未找到账户" };
    if (publicView(acc).role === "test") return { ok: false, error: "内置测试玩家密码固定为 1111" };

    var check = await derive(currentPw || "", acc.salt);
    if (!safeEqual(check, acc.hash)) return { ok: false, error: "当前密码不正确" };
    var pe = validatePassword(newPw);
    if (pe) return { ok: false, error: pe };

    var salt = randomHex(16);
    var hash = await derive(newPw, salt);
    store = readStore();
    var latest = store[s.u.toLowerCase()];
    if (!latest) return { ok: false, error: "未找到账户" };
    if (publicView(latest).role === "test") return { ok: false, error: "内置测试玩家密码固定为 1111" };
    if (latest.salt !== acc.salt || latest.hash !== acc.hash) return { ok: false, error: "密码已在其他页面更新，请重新登录" };
    latest.salt = salt;
    latest.hash = hash;
    latest.iterations = PBKDF2_ITERATIONS;
    latest.updatedAt = new Date().toISOString();
    if (!writeStore(store)) return { ok: false, error: STORAGE_ERR };
    return { ok: true };
  }

  function deleteAccount(alsoWipeGame) {
    var s = readSession();
    if (!s) return { ok: false, error: "你尚未登录" };
    var store = readStore();
    delete store[s.u.toLowerCase()];
    if (!writeStore(store)) return { ok: false, error: STORAGE_ERR };
    // Wipe only THIS account's game save (compute the key before clearing session).
    if (alsoWipeGame) { try { localStorage.removeItem(gameSaveKey()); } catch (e) {} }
    logout();
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
      var key = gameSaveKey();
      var raw = localStorage.getItem(key);
      if (!raw) return false;
      var save = JSON.parse(raw);
      if (!save || !save.player) return false;
      save.player.settings = save.player.settings || {};
      if (patch.sound != null) save.player.settings.sound = !!patch.sound;
      if (patch.vibration != null) save.player.settings.vibration = !!patch.vibration;
      localStorage.setItem(key, JSON.stringify(save));
      return true;
    } catch (e) { return false; }
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
    register: register, login: login, logout: logout, current: current,
    updateProfile: updateProfile, changePassword: changePassword, deleteAccount: deleteAccount,
    validateUsername: validateUsername, validateEmail: validateEmail,
    validatePassword: validatePassword, passwordScore: passwordScore,
    gameProgress: gameProgress, setGameSettings: setGameSettings,
    safeNext: safeNext, requireAuthOr: requireAuthOr, formatCoins: formatCoins,
    ensureTestAccount: ensureTestAccount, TEST_USER: TEST_USER, TEST_PASS: TEST_PASS
  };

  ensureTestAccount(); // fire on load
})(window);
