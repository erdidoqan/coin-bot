/** Dip Reversal — Aday Uygunluk manuel sabitleme + giriş fiyatı takibi (localStorage). */

const STORAGE_KEY = 'dip-reversal-candidate-pins';

export interface DipPinTrack {
  entryMid: number;
  pinnedAt: string;
  /** Girişten itibaren en düşük % (≤ 0). */
  maxDropPct: number;
  /** Girişten itibaren en yüksek % (≥ 0). */
  maxRisePct: number;
}

export interface DipPinStorage {
  order: string[];
  tracks: Record<string, DipPinTrack>;
}

const EMPTY: DipPinStorage = { order: [], tracks: {} };

export function loadDipPinState(): DipPinStorage {
  if (typeof window === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { order: parsed.filter((s): s is string => typeof s === 'string' && s.length > 0), tracks: {} };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { order?: unknown; tracks?: unknown };
      const order = Array.isArray(obj.order)
        ? obj.order.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      const tracks: Record<string, DipPinTrack> = {};
      if (obj.tracks && typeof obj.tracks === 'object') {
        for (const [sym, t] of Object.entries(obj.tracks as Record<string, unknown>)) {
          const tr = parseTrack(t);
          if (tr) tracks[sym] = tr;
        }
      }
      return { order, tracks };
    }
  } catch {
    /* ignore */
  }
  return { ...EMPTY };
}

function parseTrack(t: unknown): DipPinTrack | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const entryMid = Number(o.entryMid);
  if (!Number.isFinite(entryMid) || entryMid <= 0) return null;
  const pinnedAt = typeof o.pinnedAt === 'string' ? o.pinnedAt : new Date().toISOString();
  const maxDropPct = Number(o.maxDropPct);
  const maxRisePct = Number(o.maxRisePct);
  return {
    entryMid,
    pinnedAt,
    maxDropPct: Number.isFinite(maxDropPct) ? maxDropPct : 0,
    maxRisePct: Number.isFinite(maxRisePct) ? maxRisePct : 0,
  };
}

export function saveDipPinState(state: DipPinStorage): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

/** @deprecated use loadDipPinState */
export function loadDipCandidatePins(): string[] {
  return loadDipPinState().order;
}

