import { BinanceApiError } from './binance';

/**
 * Binance HTTP çağrısı. BINANCE_PROXY_URL tanımlıysa istek sabit IP'li
 * forward proxy üzerinden gider (API secret yine Worker'da kalır).
 */
export async function fetchBinance(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const proxyBase = env.BINANCE_PROXY_URL?.trim().replace(/\/$/, '');
  if (!proxyBase) {
    return fetch(url, init);
  }

  const proxySecret = env.BINANCE_PROXY_SECRET?.trim();
  if (!proxySecret) {
    throw new BinanceApiError('BINANCE_PROXY_URL tanımlı ama BINANCE_PROXY_SECRET yok', undefined, 500);
  }

  const allowedBase = env.BINANCE_BASE_URL.replace(/\/$/, '');
  if (!url.startsWith(allowedBase)) {
    throw new BinanceApiError('Proxy yalnızca BINANCE_BASE_URL isteklerine izin verir', undefined, 400);
  }

  const headers = new Headers(init.headers);
  const forwardRes = await fetch(`${proxyBase}/forward`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Secret': proxySecret,
    },
    body: JSON.stringify({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    }),
  });

  if (forwardRes.status === 401) {
    throw new BinanceApiError('BINANCE_PROXY_AUTH: geçersiz proxy secret', undefined, 401);
  }
  if (forwardRes.status === 502) {
    const detail = await forwardRes.text();
    throw new BinanceApiError(`BINANCE_PROXY_UPSTREAM: ${detail.slice(0, 200)}`, undefined, 502);
  }

  return forwardRes;
}

export function usesBinanceProxy(env: Env): boolean {
  return Boolean(env.BINANCE_PROXY_URL?.trim());
}
