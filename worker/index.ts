/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleConfigApi } from "./config-api";
import { handlePlayerApi } from "./player-api";
import { handleManagerPlayersApi } from "./manager-players";
import { handleManagerSupportApi } from "./manager-support";
import {
  handleManagerAuthApi,
  handleManagerPageGate,
  isManagerLoginPagePath,
  isManagerPagePath,
  secureManagerPageResponse,
} from "./manager-auth";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  MANAGER_TOKEN?: string;
  MANAGER_PASSWORD?: string;
  PLAYER_SESSION_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const managerAuthResponse = await handleManagerAuthApi(request, env);
    if (managerAuthResponse) return managerAuthResponse;

    const managerPlayersResponse = await handleManagerPlayersApi(request, env);
    if (managerPlayersResponse) return managerPlayersResponse;

    const managerSupportResponse = await handleManagerSupportApi(request, env);
    if (managerSupportResponse) return managerSupportResponse;

    const managerPageGateResponse = await handleManagerPageGate(request, env);
    if (managerPageGateResponse) return managerPageGateResponse;

    const configResponse = await handleConfigApi(request, env);
    if (configResponse) return configResponse;

    const playerResponse = await handlePlayerApi(request, env);
    if (playerResponse) return playerResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    if (isManagerPagePath(url.pathname) || isManagerLoginPagePath(url.pathname)) {
      return secureManagerPageResponse(response);
    }
    return response;
  },
};

export default worker;
