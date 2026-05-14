/**
 * API client with runtime config loading.
 *
 * Config is loaded from /config.json at app startup (injected by CDK deploy).
 * This avoids rebuilding the frontend when API URLs change.
 */

interface RuntimeConfig {
  apiUrl: string;
  wsUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
}

let config: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<void> {
  const res = await fetch("/config.json");
  config = await res.json();
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!config) throw new Error("Runtime config not loaded");
  return config;
}

let getTokenFn: (() => Promise<string>) | null = null;

export function setTokenProvider(fn: () => Promise<string>) {
  getTokenFn = fn;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getTokenFn ? await getTokenFn() : "";
  const base = config!.apiUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return {} as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};
