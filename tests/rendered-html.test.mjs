import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const API_ORIGIN = "http://localhost";
const MANAGER_USERNAME = "Admin";
const MANAGER_PASSWORD = "Test1234";
const MANAGER_SESSION_SECRET = "unit-test-manager-session-secret-2026-08-25";
const MANAGER_COOKIE_NAME = "__Host-lucky-manager-session";
const NATURAL_DEFAULT_TOPUPS = [
  { id: "starter", price: 5, coins: 250 },
  { id: "value", price: 10, coins: 500 },
  { id: "popular", price: 20, coins: 1000 },
  { id: "mega", price: 50, coins: 2500 },
];
const LEGACY_DEFAULT_TOPUPS = [
  { id: "starter", price: 4.9, coins: 5000 },
  { id: "value", price: 9.9, coins: 12000 },
  { id: "popular", price: 19.9, coins: 30000 },
  { id: "mega", price: 49.9, coins: 80000 },
];

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function createConfigDb(initialConfig = null) {
  let row = initialConfig
    ? { configJson: JSON.stringify(initialConfig), version: 1, updatedAt: 1 }
    : null;
  let managerSecret = null;
  let managerAccount = null;
  const managerLoginThrottle = new Map();
  return {
    managerLoginThrottleRows() {
      return [...managerLoginThrottle.entries()].map(([key, value]) => ({ key, ...value }));
    },
    ageManagerLoginThrottle(milliseconds) {
      for (const value of managerLoginThrottle.values()) {
        value.windowStartedAt -= milliseconds;
        value.updatedAt -= milliseconds;
      }
    },
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...next) { values = next; return statement; },
        async first() {
          if (/SELECT config_json/i.test(sql) && row) return { configJson: row.configJson, version: row.version, updatedAt: row.updatedAt };
          if (/SELECT hash, salt, algorithm[\s\S]*FROM manager_secret/i.test(sql) && managerSecret) return { ...managerSecret };
          if (/SELECT username, username_normalized AS usernameNormalized[\s\S]*FROM manager_account/i.test(sql) && managerAccount) {
            return { ...managerAccount };
          }
          if (/SELECT failed_attempts AS failedAttempts, window_started_at AS windowStartedAt[\s\S]*FROM manager_login_throttle/i.test(sql)) {
            const throttle = managerLoginThrottle.get(values[0]);
            return throttle ? { ...throttle } : null;
          }
          return null;
        },
        async run() {
          if (/CREATE TABLE/i.test(sql)) return { meta: { changes: 0 } };
          if (/INSERT INTO game_config/i.test(sql)) {
            if (row) return { meta: { changes: 0 } };
            row = { configJson: values[1], version: 1, updatedAt: values[2] };
            return { meta: { changes: 1 } };
          }
          if (/UPDATE game_config/i.test(sql)) {
            if (!row || row.version !== values[3]) return { meta: { changes: 0 } };
            row = { configJson: values[0], version: row.version + 1, updatedAt: values[1] };
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO manager_secret/i.test(sql)) {
            managerSecret = { hash: values[1], salt: values[2], algorithm: values[3], updatedAt: values[4] };
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO manager_account/i.test(sql)) {
            managerAccount = { username: values[1], usernameNormalized: values[2], updatedAt: values[3] };
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM manager_login_throttle WHERE updated_at/i.test(sql)) {
            let changes = 0;
            for (const [key, value] of managerLoginThrottle) {
              if (value.updatedAt <= values[0]) {
                managerLoginThrottle.delete(key);
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (/DELETE FROM manager_login_throttle WHERE key/i.test(sql)) {
            const changes = managerLoginThrottle.delete(values[0]) ? 1 : 0;
            return { meta: { changes } };
          }
          if (/INSERT INTO manager_login_throttle/i.test(sql)) {
            const [key, now, staleBefore] = values;
            const current = managerLoginThrottle.get(key);
            if (!current || current.windowStartedAt <= staleBefore) {
              managerLoginThrottle.set(key, { failedAttempts: 1, windowStartedAt: now, updatedAt: now });
            } else {
              managerLoginThrottle.set(key, { ...current, failedAttempts: current.failedAttempts + 1, updatedAt: now });
            }
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
      return statement;
    },
  };
}

async function apiFetch(db, path = "/api/config", init = {}, envOverrides = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${API_ORIGIN}${path}`, init),
    {
      DB: db,
      MANAGER_TOKEN: MANAGER_SESSION_SECRET,
      MANAGER_PASSWORD,
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      ...envOverrides,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function sameOriginHeaders(extra = {}) {
  return { origin: API_ORIGIN, "sec-fetch-site": "same-origin", ...extra };
}

async function managerLogin(db, password = MANAGER_PASSWORD, username = MANAGER_USERNAME, connectingIp = "203.0.113.10") {
  return apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json", "cf-connecting-ip": connectingIp }),
    body: JSON.stringify({ username, password }),
  });
}

function readSessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "manager response must set the session cookie");
  return { setCookie, cookie: setCookie.split(";", 1)[0] };
}

const VALID_CONFIG = {
  schemaVersion: 1,
  updatedAt: 0,
  multiplierMinLevel: 3,
  economy: { coinsPerToken: 50, myrPerToken: 1 },
  odds: { m0: 0.45, m1: 0.33, m2: 0.16, m3: 0.06 },
  topups: [
    { id: "starter", price: 4.9, coins: 5000 },
    { id: "value", price: 9.9, coins: 12000 },
  ],
  tiers: [{
    id: "starter_100x", name: "100X Starter", shortName: "100X", maxLabel: "100X", feature: "经典对号中奖",
    cost: 500, unlockLevel: 1, accent: "#d743ff", accent2: "#7c2eff",
    prizePool: [50, 100, 250], multipliers: [2, 5, 10], specialChance: 0.06,
  }],
};

test("server-renders Lucky Scratch metadata and app shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Lucky Scratch<\/title>/i);
  assert.match(html, /Lucky Scratch - Reveal the neon surprise/i);
  assert.match(html, /http:\/\/localhost(?::3000)?\/og\.png/i);
  assert.match(html, /class="loading-mark"/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("serves game bundles asset-first while keeping manager routes protected", async () => {
  const wranglerConfig = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.equal(wranglerConfig.assets?.binding, "ASSETS");
  assert.deepEqual(wranglerConfig.assets?.run_worker_first, ["/api/*", "/manager*"]);
});

test("ships the game systems and installable assets", async () => {
  const [page, layout, styles, accountStyles, login, profile, manager, managerLoginPage, manifest, serviceWorker, packageJson, configApi] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/lucky-account.css", import.meta.url), "utf8"),
    readFile(new URL("../public/login.html", import.meta.url), "utf8"),
    readFile(new URL("../public/profile.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manager.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manager-login.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../worker/config-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const TICKET_TYPES/);
  assert.match(page, /destination-out/);
  assert.match(page, /lucky_save_v1/);
  assert.match(page, /settleLock/);
  assert.match(page, /hasLocalAccountSession/);
  assert.match(page, /\/login\.html\?next=%2F/);
  assert.match(page, /new ResizeObserver/);
  assert.match(page, /prizeTier/);
  assert.match(page, /prizeEffectPower/);
  assert.match(page, /fetchCloudConfig/);
  assert.match(page, /confirmDemoTopup/);
  assert.match(page, /panel\("topup"\)|setPanel\("topup"\)/);
  assert.match(page, /不会真实扣款/);
  assert.match(page, /代币只保存在本设备/);
  assert.match(page, /currentPackage\.price !== selectedTopup\.price/);
  for (const topup of NATURAL_DEFAULT_TOPUPS) {
    assert.match(page, new RegExp(`id: "${topup.id}", price: ${topup.price}, coins: ${topup.coins}`));
    assert.match(manager, new RegExp(`id: "${topup.id}", price: ${topup.price}, coins: ${topup.coins}`));
    assert.match(configApi, new RegExp(`id: "${topup.id}", price: ${topup.price}, coins: ${topup.coins}`));
  }
  assert.match(page, /setAttribute\("inert", ""\)/);
  assert.match(page, /topupConfirmRef/);
  assert.match(page, /BroadcastChannel/);
  assert.match(page, /result-particles/);
  assert.match(page, /WinConfetti.*intensity/s);
  assert.match(styles, /--effect-power/);
  assert.match(styles, /result-particle/);
  assert.doesNotMatch(page, /prize-celebration-effect/);
  assert.doesNotMatch(styles, /prize-celebration-effect/);
  assert.doesNotMatch(serviceWorker, /prize-celebration-effect/);
  assert.match(styles, /game-lottery-background\.webp/);
  assert.match(accountStyles, /lottery-background\.webp/);
  assert.match(accountStyles, /profile-lottery-background\.webp/);
  assert.match(login, /id="loginForm"/);
  assert.match(profile, /class="auth-shell profile-shell"/);
  assert.match(manager, /id="btnLogout"/);
  assert.match(manager, /id="btnChangePw"/);
  assert.match(manager, /id="btnAddTopup"/);
  assert.match(manager, /id="topupRows"/);
  assert.match(manager, /id="fMyrPerToken"/);
  assert.match(manager, /id="fCoinsPerToken"/);
  assert.match(manager, /id="playerLookup"[^>]*type="search"[^>]*list="playerNameOptions"/);
  assert.match(manager, /id="playerWon"/);
  assert.match(manager, /id="playerSpent"/);
  assert.match(manager, /id="playerLog"/);
  assert.match(manager, /id="playerSearchForm"[^>]*role="search"/);
  assert.match(manager, /id="playerNameOptions"/);
  assert.match(manager, /仅此浏览器/);
  assert.match(manager, /data-manager-target="tickets"/);
  assert.match(manager, /data-manager-target="topups"/);
  assert.match(manager, /data-manager-target="players"/);
  assert.match(manager, /data-manager-target="account"/);
  assert.match(manager, /票种系统/);
  assert.match(manager, /配套系统/);
  assert.match(manager, /账户设置/);
  assert.match(manager, /data-manager-section="tickets"/);
  assert.match(manager, /data-manager-section="topups"/);
  assert.match(manager, /data-manager-section="players"/);
  assert.match(manager, /data-manager-section="account"/);
  assert.match(manager, /id="managerIdentityAccount"/);
  assert.match(manager, /id="managerAvatar"/);
  assert.match(manager, /id="managerUsernameForm"/);
  assert.match(manager, /id="managerUsernameNew"[^>]*minlength="3"[^>]*maxlength="32"[^>]*autocomplete="username"/);
  assert.match(manager, /id="managerUsernamePassword"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(manager, /id="btnChangeUsername"[^>]*type="submit"/);
  assert.match(manager, /id="usernameError"[^>]*role="alert"/);
  assert.match(manager, /\/api\/manager\/username/);
  assert.equal((manager.match(/data-save-config="(?:tickets|topups)"/g) ?? []).length, 2);
  assert.doesNotMatch(manager, /id="(?:btnSave|moSave)"/);
  assert.match(manager, /async function publishConfig\(/);
  assert.match(manager, /--bg:#09040f/);
  assert.match(manager, /--cyan:#2ce9d3/);
  assert.match(manager, /--gold:#ffd76e/);
  assert.match(manager, /function setManagerView\(/);
  assert.match(manager, /@media \(max-width:900px\)[\s\S]*?\.manager-nav\{/);
  assert.match(manager, /@media \(max-width:900px\)[\s\S]*?\.topbar\{[\s\S]*?height:58px/);
  assert.match(manager, /\.manager-view-head h2\{[^}]*scroll-margin-top:138px/);
  assert.match(manager, /title\.focus\(\{ preventScroll: true \}\)/);
  assert.equal((manager.match(/保存所有未发布更改/g) ?? []).length, 2);
  assert.match(manager, /if \(normalizePlayerUsername\(\$\("playerLookup"\)\.value\)\) renderPlayerReport\(\)/);
  assert.match(manager, /PLAYER_SAVE_PREFIX \+ username/);
  assert.match(manager, /detail\.textContent = labels\[entry\.k\]/);
  assert.match(manager, /删除套餐/);
  assert.match(manager, /defaultTopupTokens = 10/);
  assert.match(manager, /defaultTopupTokens \* cfg\.economy\.myrPerToken/);
  assert.match(manager, /defaultTopupTokens \* cfg\.economy\.coinsPerToken/);
  assert.match(manager, /\/api\/manager\/session/);
  assert.match(manager, /\/api\/manager\/password/);
  assert.match(manager, /method:\s*"DELETE"/);
  assert.match(manager, /credentials:\s*"same-origin"/);
  assert.match(managerLoginPage, /id="loginForm"/);
  assert.match(managerLoginPage, /id="username"[^>]*placeholder="管理员用户名"[^>]*autocomplete="username"/);
  assert.doesNotMatch(managerLoginPage, /id="username"[^>]*value="Admin"/);
  assert.match(managerLoginPage, /使用管理员用户名与管理密码登录/);
  assert.match(managerLoginPage, /请检查用户名或管理密码后重试/);
  assert.match(managerLoginPage, /\/api\/manager\/session/);
  assert.match(managerLoginPage, /JSON\.stringify\(\{\s*username:\s*username\.value\.trim\(\),\s*password:\s*password\.value\s*\}\)/);
  assert.match(managerLoginPage, /credentials:\s*"same-origin"/);
  const managerAuthHtml = `${manager}\n${managerLoginPage}`;
  assert.doesNotMatch(managerAuthHtml, /\bprompt\b/i);
  assert.doesNotMatch(managerAuthHtml, /TOKEN_KEY|sessionStorage\.(?:getItem|setItem)/i);
  assert.equal((managerAuthHtml.match(/sessionStorage\.removeItem\("lucky_manager_token_v1"\)/g) ?? []).length, 2);
  assert.doesNotMatch(managerAuthHtml, /authorization|bearer/i);
  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(manifest, /"display": "standalone"/);
  assert.match(serviceWorker, /caches\.open\(CACHE\)/);
  assert.match(serviceWorker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /canonicalPathname/);
  assert.match(serviceWorker, /const CACHE = "lucky-scratch-v14"/);
  assert.match(serviceWorker, /pathname === "\/manager\/"/);
  assert.match(serviceWorker, /pathname === "\/manager-login\/"/);
  assert.match(serviceWorker, /pathname === "\/manager-login\.html"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/lottery-background.webp", import.meta.url));
  await access(new URL("../public/game-lottery-background.webp", import.meta.url));
  await access(new URL("../public/profile-lottery-background.webp", import.meta.url));
});

test("restored settled tickets do not replay the result poster", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const hydrate = page.slice(page.indexOf("const hydrate = async"), page.indexOf("// Keep operator settings current"));
  assert.match(hydrate, /settleLock\.current = Boolean\(restoredTicket\?\.settled\)/);
  assert.doesNotMatch(hydrate, /setShowResult\(Boolean\(restoredTicket\?\.settled\)\)/);
  assert.match(hydrate, /setShowResult\(false\)/);
  assert.equal((page.match(/setShowResult\(true\)/g) ?? []).length, 1);
});

test("removes the daily reward claim while preserving legacy history support", async () => {
  const [page, profile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/profile.html", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /\bclaimDaily\b|\bdailyAvailable\b|领取每日奖励|每日礼包|每日奖励/);
  assert.match(page, /className="stat-button stat-balance"/);
  assert.match(page, /setPanel\("topup"\)/);
  assert.match(page, /<span>代币余额 · 充值<\/span>/);
  assert.match(page, /formatTokens/);
  assert.match(profile, /daily:\s*\{[^}]*每日奖励/s);
  assert.match(profile, /topup:\s*\{[^}]*演示充值（未扣款）/s);
});

test("creates, checks, and expires an HttpOnly signed manager session", async () => {
  const db = createConfigDb();

  const wrongPassword = await managerLogin(db, "definitely-the-wrong-manager-password");
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.headers.get("set-cookie"), null);

  const noPassword = await apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({}),
  });
  assert.equal(noPassword.status, 400);
  assert.equal(noPassword.headers.get("set-cookie"), null);

  const wrongUsername = await managerLogin(db, MANAGER_PASSWORD, "NotAdmin");
  assert.equal(wrongUsername.status, 401);
  assert.equal(wrongUsername.headers.get("set-cookie"), null);

  const loggedIn = await managerLogin(db);
  assert.equal(loggedIn.status, 200);
  const loggedInBody = await loggedIn.clone().json();
  assert.equal(loggedInBody.authenticated, true);
  assert.equal(loggedInBody.username, MANAGER_USERNAME);
  assert.equal(Number.isSafeInteger(loggedInBody.expiresAt), true);

  const { setCookie, cookie } = readSessionCookie(loggedIn);
  assert.match(setCookie, new RegExp(`^${MANAGER_COOKIE_NAME}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`));
  assert.match(setCookie, /; Path=\//i);
  assert.match(setCookie, /; Max-Age=28800/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; SameSite=Strict/i);
  assert.doesNotMatch(setCookie, new RegExp(MANAGER_PASSWORD));
  assert.doesNotMatch(setCookie, new RegExp(MANAGER_SESSION_SECRET));
  assert.doesNotMatch(JSON.stringify(loggedInBody), new RegExp(MANAGER_PASSWORD));
  assert.doesNotMatch(JSON.stringify(loggedInBody), new RegExp(MANAGER_SESSION_SECRET));

  const session = await apiFetch(db, "/api/manager/session", { headers: { cookie } });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.username, MANAGER_USERNAME);
  assert.equal(sessionBody.expiresAt, loggedInBody.expiresAt);

  const noSession = await apiFetch(db, "/api/manager/session");
  assert.equal(noSession.status, 401);
  assert.deepEqual(await noSession.json(), { authenticated: false });

  const loggedOut = await apiFetch(db, "/api/manager/session", {
    method: "DELETE",
    headers: sameOriginHeaders({ cookie }),
  });
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(await loggedOut.json(), { authenticated: false });
  const logoutCookie = loggedOut.headers.get("set-cookie") ?? "";
  assert.match(logoutCookie, new RegExp(`^${MANAGER_COOKIE_NAME}=;`));
  assert.match(logoutCookie, /; Max-Age=0/i);
  assert.match(logoutCookie, /; Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
  assert.match(logoutCookie, /; HttpOnly/i);
  assert.match(logoutCookie, /; Secure/i);
  assert.match(logoutCookie, /; SameSite=Strict/i);
});

test("throttles manager login failures by opaque IP and normalized-username key", async () => {
  const db = createConfigDb();
  const connectingIp = "198.51.100.42";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = attempt % 2 === 0 ? "Admin" : "aDmIn";
    const failed = await managerLogin(db, `wrong-password-${attempt}`, username, connectingIp);
    assert.equal(failed.status, 401, `failure ${attempt + 1}`);
    assert.equal(failed.headers.get("retry-after"), null);
  }

  const rows = db.managerLoginThrottleRows();
  assert.equal(rows.length, 1, "username casing must share one throttle bucket");
  assert.equal(rows[0].failedAttempts, 5);
  assert.match(rows[0].key, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rows[0].key, connectingIp, "the persisted key must not expose the IP address");
  assert.equal(Object.hasOwn(rows[0], "username"), false);

  const blocked = await managerLogin(db, MANAGER_PASSWORD, MANAGER_USERNAME, connectingIp);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.equal(Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900, true);

  const otherIp = await managerLogin(db, MANAGER_PASSWORD, MANAGER_USERNAME, "198.51.100.43");
  assert.equal(otherIp.status, 200, "a different connecting IP must use a different bucket");

  db.ageManagerLoginThrottle(15 * 60 * 1000 + 1);
  const afterWindow = await managerLogin(db, MANAGER_PASSWORD, MANAGER_USERNAME, connectingIp);
  assert.equal(afterWindow.status, 200);
  assert.equal(db.managerLoginThrottleRows().length, 0, "a successful login must clear its failure bucket");

  const failedAgain = await managerLogin(db, "wrong-after-success", MANAGER_USERNAME, connectingIp);
  assert.equal(failedAgain.status, 401);
  assert.equal(db.managerLoginThrottleRows()[0].failedAttempts, 1);
  const reset = await managerLogin(db, MANAGER_PASSWORD, MANAGER_USERNAME, connectingIp);
  assert.equal(reset.status, 200);
  assert.equal(db.managerLoginThrottleRows().length, 0);
});

test("keeps a strong signing secret separate from the manager password", async () => {
  const db = createConfigDb();
  const shortSigningSecret = await apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: MANAGER_USERNAME, password: MANAGER_PASSWORD }),
  }, { MANAGER_TOKEN: "too-short" });
  assert.equal(shortSigningSecret.status, 503);

  const shortPassword = await apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: MANAGER_USERNAME, password: "1234567" }),
  }, { MANAGER_PASSWORD: "1234567" });
  assert.equal(shortPassword.status, 503);

  const legacyFallback = await apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username: MANAGER_USERNAME, password: MANAGER_SESSION_SECRET }),
  }, { MANAGER_PASSWORD: undefined });
  assert.equal(legacyFallback.status, 200);
});

test("changes the manager password in D1 without exposing or reviving credentials", async () => {
  const db = createConfigDb();
  const loggedIn = await managerLogin(db);
  assert.equal(loggedIn.status, 200);
  const { cookie } = readSessionCookie(loggedIn);

  const unauthorized = await apiFetch(db, "/api/manager/password", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newPassword: "ChangedPass123" }),
  });
  assert.equal(unauthorized.status, 401);

  const wrongCurrent = await apiFetch(db, "/api/manager/password", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "ChangedPass123" }),
  });
  assert.equal(wrongCurrent.status, 401);

  const tooShort = await apiFetch(db, "/api/manager/password", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newPassword: "short" }),
  });
  assert.equal(tooShort.status, 422);

  const changed = await apiFetch(db, "/api/manager/password", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newPassword: "ChangedPass123" }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ok: true });
  const refreshedPasswordCookie = readSessionCookie(changed).cookie;

  const stalePasswordSession = await apiFetch(db, "/api/manager/session", { headers: { cookie } });
  assert.equal(stalePasswordSession.status, 401);
  const refreshedPasswordSession = await apiFetch(db, "/api/manager/session", { headers: { cookie: refreshedPasswordCookie } });
  assert.equal(refreshedPasswordSession.status, 200);

  const oldPassword = await managerLogin(db, MANAGER_PASSWORD);
  assert.equal(oldPassword.status, 401);
  const newPassword = await managerLogin(db, "ChangedPass123");
  assert.equal(newPassword.status, 200);
  const recoveryToken = await managerLogin(db, MANAGER_SESSION_SECRET);
  assert.equal(recoveryToken.status, 200);

  const failingDb = { prepare() { throw new Error("D1 unavailable"); } };
  const oldPasswordDuringOutage = await managerLogin(failingDb, MANAGER_PASSWORD);
  assert.equal(oldPasswordDuringOutage.status, 503);
  const recoveryDuringOutage = await managerLogin(failingDb, MANAGER_SESSION_SECRET);
  assert.equal(recoveryDuringOutage.status, 503);

  const crossOrigin = await apiFetch(db, "/api/manager/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ currentPassword: "ChangedPass123", newPassword: "AnotherPass123" }),
  });
  assert.equal(crossOrigin.status, 403);
});

test("changes and persists the manager username behind the existing authenticated session", async () => {
  const db = createConfigDb();
  const loggedIn = await managerLogin(db);
  assert.equal(loggedIn.status, 200);
  const { cookie } = readSessionCookie(loggedIn);

  const wrongMethod = await apiFetch(db, "/api/manager/username", {
    method: "GET",
    headers: { cookie },
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const unauthorized = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: "Lucky_Admin2" }),
  });
  assert.equal(unauthorized.status, 401);

  const wrongContentType = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "text/plain" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: "Lucky_Admin2" }),
  });
  assert.equal(wrongContentType.status, 400);

  const malformed = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD }),
  });
  assert.equal(malformed.status, 400);

  const wrongCurrentPassword = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: "wrong-password", newUsername: "Lucky_Admin2" }),
  });
  assert.equal(wrongCurrentPassword.status, 401);

  const invalidUsernames = [
    "ab",
    "a".repeat(33),
    "2Admin",
    "Admin User",
    "Admin-User",
    "管理员",
  ];
  for (const newUsername of invalidUsernames) {
    const response = await apiFetch(db, "/api/manager/username", {
      method: "POST",
      headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
      body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername }),
    });
    assert.equal(response.status, 422, newUsername);
  }

  const unchanged = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: MANAGER_USERNAME }),
  });
  assert.equal(unchanged.status, 422);

  const caseOnlyChange = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: "admin" }),
  });
  assert.equal(caseOnlyChange.status, 422);

  const crossOrigin = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "https://example.com", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: "Lucky_Admin2" }),
  });
  assert.equal(crossOrigin.status, 403);

  const changed = await apiFetch(db, "/api/manager/username", {
    method: "POST",
    headers: sameOriginHeaders({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ currentPassword: MANAGER_PASSWORD, newUsername: "Lucky_Admin2" }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ok: true, username: "Lucky_Admin2" });
  const refreshedUsernameCookie = readSessionCookie(changed).cookie;

  const staleUsernameSession = await apiFetch(db, "/api/manager/session", { headers: { cookie } });
  assert.equal(staleUsernameSession.status, 401);
  const refreshedUsernameSession = await apiFetch(db, "/api/manager/session", { headers: { cookie: refreshedUsernameCookie } });
  assert.equal(refreshedUsernameSession.status, 200);
  assert.equal((await refreshedUsernameSession.json()).username, "Lucky_Admin2");

  const oldUsername = await managerLogin(db, MANAGER_PASSWORD, MANAGER_USERNAME);
  assert.equal(oldUsername.status, 401);
  assert.equal(oldUsername.headers.get("set-cookie"), null);

  const caseInsensitiveUsername = await managerLogin(db, MANAGER_PASSWORD, "lUcKy_aDmIn2");
  assert.equal(caseInsensitiveUsername.status, 200);
  assert.equal((await caseInsensitiveUsername.clone().json()).username, "Lucky_Admin2");

  const recoveryCredential = await managerLogin(db, MANAGER_SESSION_SECRET, "LUCKY_ADMIN2");
  assert.equal(recoveryCredential.status, 200);
});

test("gates encoded manager aliases before static routing", async () => {
  const db = createConfigDb();
  for (const path of ["/manager%2Ehtml", "/%6danager.html", "/manager-login%2Ehtml"]) {
    const response = await apiFetch(db, path, { redirect: "manual" });
    assert.equal(response.status, 302, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  }
});

test("redirects authenticated manager aliases to the canonical manager page", async () => {
  const db = createConfigDb();
  const loggedIn = await managerLogin(db);
  assert.equal(loggedIn.status, 200);
  const { cookie } = readSessionCookie(loggedIn);

  for (const path of ["/manager", "/manager/", "/manager%2Ehtml", "/%6danager.html"]) {
    const response = await apiFetch(db, path, {
      redirect: "manual",
      headers: { cookie },
    });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), `${API_ORIGIN}/manager.html`, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i, path);
  }
});

test("protects config writes with the signed session while keeping config reads public", async () => {
  const db = createConfigDb();
  const empty = await apiFetch(db);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { config: null, version: 0, updatedAt: 0 });

  const unauthorized = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 0 }),
  });
  assert.equal(unauthorized.status, 401);

  const loggedIn = await managerLogin(db);
  assert.equal(loggedIn.status, 200);
  const { cookie } = readSessionCookie(loggedIn);

  const tampered = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie: `${cookie}x` }),
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 0 }),
  });
  assert.equal(tampered.status, 401);

  const created = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 0 }),
  });
  assert.equal(created.status, 200);
  const first = await created.json();
  assert.equal(first.version, 1);
  assert.equal(first.config.updatedAt, first.updatedAt);
  assert.deepEqual(first.config.topups, VALID_CONFIG.topups);
  assert.deepEqual(first.config.economy, VALID_CONFIG.economy);

  const stale = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 0 }),
  });
  assert.equal(stale.status, 409);

  const updated = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: { ...VALID_CONFIG, multiplierMinLevel: 4, topups: [{ id: "mega", price: 49.9, coins: 80000 }] }, expectedVersion: 1 }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.version, 2);
  assert.deepEqual(updatedBody.config.topups, [{ id: "mega", price: 49.9, coins: 80000 }]);
  assert.deepEqual(updatedBody.config.economy, VALID_CONFIG.economy);

  const disabledTopups = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: { ...VALID_CONFIG, multiplierMinLevel: 4, topups: [] }, expectedVersion: 2 }),
  });
  assert.equal(disabledTopups.status, 200);
  const disabledBody = await disabledTopups.json();
  assert.equal(disabledBody.version, 3);
  assert.deepEqual(disabledBody.config.topups, []);

  const publicConfig = await apiFetch(db);
  assert.equal(publicConfig.status, 200);
  const publicBody = await publicConfig.json();
  assert.equal(publicBody.version, 3);
  assert.equal(publicBody.config.multiplierMinLevel, 4);
  assert.deepEqual(publicBody.config.topups, []);

  const crossOrigin = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 3 }),
  });
  assert.equal(crossOrigin.status, 403);

  const crossSiteHeader = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, origin: API_ORIGIN, "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 3 }),
  });
  assert.equal(crossSiteHeader.status, 403);

  const crossOriginLogin = await apiFetch(db, "/api/manager/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ username: MANAGER_USERNAME, password: MANAGER_PASSWORD }),
  });
  assert.equal(crossOriginLogin.status, 403);

  const crossOriginLogout = await apiFetch(db, "/api/manager/session", {
    method: "DELETE",
    headers: { cookie, origin: "https://example.com", "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossOriginLogout.status, 403);
});

test("validates top-up packages and preserves them for legacy manager writes", async () => {
  const productionLegacyConfig = { ...VALID_CONFIG, topups: LEGACY_DEFAULT_TOPUPS };
  delete productionLegacyConfig.economy;
  const productionLegacyDb = createConfigDb(productionLegacyConfig);
  const migratedLegacyRead = await apiFetch(productionLegacyDb);
  assert.equal(migratedLegacyRead.status, 200);
  const migratedLegacyBody = await migratedLegacyRead.json();
  assert.deepEqual(migratedLegacyBody.config.topups, NATURAL_DEFAULT_TOPUPS);
  assert.deepEqual(migratedLegacyBody.config.economy, { coinsPerToken: 50, myrPerToken: 1 });

  const customTopups = [{ id: "starter", price: 4.9, coins: 5001 }];
  const customLegacyDb = createConfigDb({ ...VALID_CONFIG, topups: customTopups });
  const customLegacyRead = await apiFetch(customLegacyDb);
  assert.equal(customLegacyRead.status, 200);
  assert.deepEqual((await customLegacyRead.json()).config.topups, customTopups);

  const db = createConfigDb();
  const loggedIn = await managerLogin(db);
  const { cookie } = readSessionCookie(loggedIn);

  const created = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: VALID_CONFIG, expectedVersion: 0 }),
  });
  assert.equal(created.status, 200);

  const legacyConfig = { ...VALID_CONFIG, multiplierMinLevel: 8 };
  delete legacyConfig.topups;
  const legacyUpdate = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: legacyConfig, expectedVersion: 1 }),
  });
  assert.equal(legacyUpdate.status, 200);
  assert.deepEqual((await legacyUpdate.json()).config.topups, VALID_CONFIG.topups);

  const outageDb = {
    prepare(sql) {
      if (/SELECT config_json/i.test(sql)) {
        return {
          bind() { return this; },
          async first() { throw new Error("sensitive D1 diagnostic"); },
        };
      }
      return db.prepare(sql);
    },
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const unavailable = await apiFetch(outageDb, "/api/config", {
      method: "PUT",
      headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
      body: JSON.stringify({ config: legacyConfig, expectedVersion: 2 }),
    });
    assert.equal(unavailable.status, 503);
    const unavailableBody = await unavailable.json();
    assert.equal(unavailableBody.error, "Shared configuration storage is temporarily unavailable");
    assert.doesNotMatch(JSON.stringify(unavailableBody), /sensitive D1 diagnostic/);
  } finally {
    console.error = originalConsoleError;
  }

  const invalidTopups = [
    "not-an-array",
    Array.from({ length: 21 }, (_, index) => ({ id: `pkg_${index}`, price: 1, coins: 1 })),
    [{ id: "same", price: 1, coins: 1 }, { id: "SAME", price: 2, coins: 2 }],
    [{ id: "bad id", price: 1, coins: 1 }],
    [{ id: "free", price: 0, coins: 1 }],
    [{ id: "mills", price: 1.001, coins: 1 }],
    [{ id: "fractional", price: 1, coins: 1.5 }],
    [{ id: "empty", price: 1, coins: 0 }],
  ];

  for (const topups of invalidTopups) {
    const response = await apiFetch(db, "/api/config", {
      method: "PUT",
      headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
      body: JSON.stringify({ config: { ...VALID_CONFIG, topups }, expectedVersion: 2 }),
    });
    assert.equal(response.status, 422, JSON.stringify(topups).slice(0, 120));
  }

  const legacyDb = createConfigDb();
  const legacyLogin = await managerLogin(legacyDb);
  const legacyCookie = readSessionCookie(legacyLogin).cookie;
  const firstLegacyConfig = { ...VALID_CONFIG };
  delete firstLegacyConfig.topups;
  const legacyCreate = await apiFetch(legacyDb, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie: legacyCookie }),
    body: JSON.stringify({ config: firstLegacyConfig, expectedVersion: 0 }),
  });
  assert.equal(legacyCreate.status, 200);
  assert.equal((await legacyCreate.json()).config.topups.length > 0, true);
});

test("validates token economy settings and preserves them for legacy manager writes", async () => {
  const db = createConfigDb();
  const login = await managerLogin(db);
  const { cookie } = readSessionCookie(login);
  const configured = { ...VALID_CONFIG, economy: { coinsPerToken: 40, myrPerToken: 1.25 } };
  const created = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: configured, expectedVersion: 0 }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).config.economy, configured.economy);

  const legacyConfig = { ...VALID_CONFIG };
  delete legacyConfig.economy;
  const preserved = await apiFetch(db, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ config: legacyConfig, expectedVersion: 1 }),
  });
  assert.equal(preserved.status, 200);
  assert.deepEqual((await preserved.json()).config.economy, configured.economy);

  const invalidEconomies = [
    null,
    { coinsPerToken: 0, myrPerToken: 1 },
    { coinsPerToken: 1.5, myrPerToken: 1 },
    { coinsPerToken: 50, myrPerToken: 0 },
    { coinsPerToken: 50, myrPerToken: 1.001 },
    { coinsPerToken: 1000001, myrPerToken: 1 },
    { coinsPerToken: 50, myrPerToken: "1" },
  ];
  for (const economy of invalidEconomies) {
    const response = await apiFetch(db, "/api/config", {
      method: "PUT",
      headers: sameOriginHeaders({ "content-type": "application/json", cookie }),
      body: JSON.stringify({ config: { ...VALID_CONFIG, economy }, expectedVersion: 2 }),
    });
    assert.equal(response.status, 422, JSON.stringify(economy));
  }

  const freshDb = createConfigDb();
  const freshCookie = readSessionCookie(await managerLogin(freshDb)).cookie;
  const missingEconomy = { ...VALID_CONFIG };
  delete missingEconomy.economy;
  const legacyCreate = await apiFetch(freshDb, "/api/config", {
    method: "PUT",
    headers: sameOriginHeaders({ "content-type": "application/json", cookie: freshCookie }),
    body: JSON.stringify({ config: missingEconomy, expectedVersion: 0 }),
  });
  assert.equal(legacyCreate.status, 200);
  assert.deepEqual((await legacyCreate.json()).config.economy, { coinsPerToken: 50, myrPerToken: 1 });
});
