(function (root) {
  "use strict";

  var MALAYSIA_TIME_ZONE = "Asia/Kuala_Lumpur";
  var dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: MALAYSIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  function safeAmount(value) {
    var amount = Number(value);
    return isFinite(amount) && amount >= 0 ? amount : 0;
  }

  function malaysiaDayKey(timestamp) {
    var date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) return null;
    var parts = dayFormatter.formatToParts(date);
    var values = {};
    parts.forEach(function (part) {
      if (part.type !== "literal") values[part.type] = part.value;
    });
    return values.year && values.month && values.day
      ? values.year + "-" + values.month + "-" + values.day
      : null;
  }

  function recentDayKeys(dayCount, now) {
    var count = Math.max(1, Math.min(31, Math.floor(Number(dayCount) || 7)));
    var currentKey = malaysiaDayKey(now == null ? Date.now() : now);
    if (!currentKey) return [];
    var current = Date.parse(currentKey + "T00:00:00+08:00");
    var keys = [];
    for (var index = count - 1; index >= 0; index -= 1) {
      keys.push(malaysiaDayKey(current - index * 86400000));
    }
    return keys.filter(Boolean);
  }

  function normaliseDailyStats(value) {
    var result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    Object.keys(value).forEach(function (key) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      var entry = value[key];
      if (!entry || typeof entry !== "object") return;
      result[key] = {
        won: safeAmount(entry.won),
        spent: safeAmount(entry.spent)
      };
    });
    return result;
  }

  function summarisePlayer(username, account, savedGame) {
    var player = savedGame && savedGame.player && typeof savedGame.player === "object"
      ? savedGame.player
      : null;
    var displayName = account && typeof account.displayName === "string"
      ? account.displayName.trim()
      : "";
    var won = safeAmount(player && player.totalWon);
    var spent = safeAmount(player && player.totalSpent);
    var normalizedUsername = String(username || "").toLowerCase();
    var role = (account && account.role === "test") || normalizedUsername === "test" || normalizedUsername === "testplayer"
      ? "test"
      : "player";
    return {
      username: String(username || ""),
      displayName: displayName || String(username || ""),
      role: role,
      balance: safeAmount(player ? player.coins : account && account.coins),
      tickets: Math.floor(safeAmount(player && player.ticketsPlayed)),
      level: Math.max(1, Math.floor(safeAmount(player && player.level) || 1)),
      won: won,
      spent: spent,
      loss: Math.max(spent - won, 0),
      net: won - spent,
      log: player && Array.isArray(player.log) ? player.log : [],
      dailyStats: normaliseDailyStats(player && player.dailyStats)
    };
  }

  function aggregateDailyPlayerActivity(players, options) {
    var settings = options || {};
    var keys = recentDayKeys(settings.dayCount || 7, settings.now);
    var totals = {};
    keys.forEach(function (key) { totals[key] = { won: 0, spent: 0 }; });

    (Array.isArray(players) ? players : []).forEach(function (player) {
      var rollups = normaliseDailyStats(player && player.dailyStats);
      var logByDay = {};
      var log = player && Array.isArray(player.log) ? player.log : [];
      log.forEach(function (entry) {
        if (!entry || (entry.k !== "win" && entry.k !== "buy")) return;
        var key = malaysiaDayKey(entry.t);
        if (!key || !totals[key]) return;
        if (!logByDay[key]) logByDay[key] = { won: 0, spent: 0 };
        var amount = safeAmount(entry.a);
        if (entry.k === "win") logByDay[key].won += amount;
        else logByDay[key].spent += amount;
      });

      keys.forEach(function (key) {
        var source = Object.prototype.hasOwnProperty.call(rollups, key) ? rollups[key] : logByDay[key];
        if (!source) return;
        totals[key].won += safeAmount(source.won);
        totals[key].spent += safeAmount(source.spent);
      });
    });

    return keys.map(function (key) {
      return {
        key: key,
        label: key.slice(5).replace("-", "/"),
        won: totals[key].won,
        spent: totals[key].spent
      };
    });
  }

  root.LuckyManagerAnalytics = {
    safeAmount: safeAmount,
    malaysiaDayKey: malaysiaDayKey,
    recentDayKeys: recentDayKeys,
    normaliseDailyStats: normaliseDailyStats,
    summarisePlayer: summarisePlayer,
    aggregateDailyPlayerActivity: aggregateDailyPlayerActivity
  };
})(typeof window !== "undefined" ? window : globalThis);
