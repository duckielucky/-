interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
  error?: string;
  meta: { changes?: number; [key: string]: unknown };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    MANAGER_TOKEN?: string;
    MANAGER_PASSWORD?: string;
    PLAYER_SESSION_SECRET?: string;
    [key: string]: unknown;
  };
}
