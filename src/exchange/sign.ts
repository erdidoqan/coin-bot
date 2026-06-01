function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

export async function signRequest(queryString: string, secret: string): Promise<string> {
  return hmacSha256Hex(queryString, secret);
}

export async function buildSignedQuery(
  params: Record<string, string | number | boolean | undefined>,
  secret: string,
): Promise<string> {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const timestamp = Date.now();
  const withMeta: Array<[string, string]> = [
    ...entries.map(([k, v]) => [k, v] as [string, string]),
    ['timestamp', String(timestamp)],
    ['recvWindow', '5000'],
  ];

  const query = new URLSearchParams(withMeta).toString();
  const signature = await signRequest(query, secret);
  return `${query}&signature=${signature}`;
}