function parseMid(mid: string | null | undefined): number | null {
  if (mid == null || mid === '') return null;
  const n = Number(mid);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function newTrack(entryMid: number): DipPinTrack {
  return {
    entryMid,
    pinnedAt: new Date().toISOString(),
    maxDropPct: 0,
    maxRisePct: 0,
  };
}

export function toggleDipPin(
  state: DipPinStorage,
  symbol: string,
  mid: string | null,
): DipPinStorage {
  if (state.order.includes(symbol)) {
    const order = state.order.filter((s) => s !== symbol);
    const { [symbol]: _removed, ...tracks } = state.tracks;
    return { order, tracks };
  }
  const entryMid = parseMid(mid);
  const order = [...state.order, symbol];
  const tracks = { ...state.tracks };
  if (entryMid != null) tracks[symbol] = newTrack(entryMid);
  return { order, tracks };
}

export function clearDipPins(): DipPinStorage {
  return { ...EMPTY };
}

/** Canlı mid ile giriş eksikse doldurur; max düşüş / max yükseliş günceller. */
export function updateDipPinTracks(
  state: DipPinStorage,
  midsBySymbol: Map<string, string | null>,
): DipPinStorage {
  if (state.order.length === 0) return state;
  let changed = false;
  const tracks = { ...state.tracks };

  for (const symbol of state.order) {
    const mid = parseMid(midsBySymbol.get(symbol) ?? null);
    if (mid == null) continue;

    let track = tracks[symbol];
    if (!track) {
      tracks[symbol] = newTrack(mid);
      changed = true;
      continue;
    }

    const pct = ((mid - track.entryMid) / track.entryMid) * 100;
    const maxDropPct = Math.min(track.maxDropPct, pct);
    const maxRisePct = Math.max(track.maxRisePct, pct);
    if (maxDropPct !== track.maxDropPct || maxRisePct !== track.maxRisePct) {
      tracks[symbol] = { ...track, maxDropPct, maxRisePct };
      changed = true;
    }
  }

  return changed ? { ...state, tracks } : state;
}

export function currentPctFromEntry(track: DipPinTrack, mid: string | null): number | null {
  const now = parseMid(mid);
  if (now == null) return null;
  return ((now - track.entryMid) / track.entryMid) * 100;
}

export interface DipCandidateSortable {
  symbol: string;
  pinned?: boolean;
  ready: boolean;
  gatesPassed: number;
  reversalScore: number;
}

export interface DipLiveMergeable {
  symbol: string;
  mid: string | null;
  windowDropPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
  flashDrop3mPct: number | null;
  wsDeclinePct: number | null;
  recoveryFromWsLowPct: number | null;
  reversalScore: number;
  secSinceTrough: number | null;
  midSlopeOk: boolean;
  gates: Array<{ id: string; pass: boolean; actual: number | null; threshold: string }>;
  gatesPassed: number;
  gatesTotal: number;
  excluded: string | null;
  ready: boolean;
  score: number | null;
  primaryBlocker: string | null;
  pinned?: boolean;
}

function dipLiveKlineUpdated(fresh: DipLiveMergeable): boolean {
  return (
    fresh.windowDropPct != null ||
    fresh.change1mPct != null ||
    fresh.change3mPct != null ||
    fresh.change10mPct != null ||
    fresh.change30mPct != null ||
    fresh.flashDrop3mPct != null
  );
}

/** Canlı poll: WS alanları her zaman; kline/kapı yalnızca bu turda DO'dan geldiyse. */
export function mergeDipLiveCandidate<T extends DipLiveMergeable>(old: T, fresh: T): T {
  const klineUpdated = dipLiveKlineUpdated(fresh);
  return {
    ...old,
    mid: fresh.mid ?? old.mid,
    wsDeclinePct: fresh.wsDeclinePct ?? old.wsDeclinePct,
    recoveryFromWsLowPct: fresh.recoveryFromWsLowPct ?? old.recoveryFromWsLowPct,
    reversalScore: fresh.reversalScore,
    secSinceTrough: fresh.secSinceTrough,
    midSlopeOk: fresh.midSlopeOk,
    excluded: fresh.excluded ?? old.excluded,
    pinned: fresh.pinned ?? old.pinned,
    windowDropPct: fresh.windowDropPct ?? old.windowDropPct,
    change1mPct: fresh.change1mPct ?? old.change1mPct,
    change3mPct: fresh.change3mPct ?? old.change3mPct,
    change10mPct: fresh.change10mPct ?? old.change10mPct,
    change30mPct: fresh.change30mPct ?? old.change30mPct,
    flashDrop3mPct: fresh.flashDrop3mPct ?? old.flashDrop3mPct,
    gates: klineUpdated ? fresh.gates : old.gates,
    gatesPassed: klineUpdated ? fresh.gatesPassed : old.gatesPassed,
    gatesTotal: klineUpdated ? fresh.gatesTotal : old.gatesTotal,
    ready: klineUpdated ? fresh.ready : old.ready,
    score: klineUpdated ? fresh.score : old.score,
    primaryBlocker: klineUpdated ? fresh.primaryBlocker : old.primaryBlocker,
  };
}

export function mergeDipLiveCandidates<T extends DipLiveMergeable>(prev: T[], patch: T[]): T[] {
  const patchBySym = new Map(patch.map((c) => [c.symbol, c]));
  const merged = prev.map((old) => {
    const fresh = patchBySym.get(old.symbol);
    return fresh ? mergeDipLiveCandidate(old, fresh) : old;
  });
  const prevSyms = new Set(prev.map((c) => c.symbol));
  for (const c of patch) {
    if (!prevSyms.has(c.symbol)) merged.push(c);
  }
  return merged;
}

/** Manuel sabit → açık pozisyon → hazır / kapı / skor. */
export function sortDipCandidatesForDisplay<T extends DipCandidateSortable>(
  rows: T[],
  manualPins: string[],
): T[] {
  const manualSet = new Set(manualPins);
  const manualIndex = new Map(manualPins.map((s, i) => [s, i]));
  const positionOnlyOrder = rows
    .filter((r) => Boolean(r.pinned) && !manualSet.has(r.symbol))
    .map((r) => r.symbol);
  const positionIndex = new Map(positionOnlyOrder.map((s, i) => [s, i]));

  return [...rows].sort((a, b) => {
    const aManual = manualSet.has(a.symbol);
    const bManual = manualSet.has(b.symbol);
    if (aManual !== bManual) return aManual ? -1 : 1;
    if (aManual && bManual) {
      return (manualIndex.get(a.symbol) ?? 0) - (manualIndex.get(b.symbol) ?? 0);
    }

    const aPos = Boolean(a.pinned);
    const bPos = Boolean(b.pinned);
    if (aPos !== bPos) return aPos ? -1 : 1;
    if (aPos && bPos) {
      return (positionIndex.get(a.symbol) ?? 0) - (positionIndex.get(b.symbol) ?? 0);
    }

    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (b.gatesPassed !== a.gatesPassed) return b.gatesPassed - a.gatesPassed;
    return b.reversalScore - a.reversalScore;
  });
}
