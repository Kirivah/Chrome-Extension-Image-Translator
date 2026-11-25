interface NRect { x: number; y: number; w: number; h: number }

interface Region {
  i?: number;
  p: NRect;
  a: NRect;
  m: 0 | 1 | 2;
  im?: string;
  bg: string;
  fg: string;
  ol: string;
  v: boolean;
  t: string;
  g?: number;
  e?: [number, number, number, number];
}

type ErrCode =
  | 'nokey' | 'auth' | 'nomodel' | 'quota' | 'budget' | 'blocked' | 'model'
  | 'net' | 'fetch' | 'decode' | 'busy' | 'off' | 'bad' | 'cancelled' | 'internal';

type CaptureCap = 0 | 1 | 2;

interface ContentConfig {
  on: boolean;
  gen: string;
  lang: string;
  minSide: number;
  prefetch: number;
  font: string;
  bold: boolean;
  textScale: number;
  caps: boolean;
}

type CsToSw =
  | { t: 'job'; id: number; u: string; p: number; l: CaptureCap }
  | { t: 'prio'; id: number; p: number }
  | { t: 'cancel'; id: number }
  | { t: 'bytes'; id: number; b: string | null }
  | { t: 'ahead'; u: string; n: boolean };

type SwToCs =
  | { t: 'cfg'; c: ContentConfig }
  | { t: 'part'; id: number; r: Region[] }
  | { t: 'drop'; id: number; k: number[] }
  | { t: 'done'; id: number; n: number }
  | { t: 'err'; id: number; e: ErrCode }
  | { t: 'need'; id: number };

type SwToTab =
  | { t: 'cmd'; c: 'rescan' | 'original'; v?: boolean }
  | { t: 'wake' };

type UiToSw =
  | { t: 'ui:settings' }
  | { t: 'ui:state'; tabId: number }
  | { t: 'ui:site'; tabId: number; on: boolean }
  | { t: 'ui:cmd'; tabId: number; c: 'rescan' | 'original'; v?: boolean }
  | { t: 'ui:testKey' }
  | { t: 'ui:keyChanged' }
  | { t: 'ui:clearCache' }
  | { t: 'ui:cacheStats' };

interface Settings {
  v: number;
  model: string;
  customModel: string;
  tier: 'free' | 'paid';
  lang: string;
  sites: string[];
  allSites: boolean;
  rpm: number;
  concurrency: number;
  batch: number;
  dailyBudget: number;
  dailyRequests: number;
  maxSide: number;
  economy: boolean;
  transcribe: boolean;
  minSide: number;
  prefetch: number;
  sensitivity: number;
  font: string;
  bold: boolean;
  textScale: number;
  caps: boolean;
}

interface ModelInfo {
  id: string;
  label: string;
  inUsd: number;
  outUsd: number;
  gen: 2 | 3;
}

interface Usage {
  day: string;
  req: number;
  img: number;
  hits: number;
  inTok: number;
  outTok: number;
  cost: number;
}

interface TabStatus {
  count: number;
  lastError: ErrCode | '';
  detail: string;
}

interface UiState {
  ok: boolean;
  origin: string;
  supported: boolean;
  enabled: boolean;
  allSites: boolean;
  perm: boolean;
  hasKey: boolean;
  lang: string;
  model: string;
  usage: Usage;
  settings: Settings;
  tab: TabStatus;
  work: WorkStatus;
}

interface WorkStatus {
  pending: number;
  waitMs: number;
  limited: boolean;
  slow: boolean;
}
