(function (root) {
  "use strict";

  var ACCOUNTS_KEY = "lucky_accounts_v1";
  var SESSION_KEY = "lucky_session_v1";
  var SAVE_PREFIX = "lucky_save_v1::";
  var PBKDF2_ITERATIONS = 150000;
  var START_COINS = 20000;
  var MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
  var AVATARS = ["🍀", "🎰", "💎", "👑", "🎲", "⭐", "🔮", "🦄", "🐯", "🌈"];
  var COLORS = ["#a83cff", "#2ce9d3", "#ffd76e", "#ff5db1", "#5e8bff", "#ff8a3c"];
  var RESERVED_NAMES = ["__proto__", "constructor", "prototype", "hasownproperty", "admin", "root"];
  var TEST_NAMES = ["test", "testplayer"];

  function storageOr(provided) {
    if (provided) return provided;
    if (root.localStorage) return root.localStorage;
    throw new Error("浏览器存储不可用");
  }

  function normalizeUsername(value) {
    var username = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return null;
    if (RESERVED_NAMES.indexOf(username) >= 0) return null;
    return username;
  }

  function readAccounts(storage) {
    var raw = storage.getItem(ACCOUNTS_KEY);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  function roleFor(account, username) {
    if (account && account.role === "test") return "test";
    return username === "test" || username === "testplayer" ? "test" : "player";
  }

  function readText(value, label, minLength, maxLength) {
    var text = String(value == null ? "" : value).trim();
    if (text.length < minLength || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error(label + "必须为 " + minLength + "–" + maxLength + " 个字符");
    }
    return text;
  }

  function readEmail(value) {
    var email = readText(value, "邮箱", 3, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
    return email;
  }

  function readInteger(value, label, min, max) {
    var number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new Error(label + "必须是 " + min + "–" + max + " 的整数");
    }
    return number;
  }

  function readBoolean(value) {
    return value === true;
  }

  function readBestWins(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    var result = {};
    Object.keys(value).slice(0, 32).forEach(function (key) {
      if (!/^[a-z0-9_-]{1,40}$/i.test(key)) return;
      result[key] = readInteger(value[key], "最高中奖", 0, MAX_AMOUNT);
    });
    return result;
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var index = 0; index < bytes.length; index += 1) out += bytes[index].toString(16).padStart(2, "0");
    return out;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var index = 0; index < out.length; index += 1) out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return out;
  }

  function randomHex(byteLength) {
    var bytes = new Uint8Array(byteLength);
    root.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  async function derivePassword(password, saltHex) {
    var encoded = new TextEncoder().encode(password);
    var keyMaterial = await root.crypto.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveBits"]);
    var bits = await root.crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return bytesToHex(new Uint8Array(bits));
  }

  function restore(storage, key, value) {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  }

  function inspectPlayer(usernameValue, providedStorage) {
    var storage = storageOr(providedStorage);
    var username = normalizeUsername(usernameValue);
    if (!username) return null;
    var accounts = readAccounts(storage);
    var account = Object.prototype.hasOwnProperty.call(accounts, username) ? accounts[username] : null;
    var save = null;
    var rawSave = storage.getItem(SAVE_PREFIX + username);
    if (rawSave) {
      var parsed = JSON.parse(rawSave);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) save = parsed;
    }
    if (!account && !save) return null;
    return {
      username: username,
      role: roleFor(account, username),
      account: account ? {
        username: String(account.username || username),
        email: String(account.email || ""),
        displayName: String(account.displayName || account.username || username),
        avatar: AVATARS.indexOf(account.avatar) >= 0 ? account.avatar : AVATARS[0],
        color: COLORS.indexOf(account.color) >= 0 ? account.color : COLORS[0],
        coins: Number.isSafeInteger(Number(account.coins)) ? Number(account.coins) : START_COINS,
        createdAt: account.createdAt || null,
        updatedAt: account.updatedAt || null
      } : null,
      save: save
    };
  }

  async function updatePlayer(currentUsernameValue, patch, providedStorage) {
    try {
      var storage = storageOr(providedStorage);
      var currentUsername = normalizeUsername(currentUsernameValue);
      if (!currentUsername || !inspectPlayer(currentUsername, storage)) throw new Error("未找到玩家");
      patch = patch && typeof patch === "object" ? patch : {};
      var accounts = readAccounts(storage);
      var account = Object.prototype.hasOwnProperty.call(accounts, currentUsername) ? accounts[currentUsername] : null;
      var role = roleFor(account, currentUsername);
      var requestedUsername = String(patch.username != null ? patch.username : currentUsername).trim();
      var nextUsername = normalizeUsername(requestedUsername);
      if (!nextUsername) throw new Error("用户名必须为 3–20 位字母、数字或下划线，且不可使用保留名称");
      if (role === "test" && nextUsername !== currentUsername) throw new Error("内置测试玩家不能修改用户名");
      if (nextUsername !== currentUsername && TEST_NAMES.indexOf(nextUsername) >= 0) throw new Error("该用户名不可用");
      if (nextUsername !== currentUsername && (Object.prototype.hasOwnProperty.call(accounts, nextUsername) || storage.getItem(SAVE_PREFIX + nextUsername) !== null)) {
        throw new Error("该用户名已被占用");
      }

      var password = String(patch.newPassword || "");
      if (role === "test" && password) throw new Error("内置测试玩家密码固定为 1111");
      var passwordSecret = null;
      if (password) {
        if (password.length < 4 || password.length > 128) throw new Error("新密码必须为 4–128 位");
        var newSalt = randomHex(16);
        passwordSecret = { salt: newSalt, hash: await derivePassword(password, newSalt) };
      }

      // PBKDF2 is asynchronous. Re-read and revalidate the shared browser
      // store before writing so a simultaneous registration is never lost.
      accounts = readAccounts(storage);
      account = Object.prototype.hasOwnProperty.call(accounts, currentUsername) ? accounts[currentUsername] : null;
      role = roleFor(account, currentUsername);
      if (role === "test" && nextUsername !== currentUsername) throw new Error("内置测试玩家不能修改用户名");
      if (role === "test" && passwordSecret) throw new Error("内置测试玩家密码固定为 1111");
      if (nextUsername !== currentUsername && (Object.prototype.hasOwnProperty.call(accounts, nextUsername) || storage.getItem(SAVE_PREFIX + nextUsername) !== null)) {
        throw new Error("该用户名已被占用");
      }

      var nextAccount = account ? Object.assign({}, account) : null;
      if (nextAccount) {
        var email = readEmail(patch.email);
        Object.keys(accounts).forEach(function (key) {
          if (key === currentUsername) return;
          var candidate = accounts[key];
          if (candidate && String(candidate.email || "").trim().toLowerCase() === email.toLowerCase()) {
            throw new Error("该邮箱已被其他账户使用");
          }
        });
        nextAccount.username = requestedUsername;
        nextAccount.email = email;
        nextAccount.displayName = readText(patch.displayName || requestedUsername, "昵称", 1, 40);
        nextAccount.avatar = AVATARS.indexOf(patch.avatar) >= 0 ? patch.avatar : AVATARS[0];
        nextAccount.color = COLORS.indexOf(patch.color) >= 0 ? patch.color : COLORS[0];
        nextAccount.role = role;
        nextAccount.coins = readInteger(patch.coins, "代币余额", 0, MAX_AMOUNT);
        nextAccount.updatedAt = new Date().toISOString();
        if (passwordSecret) {
          nextAccount.salt = passwordSecret.salt;
          nextAccount.hash = passwordSecret.hash;
          nextAccount.iterations = PBKDF2_ITERATIONS;
        }
      } else if (password) {
        throw new Error("这条记录没有可重设密码的玩家账户");
      }

      var oldSaveKey = SAVE_PREFIX + currentUsername;
      var nextSaveKey = SAVE_PREFIX + nextUsername;
      var rawSave = storage.getItem(oldSaveKey);
      var nextSave = null;
      if (rawSave) {
        nextSave = JSON.parse(rawSave);
        if (!nextSave || typeof nextSave !== "object" || Array.isArray(nextSave)) throw new Error("玩家存档已经损坏");
        var player = nextSave.player;
        if (!player || typeof player !== "object" || Array.isArray(player)) throw new Error("玩家进度已经损坏");
        var previousCoins = Number(player.coins) || 0;
        var coins = readInteger(patch.coins, "代币余额", 0, MAX_AMOUNT);
        var ticketsPlayed = readInteger(patch.ticketsPlayed, "已刮票数", 0, 1000000000);
        player.coins = coins;
        player.ticketsPlayed = ticketsPlayed;
        player.level = Math.floor(ticketsPlayed / 5) + 1;
        player.totalWon = readInteger(patch.totalWon, "累计中奖", 0, MAX_AMOUNT);
        player.totalSpent = readInteger(patch.totalSpent, "累计花费", 0, MAX_AMOUNT);
        player.selectedTicketId = readText(patch.selectedTicketId, "当前票种", 1, 40);
        if (!/^[a-z0-9_-]+$/i.test(player.selectedTicketId)) throw new Error("当前票种格式无效");
        player.bestWins = Object.assign({}, readBestWins(player.bestWins), readBestWins(patch.bestWins));
        player.tutorialSeen = readBoolean(patch.tutorialSeen);
        player.settings = { sound: readBoolean(patch.sound), vibration: readBoolean(patch.vibration) };
        if (patch.rescueReady === true) player.rescueAt = 0;
        if (patch.clearHistory === true) {
          player.log = [];
          player.dailyStats = {};
        }
        var delta = coins - previousCoins;
        if (delta !== 0) {
          var log = Array.isArray(player.log) ? player.log : [];
          player.log = [{ t: Date.now(), k: "developer", a: delta, n: "运营后台编辑余额" }].concat(log).slice(0, 80);
        }
        nextSave.saveVersion = 2;
        nextSave.revision = Math.max(0, Number(nextSave.revision) || 0) + 1;
        nextSave.updatedAt = Date.now();
      }

      var oldAccountsRaw = storage.getItem(ACCOUNTS_KEY);
      var oldSaveRaw = storage.getItem(oldSaveKey);
      var overwrittenSaveRaw = nextSaveKey === oldSaveKey ? oldSaveRaw : storage.getItem(nextSaveKey);
      var oldSessionRaw = storage.getItem(SESSION_KEY);
      try {
        if (nextAccount) {
          delete accounts[currentUsername];
          accounts[nextUsername] = nextAccount;
          storage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
        }
        if (nextSave) storage.setItem(nextSaveKey, JSON.stringify(nextSave));
        if (nextSaveKey !== oldSaveKey) storage.removeItem(oldSaveKey);
        if (oldSessionRaw) {
          var session = JSON.parse(oldSessionRaw);
          if (session && String(session.u || "").toLowerCase() === currentUsername) {
            if (passwordSecret) storage.removeItem(SESSION_KEY);
            else {
              session.u = requestedUsername;
              session.at = new Date().toISOString();
              storage.setItem(SESSION_KEY, JSON.stringify(session));
            }
          }
        }
      } catch (writeError) {
        restore(storage, ACCOUNTS_KEY, oldAccountsRaw);
        restore(storage, oldSaveKey, oldSaveRaw);
        if (nextSaveKey !== oldSaveKey) restore(storage, nextSaveKey, overwrittenSaveRaw);
        restore(storage, SESSION_KEY, oldSessionRaw);
        throw writeError;
      }
      return { ok: true, username: nextUsername, role: role, hasSave: Boolean(nextSave) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "保存玩家失败" };
    }
  }

  function resetProgress(usernameValue, providedStorage) {
    try {
      var storage = storageOr(providedStorage);
      var username = normalizeUsername(usernameValue);
      if (!username || !inspectPlayer(username, storage)) throw new Error("未找到玩家");
      var accounts = readAccounts(storage);
      var oldAccountsRaw = storage.getItem(ACCOUNTS_KEY);
      var saveKey = SAVE_PREFIX + username;
      var oldSaveRaw = storage.getItem(saveKey);
      try {
        if (accounts[username]) {
          accounts[username].coins = START_COINS;
          accounts[username].updatedAt = new Date().toISOString();
          storage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
        }
        storage.removeItem(saveKey);
      } catch (writeError) {
        restore(storage, ACCOUNTS_KEY, oldAccountsRaw);
        restore(storage, saveKey, oldSaveRaw);
        throw writeError;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message === "未找到玩家" ? error.message : "重置失败，浏览器存储不可用" };
    }
  }

  function deletePlayer(usernameValue, providedStorage) {
    try {
      var storage = storageOr(providedStorage);
      var username = normalizeUsername(usernameValue);
      var current = username ? inspectPlayer(username, storage) : null;
      if (!current) throw new Error("未找到玩家");
      if (current.role === "test") return { ok: false, error: "内置测试玩家不能删除" };
      var accounts = readAccounts(storage);
      var oldAccountsRaw = storage.getItem(ACCOUNTS_KEY);
      var saveKey = SAVE_PREFIX + username;
      var oldSaveRaw = storage.getItem(saveKey);
      var sessionRaw = storage.getItem(SESSION_KEY);
      try {
        delete accounts[username];
        storage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
        storage.removeItem(saveKey);
        if (sessionRaw) {
          var session = JSON.parse(sessionRaw);
          if (session && String(session.u || "").toLowerCase() === username) storage.removeItem(SESSION_KEY);
        }
      } catch (writeError) {
        restore(storage, ACCOUNTS_KEY, oldAccountsRaw);
        restore(storage, saveKey, oldSaveRaw);
        restore(storage, SESSION_KEY, sessionRaw);
        throw writeError;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message === "未找到玩家" ? error.message : "删除失败，浏览器存储不可用" };
    }
  }

  root.LuckyPlayerAdmin = {
    AVATARS: AVATARS,
    COLORS: COLORS,
    START_COINS: START_COINS,
    normalizeUsername: normalizeUsername,
    roleFor: roleFor,
    inspectPlayer: inspectPlayer,
    updatePlayer: updatePlayer,
    resetProgress: resetProgress,
    deletePlayer: deletePlayer
  };
})(typeof window !== "undefined" ? window : globalThis);
