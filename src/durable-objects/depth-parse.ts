export type DepthLevel = [string, string];

interface DepthPayload {
  e?: string;
  s?: string;
  b?: DepthLevel[];
  a?: DepthLevel[];
  bids?: DepthLevel[];
  asks?: DepthLevel[];
}

/** @depth20@100ms = Partial Book (bids/asks, sembol yok); @depth = diff (b/a + s) */
export function parseDepthMessage(
  data: unknown,
  stream?: string,
): { symbol: string; bids: DepthLevel[]; asks: DepthLevel[] } | null {
  const d = data as DepthPayload;
  const bids = d.bids ?? d.b;
  const asks = d.asks ?? d.a;
  if (!bids?.length || !asks?.length) return null;

  let symbol = d.s?.toUpperCase() ?? null;
  if (!symbol && stream) {
    const head = stream.split('@')[0]?.toUpperCase();
    if (head?.endsWith('USDT')) symbol = head;
  }
  if (!symbol) return null;

  return { symbol, bids, asks };
}
