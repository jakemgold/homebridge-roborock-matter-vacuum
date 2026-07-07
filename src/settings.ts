import type { PlatformConfig } from 'homebridge';

export const PLATFORM_NAME = 'RoborockMatter';
export const PLUGIN_NAME = 'homebridge-roborock-matter-vacuum';

export type CleanModeTag = 'vacuum' | 'mop' | 'vacuumAndMop';
export type CleanModeIntensity =
  | 'auto'
  | 'quick'
  | 'quiet'
  | 'lowNoise'
  | 'lowEnergy'
  | 'min'
  | 'max'
  | 'night'
  | 'day'
  | 'deepClean'
  | 'vacation';
export type AreaKind = 'room' | 'zone';

export interface RoborockMatterConfig extends PlatformConfig {
  platform: typeof PLATFORM_NAME;
  name?: string;
  username?: string;
  password?: string;
  region?: RoborockCloudRegion;
  baseUrl?: string;
  verificationCode?: string;
  language?: string;
  skipDevices?: string[];
  pollingIntervalSeconds?: number;
  forceRoomRediscovery?: boolean;
  roomDiscoveryCacheTtlHours?: number;
  vacuums?: RoborockVacuumConfig[];
}

export interface RoborockVacuumConfig {
  name: string;
  duid?: string;
  id?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  pollingIntervalSeconds?: number;
  cleanModes?: CleanModeConfig[];
  enableMoppingModes?: boolean;
  defaultCleanMode?: number;
  forceRoomRediscovery?: boolean;
  roomDiscoveryCacheTtlHours?: number;
  segmentCleanPayload?: SegmentCleanPayload;
  roomNameOverrides?: RoomNameOverrideConfig[];
  roomNamesByMap?: Record<string, string[]>;
  serviceMaps?: ServiceMapConfig[];
  serviceAreas?: ServiceAreaConfig[];
}

export type SegmentCleanPayload = 'segmentsObject' | 'segmentIds';
export type RoborockCloudRegion = 'us' | 'eu' | 'cn' | 'sg';

export interface CleanModeConfig {
  mode: number;
  label: string;
  tag: CleanModeTag;
  intensity?: CleanModeIntensity;
  fanPower?: number;
  waterBoxMode?: number;
}

export interface ServiceAreaConfig {
  areaId: number;
  label: string;
  kind?: AreaKind;
  mapId?: number;
  mapName?: string;
  roborockMapId?: number;
  segmentId?: number;
  roomId?: string;
  coordinates?: [number, number, number, number];
  repeat?: number;
}

export interface ServiceMapConfig {
  mapId: number;
  name: string;
}

export interface RoomNameOverrideConfig {
  label: string;
  mapId?: number;
  mapName?: string;
  areaId?: number;
  segmentId?: number;
  roomId?: string;
}

export const DEFAULT_POLLING_INTERVAL_SECONDS = 60;

export const DEFAULT_CLEAN_MODES: CleanModeConfig[] = [
  {
    mode: 0,
    label: 'Balanced',
    tag: 'vacuum',
    intensity: 'auto',
    fanPower: 102,
  },
  {
    mode: 1,
    label: 'Quiet',
    tag: 'vacuum',
    intensity: 'quiet',
    fanPower: 101,
  },
  {
    mode: 2,
    label: 'Turbo',
    tag: 'vacuum',
    intensity: 'quick',
    fanPower: 103,
  },
  {
    mode: 3,
    label: 'Max',
    tag: 'vacuum',
    intensity: 'max',
    fanPower: 104,
  },
];

export const DEFAULT_VACUUM_AND_MOP_CLEAN_MODES: CleanModeConfig[] = [
  {
    mode: 4,
    label: 'Light Vacuum & Mop',
    tag: 'vacuumAndMop',
    intensity: 'lowEnergy',
    fanPower: 102,
    waterBoxMode: 201,
  },
  {
    mode: 5,
    label: 'Medium Vacuum & Mop',
    tag: 'vacuumAndMop',
    intensity: 'auto',
    fanPower: 102,
    waterBoxMode: 202,
  },
  {
    mode: 6,
    label: 'High Vacuum & Mop',
    tag: 'vacuumAndMop',
    intensity: 'max',
    fanPower: 102,
    waterBoxMode: 203,
  },
];

export const DEFAULT_MOP_ONLY_CLEAN_MODES: CleanModeConfig[] = [
  {
    mode: 7,
    label: 'Light Mop',
    tag: 'mop',
    intensity: 'lowEnergy',
    fanPower: 105,
    waterBoxMode: 201,
  },
  {
    mode: 8,
    label: 'Medium Mop',
    tag: 'mop',
    intensity: 'auto',
    fanPower: 105,
    waterBoxMode: 202,
  },
  {
    mode: 9,
    label: 'High Mop',
    tag: 'mop',
    intensity: 'max',
    fanPower: 105,
    waterBoxMode: 203,
  },
];
