import type { Logger } from 'homebridge';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RoborockCloudApi as Roborock,
  type RoborockCloudDevice,
  type RoborockDpsUpdate,
} from './roborockCloudApi';
import type { RoborockStatus, RoborockStatusListener, RoborockVacuumClient } from './roborockClient';
import { formatRoborockError, isCloudAckTimeout } from './roborockErrors';
import type {
  CleanModeConfig,
  RoborockCloudRegion,
  RoborockMatterConfig,
  RoborockVacuumConfig,
  RoomNameOverrideConfig,
  ServiceAreaConfig,
  ServiceMapConfig,
} from './settings';

type RawRoborockStatus = {
  state?: number;
  battery?: number;
  error_code?: number;
  fan_power?: number;
  water_box_mode?: number;
  mop_mode?: number;
  in_cleaning?: number;
  clean_area?: number;
  clean_time?: number;
  map_status?: number;
};

const ROBOROCK_BASE_URLS: Record<RoborockCloudRegion, string> = {
  us: 'usiot.roborock.com',
  eu: 'euiot.roborock.com',
  cn: 'cniot.roborock.com',
  sg: 'api.roborock.com',
};

const ALLOWED_ROBOROCK_BASE_URLS = new Set(Object.values(ROBOROCK_BASE_URLS));

type LegacyCloudOverride = RoborockVacuumConfig & {
  connection?: string;
};

type ServiceAreaDiscovery = {
  serviceAreas: ServiceAreaConfig[];
  serviceMaps: ServiceMapConfig[];
};

type RoomMappingRead = {
  payload: unknown;
  staleDuplicateOf?: ServiceMapConfig;
};

type CachedServiceAreaDiscovery = ServiceAreaDiscovery & {
  updatedAt: string;
};

type ServiceAreaDiscoveryCache = {
  version: number;
  devices: Record<string, CachedServiceAreaDiscovery | undefined>;
};

type DiscoveredMap = ServiceMapConfig & {
  rooms: ServiceAreaConfig[];
};

type NormalizedRoomMappingEntry = {
  segmentId: number;
  roomId?: string;
};

const SERVICE_AREA_CACHE_FILE = 'service-area-cache.json';
const SERVICE_AREA_CACHE_VERSION = 9;
const PRIVATE_CACHE_DIRECTORY_MODE = 0o700;
const PRIVATE_CACHE_FILE_MODE = 0o600;
const MAP_AREA_ID_MULTIPLIER = 100_000;
const DEFAULT_ROOM_DISCOVERY_CACHE_TTL_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAP_DISCOVERY_SETTLE_MS = 3_000;
const MAP_DISCOVERY_UNCONFIRMED_SETTLE_MS = 10_000;
const MAP_DISCOVERY_CONFIRM_TIMEOUT_MS = 18_000;
const MAP_DISCOVERY_CONFIRM_INTERVAL_MS = 2_000;
const COMMAND_MAP_STATUS_TIMEOUT_MS = 2_000;
const ROOM_MAPPING_STALE_RETRY_TIMEOUT_MS = 15_000;
const ROOM_MAPPING_STALE_RETRY_INTERVAL_MS = 3_000;
const ROBOROCK_NO_MAP_ID = 63;
const MAP_SWITCH_SAFE_STATES = new Set([3, 8, 100]);

export type CloudVacuumRegistration = {
  config: RoborockVacuumConfig;
  client: RoborockCloudVacuumClient;
};

class DeviceOperationCoordinator {
  private readonly exclusiveLocks = new Map<string, Promise<void>>();

  public async runExclusive<T>(duid: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveLocks.get(duid) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);

    this.exclusiveLocks.set(duid, current);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();

      if (this.exclusiveLocks.get(duid) === current) {
        this.exclusiveLocks.delete(duid);
      }
    }
  }

  public async waitForExclusive(duid: string): Promise<void> {
    await this.exclusiveLocks.get(duid)?.catch(() => undefined);
  }
}

export class RoborockCloudConnection {
  private roborock?: Roborock;
  private readonly deviceOperations = new DeviceOperationCoordinator();
  private readonly repeatedMapLabelWarnings = new Set<string>();

  constructor(
    private readonly config: RoborockMatterConfig,
    private readonly log: Logger,
    private readonly storagePath: string,
  ) {}

  public async start(): Promise<void> {
    if (this.roborock?.isInited()) {
      return;
    }

    if (!this.config.username) {
      throw new Error('Roborock username is required for cloud connection.');
    }

    this.roborock = new Roborock({
      username: this.config.username,
      password: this.config.password,
      baseURL: this.resolveBaseUrl(),
      language: this.config.language ?? 'en',
      updateInterval: Math.max(this.config.pollingIntervalSeconds ?? 60, 60),
      storagePath: this.storagePath,
      skipDevices: this.config.skipDevices,
      log: this.log,
    });
    this.roborock.setDeviceNotify(() => undefined);

    await this.startRoborockService();
    await this.waitForMqttConnection();

    if (!this.roborock.isInited() && this.roborock.authState?.twoFactorRequired && this.config.verificationCode) {
      this.log.info('Completing Roborock email verification with the configured one-time code.');
      await this.roborock.verifyTwoFactorCode(this.config.verificationCode);
      await this.startRoborockService();
      await this.waitForMqttConnection();
    }

    if (!this.roborock.isInited()) {
      if (this.roborock.authState?.twoFactorRequired && !this.config.verificationCode) {
        await this.requestVerificationEmail();
      }

      const authMessage = this.roborock.authState?.twoFactorRequired
        ? ' Roborock requires email verification; add the one-time verificationCode temporarily and restart Homebridge.'
        : '';
      const passwordMessage = this.config.password
        ? ''
        : ' No cached Roborock session was available; add the password temporarily, restart Homebridge, then remove it after login succeeds.';
      throw new Error(`Roborock cloud connection did not finish initializing.${authMessage}${passwordMessage}`);
    }

    if (this.config.verificationCode) {
      this.log.warn('Roborock verification succeeded or a cached session was available. Remove verificationCode from the plugin config; it is a one-time secret.');
    }
  }

  public async getVacuumRegistrations(): Promise<CloudVacuumRegistration[]> {
    if (!this.roborock?.isInited()) {
      return [];
    }

    const registrations: CloudVacuumRegistration[] = [];
    const roborock = this.roborock;

    for (const device of roborock.getVacuumList().filter((candidate) => this.isSupportedVacuum(candidate))) {
      const override = this.findOverride(device);
      const vacuumConfig = await this.toVacuumConfig(device, override);

      registrations.push({
        config: vacuumConfig,
        client: new RoborockCloudVacuumClient(roborock, vacuumConfig, this.log, this.deviceOperations),
      });
    }

    return registrations;
  }

  public isStarted(): boolean {
    return this.roborock?.isInited() ?? false;
  }

  public async destroy(): Promise<void> {
    if (this.roborock) {
      await this.roborock.stopService();
      this.roborock = undefined;
    }
  }

  private async startRoborockService(): Promise<void> {
    const roborock = this.roborock;
    if (!roborock) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearInterval(authPoll);
        clearTimeout(timeout);
        callback();
      };

      const authPoll = setInterval(() => {
        if (this.roborock?.isInited() || this.roborock?.authState?.twoFactorRequired) {
          settle(resolve);
        }
      }, 500);

      const timeout = setTimeout(() => {
        settle(() => reject(new Error('Roborock cloud initialization timed out.')));
      }, 60_000);

      roborock.startService(() => settle(resolve)).catch((error) => {
        settle(() => reject(error instanceof Error ? error : new Error(formatRoborockError(error))));
      });
    });
  }

  private async requestVerificationEmail(): Promise<void> {
    if (!this.roborock) {
      return;
    }

    try {
      await this.roborock.sendTwoFactorEmail();
      this.log.warn('Roborock requested email verification. A verification email was requested; add the one-time code as verificationCode and restart Homebridge.');
    } catch (error) {
      this.log.warn(`Roborock requested email verification, but the verification email could not be requested automatically. ${String(error)}`);
    }
  }

  private isSupportedVacuum(device: RoborockCloudDevice): boolean {
    const model = this.resolveModel(device);
    return Boolean(device.duid) && Boolean(this.roborock?.isSupportedVacuumModel(model));
  }

  private findOverride(device: RoborockCloudDevice): RoborockVacuumConfig | undefined {
    const vacuums = (this.config.vacuums ?? []) as LegacyCloudOverride[];
    const candidates = new Set([
      device.duid,
      device.sn,
      device.name,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0));

    return vacuums.find((vacuum) => {
      if (vacuum.connection === 'local') {
        return false;
      }

      return [vacuum.duid, vacuum.id, vacuum.serialNumber, vacuum.name]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .some((value) => candidates.has(value));
    });
  }

  private async toVacuumConfig(device: RoborockCloudDevice, override?: RoborockVacuumConfig): Promise<RoborockVacuumConfig> {
    const model = this.resolveModel(device);
    const rawDiscovery = Array.isArray(override?.serviceAreas)
      ? {
        serviceAreas: override.serviceAreas,
        serviceMaps: override.serviceMaps ?? this.serviceMapsFromAreas(override.serviceAreas, override.name ?? device.name),
      }
      : await this.discoverServiceAreas(device, override);
    const discovered = this.applyConfiguredRoomNameOverrides(rawDiscovery, override, device);

    return {
      ...override,
      name: override?.name ?? device.name ?? `Roborock ${device.duid.slice(-4)}`,
      duid: device.duid,
      id: override?.id ?? device.duid,
      manufacturer: override?.manufacturer ?? 'Roborock',
      model: override?.model ?? model ?? 'Roborock Vacuum',
      serialNumber: override?.serialNumber ?? device.sn ?? device.duid,
      serviceMaps: discovered.serviceMaps.length > 0 ? discovered.serviceMaps : undefined,
      serviceAreas: discovered.serviceAreas.length > 0 ? discovered.serviceAreas : undefined,
    };
  }

  private async discoverServiceAreas(device: RoborockCloudDevice, override?: RoborockVacuumConfig): Promise<ServiceAreaDiscovery> {
    if (!this.roborock?.isInited() || !device.duid) {
      return this.emptyDiscovery();
    }

    const cached = await this.readServiceAreaCache(device.duid);
    if (this.shouldUseCachedServiceAreas(device, cached, override)) {
      return this.cachedOrEmpty(device, cached);
    }

    try {
      const adapter = this.roborock;
      if (!adapter.rr_mqtt_connector.isConnected()) {
        this.log.warn(`Roborock cloud MQTT is not connected; skipping automatic room discovery for ${this.deviceLabel(device)}.`);
        return this.cachedOrEmpty(device, cached);
      }

      const maps = await this.discoverMaps(device);
      if (maps.length > 0) {
        const multiMapDiscovery = await this.deviceOperations.runExclusive(
          device.duid,
          () => this.discoverMultiMapServiceAreas(device, maps, cached),
        );

        if (multiMapDiscovery.serviceAreas.length > 0) {
          await this.writeServiceAreaCache(device.duid, multiMapDiscovery);
          this.logServiceAreaDiscovery(device, multiMapDiscovery);
          return multiMapDiscovery;
        }
      }

      const currentMapDiscovery = await this.discoverCurrentMapServiceAreas(device, maps[0]);
      if (currentMapDiscovery.serviceAreas.length === 0) {
        this.log.info(`No Roborock room mapping returned for ${this.deviceLabel(device)}; Matter room selection will not be exposed.`);
        return this.cachedOrEmpty(device, cached);
      }

      await this.writeServiceAreaCache(device.duid, currentMapDiscovery);
      this.logServiceAreaDiscovery(device, currentMapDiscovery);
      return currentMapDiscovery;
    } catch (error) {
      this.log.warn(`Could not discover Roborock rooms for ${this.deviceLabel(device)}. ${formatRoborockError(error)}`);
      return this.cachedOrEmpty(device, cached);
    }
  }

  private applyConfiguredRoomNameOverrides(
    discovery: ServiceAreaDiscovery,
    override: RoborockVacuumConfig | undefined,
    device: RoborockCloudDevice,
  ): ServiceAreaDiscovery {
    const exactOverrides = (override?.roomNameOverrides ?? [])
      .filter((entry) => this.toNonEmptyString(entry.label));
    const orderedNamesByMap = this.orderedRoomNamesByMap(discovery.serviceMaps, override?.roomNamesByMap);

    if (exactOverrides.length === 0 && orderedNamesByMap.size === 0) {
      return discovery;
    }

    const fallbackMap = discovery.serviceMaps.length === 1 ? discovery.serviceMaps[0] : undefined;
    const areaIndexByMap = new Map<number, number>();
    let appliedCount = 0;

    const serviceAreas = discovery.serviceAreas.map((area) => {
      const effectiveArea = {
        ...area,
        mapId: area.mapId ?? fallbackMap?.mapId,
        mapName: area.mapName ?? fallbackMap?.name,
      };
      let label = this.orderedRoomLabel(effectiveArea, orderedNamesByMap, areaIndexByMap);
      label = this.exactRoomLabel(effectiveArea, exactOverrides) ?? label;

      if (!label || label === area.label) {
        return area;
      }

      appliedCount++;
      return {
        ...area,
        label,
      };
    });

    if (appliedCount > 0) {
      this.log.info(`Applied ${appliedCount} configured Roborock room name override(s) for ${this.deviceLabel(device)}.`);
    }

    return {
      ...discovery,
      serviceAreas,
    };
  }

  private orderedRoomNamesByMap(
    serviceMaps: ServiceMapConfig[],
    roomNamesByMap?: Record<string, string[]>,
  ): Map<number, string[]> {
    const namesByMap = new Map<number, string[]>();

    for (const [rawMapKey, rawLabels] of Object.entries(roomNamesByMap ?? {})) {
      if (!Array.isArray(rawLabels)) {
        continue;
      }

      const map = serviceMaps.find((candidate) => {
        return String(candidate.mapId) === rawMapKey
          || this.normalizeMapName(candidate.name) === this.normalizeMapName(rawMapKey);
      });

      if (!map) {
        this.log.warn(`Ignoring Roborock roomNamesByMap override for unknown map "${rawMapKey}".`);
        continue;
      }

      const labels = rawLabels
        .map((label) => this.toNonEmptyString(label))
        .filter((label): label is string => label !== undefined);

      if (labels.length > 0) {
        namesByMap.set(map.mapId, labels);
      }
    }

    return namesByMap;
  }

  private orderedRoomLabel(
    area: ServiceAreaConfig,
    namesByMap: Map<number, string[]>,
    areaIndexByMap: Map<number, number>,
  ): string | undefined {
    if (area.mapId === undefined) {
      return undefined;
    }

    const labels = namesByMap.get(area.mapId);
    if (!labels) {
      return undefined;
    }

    const index = areaIndexByMap.get(area.mapId) ?? 0;
    areaIndexByMap.set(area.mapId, index + 1);
    return labels[index];
  }

  private exactRoomLabel(area: ServiceAreaConfig, overrides: RoomNameOverrideConfig[]): string | undefined {
    for (const override of [...overrides].reverse()) {
      if (this.roomNameOverrideMatches(area, override)) {
        return this.toNonEmptyString(override.label);
      }
    }

    return undefined;
  }

  private roomNameOverrideMatches(area: ServiceAreaConfig, override: RoomNameOverrideConfig): boolean {
    const mapId = this.toNumber(override.mapId);
    if (mapId !== undefined && area.mapId !== mapId) {
      return false;
    }

    if (override.mapName !== undefined && this.normalizeMapName(area.mapName) !== this.normalizeMapName(override.mapName)) {
      return false;
    }

    const segmentId = this.toNumber(override.segmentId);
    const areaId = this.toNumber(override.areaId);
    const roomId = this.toNonEmptyString(override.roomId);

    if (segmentId !== undefined) {
      return area.segmentId === segmentId;
    }

    if (areaId !== undefined) {
      return area.areaId === areaId;
    }

    if (roomId !== undefined) {
      return area.roomId === roomId;
    }

    return false;
  }

  private normalizeMapName(value: unknown): string {
    return this.toNonEmptyString(value)?.toLocaleLowerCase() ?? '';
  }

  private async discoverMultiMapServiceAreas(
    device: RoborockCloudDevice,
    maps: DiscoveredMap[],
    cached?: CachedServiceAreaDiscovery,
  ): Promise<ServiceAreaDiscovery> {
    const embeddedAreas = maps.flatMap((map) => map.rooms);
    const mapsWithoutEmbeddedRooms = maps.filter((map) => map.rooms.length === 0);

    if (embeddedAreas.length > 0 && mapsWithoutEmbeddedRooms.length === 0) {
      return this.finalizeServiceAreaDiscovery({
        serviceAreas: embeddedAreas,
        serviceMaps: maps.map(({ mapId, name }) => ({ mapId, name })),
      });
    }

    const status = await this.getRoborockStatus(device);
    if (!this.canSwitchMapsForDiscovery(status)) {
      if (embeddedAreas.length > 0) {
        this.log.warn(`Roborock ${this.deviceLabel(device)} is not idle enough for full multi-floor discovery; publishing room data already present in the map list.`);
        return this.finalizeServiceAreaDiscovery({
          serviceAreas: embeddedAreas,
          serviceMaps: maps.map(({ mapId, name }) => ({ mapId, name })),
        });
      }

      if (cached) {
        return cached;
      }

      this.log.warn(`Roborock ${this.deviceLabel(device)} is not idle enough for multi-floor room discovery; Matter room selection will not be exposed on this startup.`);
      return this.emptyDiscovery();
    }

    const discoveredByKey = new Map<string, ServiceAreaConfig>();
    for (const area of embeddedAreas) {
      discoveredByKey.set(this.areaKey(area), area);
    }

    const acceptedRoomMappings = new Map<string, ServiceMapConfig>();
    const staleRoomMappingMapIds = new Set<number>();
    for (const map of maps) {
      this.rememberRoomMappingSignature(acceptedRoomMappings, map, map.rooms);
    }

    const originalMapId = status?.mapId;
    let activeMapId = originalMapId;
    const primaryRefreshMap = this.primaryRefreshMap(mapsWithoutEmbeddedRooms);
    const mapsToRefresh = [
      ...(primaryRefreshMap ? [primaryRefreshMap] : []),
      ...this.mapsForDiscovery(
        mapsWithoutEmbeddedRooms.filter((map) => map.mapId !== primaryRefreshMap?.mapId),
        originalMapId,
      ),
    ];

    try {
      for (const map of mapsToRefresh) {
        if (activeMapId !== map.mapId) {
          const loaded = await this.loadRoborockMap(device, map.mapId);
          if (!loaded) {
            continue;
          }
          activeMapId = map.mapId;
        }

        const refreshed = await this.discoverCurrentMapServiceAreas(
          device,
          map,
          acceptedRoomMappings,
          staleRoomMappingMapIds,
        );

        for (const area of refreshed.serviceAreas) {
          discoveredByKey.set(this.areaKey(area), area);
        }
      }
    } finally {
      if (originalMapId !== undefined && activeMapId !== undefined && activeMapId !== originalMapId) {
        await this.loadRoborockMap(device, originalMapId).catch((error) => {
          this.log.warn(`Could not restore original Roborock map for ${this.deviceLabel(device)}. ${formatRoborockError(error)}`);
        });
      }
    }

    return this.finalizeServiceAreaDiscovery(
      {
        serviceAreas: [...discoveredByKey.values()],
        serviceMaps: maps.map(({ mapId, name }) => ({ mapId, name })),
      },
      staleRoomMappingMapIds,
    );
  }

  private primaryRefreshMap(maps: DiscoveredMap[]): DiscoveredMap | undefined {
    return [...maps].sort((left, right) => left.mapId - right.mapId)[0];
  }

  private async discoverCurrentMapServiceAreas(
    device: RoborockCloudDevice,
    map?: ServiceMapConfig,
    acceptedRoomMappings?: Map<string, ServiceMapConfig>,
    staleRoomMappingMapIds?: Set<number>,
  ): Promise<ServiceAreaDiscovery> {
    await this.refreshRoomNameLookup(device);
    const roomMapping = await this.readSettledRoomMapping(device, map, acceptedRoomMappings);
    const serviceAreas = this.roomMappingToServiceAreas(roomMapping.payload, map);
    const serviceMaps = map ? [map] : this.serviceMapsFromAreas(serviceAreas, device.name);

    if (map && roomMapping.staleDuplicateOf) {
      staleRoomMappingMapIds?.add(map.mapId);
    } else if (map) {
      this.rememberRoomMappingSignature(acceptedRoomMappings, map, serviceAreas);
    }

    return this.finalizeServiceAreaDiscovery({ serviceAreas, serviceMaps });
  }

  private async readSettledRoomMapping(
    device: RoborockCloudDevice,
    map?: ServiceMapConfig,
    acceptedRoomMappings?: Map<string, ServiceMapConfig>,
  ): Promise<RoomMappingRead> {
    const startedAt = Date.now();
    const mapLabel = map ? `"${map.name}"` : 'the current map';
    let loggedStaleMapping = false;

    while (true) {
      const payload = await this.sendRequestWithRetry(
        device.duid,
        'get_room_mapping',
        [],
        map ? `discover Roborock rooms for ${map.name}` : 'discover Roborock rooms',
      );
      const signature = this.roomMappingSignature(payload);
      const duplicateMap = signature ? acceptedRoomMappings?.get(signature) : undefined;

      if (!duplicateMap || duplicateMap.mapId === map?.mapId) {
        if (loggedStaleMapping) {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          this.log.info(`Roborock room mapping for ${mapLabel} settled after ${elapsedSeconds}s.`);
        }

        return { payload };
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= ROOM_MAPPING_STALE_RETRY_TIMEOUT_MS) {
        this.log.warn(
          `Roborock room mapping for ${mapLabel} still matches "${duplicateMap.name}" after `
          + `${Math.round(elapsedMs / 1000)}s; using the returned mapping and applying duplicate-map safeguards.`,
        );
        return { payload, staleDuplicateOf: duplicateMap };
      }

      if (!loggedStaleMapping) {
        loggedStaleMapping = true;
        this.log.info(
          `Roborock room mapping for ${mapLabel} still matches "${duplicateMap.name}" after a map switch; `
          + 'waiting for the robot room table to settle.',
        );
      }

      await this.delay(Math.min(ROOM_MAPPING_STALE_RETRY_INTERVAL_MS, ROOM_MAPPING_STALE_RETRY_TIMEOUT_MS - elapsedMs));
    }
  }

  private async refreshRoomNameLookup(device: RoborockCloudDevice): Promise<void> {
    try {
      await this.roborock?.refreshHomeDataNow();
    } catch (error) {
      this.log.debug(`Could not refresh Roborock room names for ${this.deviceLabel(device)}. ${formatRoborockError(error)}`);
    }
  }

  private async discoverMaps(device: RoborockCloudDevice): Promise<DiscoveredMap[]> {
    try {
      const payload = await this.sendRequestWithRetry(device.duid, 'get_multi_maps_list', [], 'discover Roborock saved maps', 2);
      return this.multiMapPayloadToMaps(payload);
    } catch (error) {
      this.log.debug(`Could not discover Roborock saved maps for ${this.deviceLabel(device)}; falling back to current-map rooms. ${formatRoborockError(error)}`);
      return [];
    }
  }

  private multiMapPayloadToMaps(payload: unknown): DiscoveredMap[] {
    const root = this.firstRecord(payload);
    const rawMaps = this.arrayFromUnknown(root?.map_info ?? root?.mapInfo ?? root?.maps);
    const maps: DiscoveredMap[] = [];
    const seenMapIds = new Set<number>();
    const usedNames = new Set<string>();

    for (const rawMap of rawMaps) {
      if (!this.isRecord(rawMap)) {
        continue;
      }

      const mapId = this.toNumber(rawMap.mapFlag ?? rawMap.map_flag ?? rawMap.mapId ?? rawMap.id);
      if (mapId === undefined || seenMapIds.has(mapId)) {
        continue;
      }

      seenMapIds.add(mapId);
      const baseName = this.toNonEmptyString(rawMap.name) ?? `Map ${mapId}`;
      const name = this.uniqueName(baseName, usedNames, mapId);
      const map: ServiceMapConfig = { mapId, name };

      maps.push({
        ...map,
        rooms: this.mapInfoRoomsToServiceAreas(rawMap.rooms, map),
      });
    }

    return maps.sort((left, right) => left.mapId - right.mapId);
  }

  private mapInfoRoomsToServiceAreas(rooms: unknown, map: ServiceMapConfig): ServiceAreaConfig[] {
    const serviceAreas: ServiceAreaConfig[] = [];
    const seenSegmentIds = new Set<number>();

    for (const rawRoom of this.arrayFromUnknown(rooms)) {
      if (!this.isRecord(rawRoom)) {
        continue;
      }

      const segmentId = this.toNumber(rawRoom.id ?? rawRoom.segmentId ?? rawRoom.segment_id ?? rawRoom.tag);
      if (segmentId === undefined || seenSegmentIds.has(segmentId)) {
        continue;
      }

      seenSegmentIds.add(segmentId);
      const roomId = this.toNonEmptyString(rawRoom.iot_name_id ?? rawRoom.iotNameId ?? rawRoom.roomId);
      const explicitName = this.toNonEmptyString(rawRoom.iot_name ?? rawRoom.iotName ?? rawRoom.name);

      serviceAreas.push(this.roomServiceArea({
        map,
        segmentId,
        roomId,
        label: explicitName,
      }));
    }

    return serviceAreas;
  }

  private roomMappingToServiceAreas(payload: unknown, map?: ServiceMapConfig): ServiceAreaConfig[] {
    const serviceAreas: ServiceAreaConfig[] = [];

    for (const { segmentId, roomId } of this.normalizedRoomMappingEntries(payload)) {
      serviceAreas.push(this.roomServiceArea({
        map,
        segmentId,
        roomId,
      }));
    }

    return serviceAreas;
  }

  private normalizedRoomMappingEntries(payload: unknown): NormalizedRoomMappingEntry[] {
    const seenSegmentIds = new Set<number>();
    const entries: NormalizedRoomMappingEntry[] = [];

    for (const [rawSegmentId, rawRoomId] of this.roomMappingEntries(payload)) {
      const segmentId = this.toNumber(rawSegmentId);
      if (segmentId === undefined || seenSegmentIds.has(segmentId)) {
        continue;
      }

      seenSegmentIds.add(segmentId);
      entries.push({
        segmentId,
        roomId: this.toNonEmptyString(rawRoomId),
      });
    }

    return entries;
  }

  private roomMappingSignature(payload: unknown): string | undefined {
    return this.roomMappingEntriesSignature(this.normalizedRoomMappingEntries(payload));
  }

  private serviceAreaMappingSignature(areas: ServiceAreaConfig[]): string | undefined {
    const entries: NormalizedRoomMappingEntry[] = [];

    for (const area of areas) {
      const segmentId = this.toNumber(area.segmentId ?? area.areaId);
      if (segmentId === undefined) {
        continue;
      }

      const entry: NormalizedRoomMappingEntry = { segmentId };
      const roomId = this.toNonEmptyString(area.roomId);
      if (roomId !== undefined) {
        entry.roomId = roomId;
      }
      entries.push(entry);
    }

    return this.roomMappingEntriesSignature(entries);
  }

  private roomMappingEntriesSignature(entries: NormalizedRoomMappingEntry[]): string | undefined {
    if (entries.length === 0) {
      return undefined;
    }

    return entries
      .map((entry) => `${entry.segmentId}:${entry.roomId ?? ''}`)
      .sort()
      .join('|');
  }

  private rememberRoomMappingSignature(
    acceptedRoomMappings: Map<string, ServiceMapConfig> | undefined,
    map: ServiceMapConfig,
    areas: ServiceAreaConfig[],
  ): void {
    if (!acceptedRoomMappings) {
      return;
    }

    const signature = this.serviceAreaMappingSignature(areas);
    if (signature && !acceptedRoomMappings.has(signature)) {
      acceptedRoomMappings.set(signature, map);
    }
  }

  private roomMappingEntries(payload: unknown): Array<[unknown, unknown]> {
    if (!Array.isArray(payload)) {
      return [];
    }

    if (payload.length >= 2 && !Array.isArray(payload[0])) {
      return [[payload[0], payload[1]]];
    }

    return payload
      .filter((entry): entry is unknown[] => Array.isArray(entry) && entry.length >= 2)
      .map((entry) => [entry[0], entry[1]]);
  }

  private roomServiceArea(options: {
    map?: ServiceMapConfig;
    segmentId: number;
    roomId?: string;
    label?: string;
  }): ServiceAreaConfig {
    return {
      areaId: options.map ? this.matterAreaId(options.map.mapId, options.segmentId) : options.segmentId,
      label: options.label ?? this.roomLabel(options.segmentId, options.roomId),
      kind: 'room',
      mapId: options.map?.mapId,
      mapName: options.map?.name,
      roborockMapId: options.map?.mapId,
      segmentId: options.segmentId,
      roomId: options.roomId,
    };
  }

  private roomLabel(segmentId: number, roomId?: string): string {
    if (roomId) {
      return this.roborock?.roomIDs[roomId] ?? `Room ${segmentId}`;
    }

    return `Room ${segmentId}`;
  }

  private async getRoborockStatus(device: RoborockCloudDevice): Promise<RoborockStatus | undefined> {
    const statusRequest = this.preferredStatusRequest(device);

    try {
      const payload = await this.sendRequestWithRetry(device.duid, statusRequest.method, statusRequest.params, 'read Roborock status', 1);
      return this.normalizeStatus(payload);
    } catch (error) {
      this.log.debug(`Could not read Roborock status for ${this.deviceLabel(device)} during room discovery. ${formatRoborockError(error)}`);
    }

    try {
      const payload = await this.sendRequestWithRetry(device.duid, statusRequest.fallbackMethod, statusRequest.fallbackParams, 'read Roborock status', 1);
      return this.normalizeStatus(payload);
    } catch (error) {
      this.log.debug(`Could not read fallback Roborock status for ${this.deviceLabel(device)} during room discovery. ${formatRoborockError(error)}`);
      return undefined;
    }
  }

  private canSwitchMapsForDiscovery(status?: RoborockStatus): boolean {
    return status?.state !== undefined && MAP_SWITCH_SAFE_STATES.has(status.state);
  }

  private mapsForDiscovery(maps: DiscoveredMap[], originalMapId?: number): DiscoveredMap[] {
    if (originalMapId === undefined) {
      return maps;
    }

    return [...maps].sort((left, right) => {
      if (left.mapId === originalMapId) {
        return 1;
      }

      if (right.mapId === originalMapId) {
        return -1;
      }

      return left.mapId - right.mapId;
    });
  }

  private async loadRoborockMap(device: RoborockCloudDevice, mapId: number): Promise<boolean> {
    try {
      await this.sendRequestWithRetry(device.duid, 'load_multi_map', [mapId], `load Roborock map ${mapId}`, 1);
    } catch (error) {
      if (!isCloudAckTimeout(error, 'load_multi_map')) {
        throw error;
      }

      this.log.warn(`Roborock map switch to ${mapId} for ${this.deviceLabel(device)} timed out waiting for a cloud acknowledgement; treating it as sent.`);
    }

    const confirmation = await this.waitForRoborockMap(device, mapId);
    if (confirmation === 'confirmed') {
      await this.delay(MAP_DISCOVERY_SETTLE_MS);
      return true;
    }

    if (confirmation === 'mismatch') {
      this.log.warn(`Roborock did not report map ${mapId} after a map switch for ${this.deviceLabel(device)}; skipping room discovery for that map to avoid caching stale room names.`);
      return false;
    }

    await this.delay(MAP_DISCOVERY_UNCONFIRMED_SETTLE_MS);
    return true;
  }

  private async waitForRoborockMap(device: RoborockCloudDevice, mapId: number): Promise<'confirmed' | 'mismatch' | 'unknown'> {
    const startedAt = Date.now();
    let sawMapStatus = false;
    let lastMapId: number | undefined;

    while (Date.now() - startedAt < MAP_DISCOVERY_CONFIRM_TIMEOUT_MS) {
      await this.delay(MAP_DISCOVERY_CONFIRM_INTERVAL_MS);

      const status = await this.getRoborockStatus(device);
      if (status?.mapId === undefined) {
        continue;
      }

      sawMapStatus = true;
      lastMapId = status.mapId;

      if (status.mapId === mapId) {
        return 'confirmed';
      }
    }

    if (sawMapStatus) {
      this.log.debug(`Roborock ${this.deviceLabel(device)} last reported map ${lastMapId} while waiting for map ${mapId}.`);
      return 'mismatch';
    }

    this.log.debug(`Roborock ${this.deviceLabel(device)} did not report a current map while waiting for map ${mapId}.`);
    return 'unknown';
  }

  private preferredStatusRequest(device: RoborockCloudDevice): {
    method: string;
    params: unknown[];
    fallbackMethod: string;
    fallbackParams: unknown[];
  } {
    const version = this.roborock?.getRobotVersion(device.duid);
    const usesPropertyStatus = version === 'B01' || version === '\x81S\x19';

    if (usesPropertyStatus) {
      return {
        method: 'get_prop',
        params: ['get_status'],
        fallbackMethod: 'get_status',
        fallbackParams: [],
      };
    }

    return {
      method: 'get_status',
      params: [],
      fallbackMethod: 'get_prop',
      fallbackParams: ['get_status'],
    };
  }

  private normalizeStatus(payload: unknown): RoborockStatus {
    const raw = this.firstStatusObject(payload);
    const mapId = this.mapIdFromMapStatus(this.toNumber(raw?.map_status));

    return {
      state: this.toNumber(raw?.state),
      battery: this.toNumber(raw?.battery),
      mapId,
    };
  }

  private firstStatusObject(payload: unknown): RawRoborockStatus | undefined {
    if (Array.isArray(payload)) {
      return this.firstStatusObject(payload[0]);
    }

    if (this.isRawStatus(payload)) {
      return payload;
    }

    return undefined;
  }

  private isRawStatus(value: unknown): value is RawRoborockStatus {
    if (!this.isRecord(value)) {
      return false;
    }

    return [
      'state',
      'battery',
      'map_status',
    ].some((key) => key in value);
  }

  private mapIdFromMapStatus(mapStatus?: number): number | undefined {
    if (mapStatus === undefined) {
      return undefined;
    }

    const mapId = mapStatus >> 2;
    return mapId === ROBOROCK_NO_MAP_ID ? undefined : mapId;
  }

  private matterAreaId(mapId: number, segmentId: number): number {
    return (mapId * MAP_AREA_ID_MULTIPLIER) + segmentId;
  }

  private finalizeServiceAreaDiscovery(
    discovery: ServiceAreaDiscovery,
    staleRoomMappingMapIds = new Set<number>(),
  ): ServiceAreaDiscovery {
    let serviceMaps = this.dedupeServiceMaps(discovery.serviceMaps);
    const referencedMapIds = new Set(discovery.serviceAreas
      .map((area) => area.mapId)
      .filter((mapId): mapId is number => typeof mapId === 'number'));

    if (serviceMaps.length > 0 && referencedMapIds.size > 0) {
      serviceMaps = serviceMaps.filter((map) => referencedMapIds.has(map.mapId));
    }

    if (serviceMaps.length === 0 && discovery.serviceAreas.length > 0) {
      serviceMaps = this.serviceMapsFromAreas(discovery.serviceAreas);
    }

    if (serviceMaps.length === 0 && discovery.serviceAreas.length > 0) {
      serviceMaps = [{ mapId: 1, name: 'Roborock Map' }];
    }

    const fallbackMap = serviceMaps.length === 1 ? serviceMaps[0] : undefined;
    const mapsById = new Map(serviceMaps.map((map) => [map.mapId, map]));
    const seenAreaIds = new Set<number>();
    const labelCounts = new Map<string, number>();
    const serviceAreas: ServiceAreaConfig[] = [];

    for (const area of discovery.serviceAreas) {
      const mapId = area.mapId ?? fallbackMap?.mapId;
      const mapName = area.mapName ?? (mapId === undefined ? undefined : mapsById.get(mapId)?.name);
      const areaId = area.areaId;

      if (!Number.isInteger(areaId) || seenAreaIds.has(areaId)) {
        continue;
      }

      seenAreaIds.add(areaId);
      const labelKey = `${mapId ?? 'none'}:${area.label}`;
      const labelCount = labelCounts.get(labelKey) ?? 0;
      labelCounts.set(labelKey, labelCount + 1);

      serviceAreas.push({
        ...area,
        label: labelCount === 0 ? area.label : `${area.label} (${labelCount + 1})`,
        mapId,
        mapName,
      });
    }

    return {
      serviceAreas: this.disambiguateRepeatedMapAreaLabels(serviceAreas, serviceMaps, staleRoomMappingMapIds),
      serviceMaps,
    };
  }

  private disambiguateRepeatedMapAreaLabels(
    serviceAreas: ServiceAreaConfig[],
    serviceMaps: ServiceMapConfig[],
    staleRoomMappingMapIds = new Set<number>(),
  ): ServiceAreaConfig[] {
    if (serviceMaps.length < 2) {
      return serviceAreas;
    }

    const mapsById = new Map(serviceMaps.map((map) => [map.mapId, map]));
    const areasByMapId = new Map<number, ServiceAreaConfig[]>();

    for (const area of serviceAreas) {
      if (area.mapId === undefined) {
        continue;
      }

      const areas = areasByMapId.get(area.mapId) ?? [];
      areas.push(area);
      areasByMapId.set(area.mapId, areas);
    }

    const mapIdsBySignature = new Map<string, number[]>();
    for (const [mapId, areas] of areasByMapId) {
      if (areas.length === 0) {
        continue;
      }

      const signature = areas
        .map((area) => `${area.segmentId ?? area.areaId}:${area.label}`)
        .sort()
        .join('|');
      const mapIds = mapIdsBySignature.get(signature) ?? [];
      mapIds.push(mapId);
      mapIdsBySignature.set(signature, mapIds);
    }

    const genericLabelMapIds = new Set<number>();
    for (const mapIds of mapIdsBySignature.values()) {
      if (mapIds.length < 2) {
        continue;
      }

      const sortedMapIds = [...mapIds].sort((left, right) => left - right);
      const staleMapIds = sortedMapIds.filter((mapId) => staleRoomMappingMapIds.has(mapId));
      const genericMapIds = staleMapIds.length > 0 ? staleMapIds : sortedMapIds.slice(1);
      genericMapIds.forEach((mapId) => genericLabelMapIds.add(mapId));

      const warningKey = sortedMapIds.join(',');
      if (!this.repeatedMapLabelWarnings.has(warningKey)) {
        this.repeatedMapLabelWarnings.add(warningKey);
        const mapNames = sortedMapIds
          .map((mapId) => mapsById.get(mapId)?.name ?? `Map ${mapId}`)
          .join(', ');
        const genericMapNames = genericMapIds
          .map((mapId) => mapsById.get(mapId)?.name ?? `Map ${mapId}`)
          .join(', ');
        this.log.warn(
          `Roborock returned identical room mappings for ${sortedMapIds.length} saved maps; `
          + `using generic room labels for ${genericMapIds.length} map(s). `
          + 'Configure serviceAreas manually for exact per-floor room names if this model does not expose them automatically.',
        );
        this.log.debug(
          `Roborock repeated room mapping maps: ${mapNames}; generic labels applied to: ${genericMapNames}.`,
        );
      }
    }

    if (genericLabelMapIds.size === 0) {
      return serviceAreas;
    }

    return serviceAreas.map((area) => {
      if (area.mapId === undefined || !genericLabelMapIds.has(area.mapId)) {
        return area;
      }

      const mapName = area.mapName ?? mapsById.get(area.mapId)?.name;
      if (!mapName) {
        return area;
      }

      const roomId = area.segmentId ?? area.areaId;
      return {
        ...area,
        label: `${mapName} Room ${roomId}`,
      };
    });
  }

  private serviceMapsFromAreas(serviceAreas: ServiceAreaConfig[], fallbackName?: string): ServiceMapConfig[] {
    const mapsById = new Map<number, ServiceMapConfig>();

    for (const area of serviceAreas) {
      const mapId = area.mapId ?? 1;
      if (!mapsById.has(mapId)) {
        mapsById.set(mapId, {
          mapId,
          name: area.mapName ?? (mapId === 1 ? `${fallbackName ?? 'Roborock'} Map` : `Map ${mapId}`),
        });
      }
    }

    return this.dedupeServiceMaps([...mapsById.values()]);
  }

  private dedupeServiceMaps(serviceMaps: ServiceMapConfig[]): ServiceMapConfig[] {
    const seenMapIds = new Set<number>();
    const usedNames = new Set<string>();
    const maps: ServiceMapConfig[] = [];

    for (const serviceMap of serviceMaps) {
      if (!Number.isInteger(serviceMap.mapId) || seenMapIds.has(serviceMap.mapId)) {
        continue;
      }

      seenMapIds.add(serviceMap.mapId);
      maps.push({
        mapId: serviceMap.mapId,
        name: this.uniqueName(serviceMap.name || `Map ${serviceMap.mapId}`, usedNames, serviceMap.mapId),
      });
    }

    return maps.sort((left, right) => left.mapId - right.mapId);
  }

  private uniqueName(baseName: string, usedNames: Set<string>, suffix: number): string {
    if (!usedNames.has(baseName)) {
      usedNames.add(baseName);
      return baseName;
    }

    const suffixed = `${baseName} ${suffix}`;
    if (!usedNames.has(suffixed)) {
      usedNames.add(suffixed);
      return suffixed;
    }

    let counter = 2;
    while (usedNames.has(`${suffixed} ${counter}`)) {
      counter++;
    }

    const unique = `${suffixed} ${counter}`;
    usedNames.add(unique);
    return unique;
  }

  private areaKey(area: ServiceAreaConfig): string {
    return `${area.mapId ?? 'none'}:${area.segmentId ?? area.areaId}`;
  }

  private emptyDiscovery(): ServiceAreaDiscovery {
    return { serviceAreas: [], serviceMaps: [] };
  }

  private shouldUseCachedServiceAreas(
    device: RoborockCloudDevice,
    cached: CachedServiceAreaDiscovery | undefined,
    override?: RoborockVacuumConfig,
  ): boolean {
    if (!cached?.serviceAreas.length) {
      return false;
    }

    if (this.shouldForceRoomRediscovery(override)) {
      this.log.info(`Roborock room rediscovery is forced for ${this.deviceLabel(device)}; ignoring cached room discovery from ${cached.updatedAt}.`);
      return false;
    }

    const ttlMs = this.roomDiscoveryCacheTtlMs(override);
    if (ttlMs <= 0) {
      this.log.debug(`Roborock room discovery cache is disabled for ${this.deviceLabel(device)}; running live discovery.`);
      return false;
    }

    const updatedAtMs = Date.parse(cached.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      this.log.debug(`Roborock room cache for ${this.deviceLabel(device)} has no valid timestamp; running live discovery.`);
      return false;
    }

    const ageMs = Math.max(0, Date.now() - updatedAtMs);
    if (ageMs > ttlMs) {
      this.log.info(
        `Roborock room cache for ${this.deviceLabel(device)} is ${this.formatDuration(ageMs)} old; `
        + `running live discovery because the TTL is ${this.formatDuration(ttlMs)}.`,
      );
      return false;
    }

    return true;
  }

  private shouldForceRoomRediscovery(override?: RoborockVacuumConfig): boolean {
    return override?.forceRoomRediscovery ?? this.config.forceRoomRediscovery ?? false;
  }

  private roomDiscoveryCacheTtlMs(override?: RoborockVacuumConfig): number {
    const hours = override?.roomDiscoveryCacheTtlHours
      ?? this.config.roomDiscoveryCacheTtlHours
      ?? DEFAULT_ROOM_DISCOVERY_CACHE_TTL_HOURS;

    if (typeof hours !== 'number' || !Number.isFinite(hours)) {
      return DEFAULT_ROOM_DISCOVERY_CACHE_TTL_HOURS * MS_PER_HOUR;
    }

    return Math.max(0, hours) * MS_PER_HOUR;
  }

  private formatDuration(ms: number): string {
    const hours = ms / MS_PER_HOUR;
    if (hours < 1) {
      return `${Math.max(1, Math.round(hours * 60))}m`;
    }

    return `${Math.round(hours * 10) / 10}h`;
  }

  private cachedOrEmpty(device: RoborockCloudDevice, cached?: CachedServiceAreaDiscovery): ServiceAreaDiscovery {
    if (cached?.serviceAreas.length) {
      this.log.info(`Using cached Roborock room discovery for ${this.deviceLabel(device)} from ${cached.updatedAt}.`);
      return this.finalizeServiceAreaDiscovery(cached);
    }

    this.log.warn(`Matter room selection will not be exposed for ${this.deviceLabel(device)} on this startup.`);
    return this.emptyDiscovery();
  }

  private logServiceAreaDiscovery(device: RoborockCloudDevice, discovery: ServiceAreaDiscovery): void {
    const mapCount = discovery.serviceMaps.length;
    const mapText = mapCount > 1 ? ` across ${mapCount} map(s)` : '';
    this.log.info(`Discovered ${discovery.serviceAreas.length} Roborock room(s) for ${this.deviceLabel(device)}${mapText}.`);
    this.log.debug(`Roborock rooms for ${this.deviceLabel(device)}: ${discovery.serviceAreas.map((area) => {
      return area.mapName ? `${area.mapName}/${area.label}` : area.label;
    }).join(', ')}`);
  }

  private async readServiceAreaCache(duid: string): Promise<CachedServiceAreaDiscovery | undefined> {
    try {
      const raw = await fs.readFile(this.serviceAreaCachePath(), 'utf8');
      const cache = JSON.parse(raw) as unknown;
      if (!this.isRecord(cache) || !this.isRecord(cache.devices)) {
        return undefined;
      }

      const cached = this.normalizeCachedServiceAreaDiscovery(cache.devices[duid]);

      if (!cached) {
        return undefined;
      }

      if (cache.version !== SERVICE_AREA_CACHE_VERSION) {
        this.log.debug(
          `Using legacy Roborock room cache schema ${formatRoborockError(cache.version, 'unknown')}; `
          + 'the cache will be migrated after the next successful discovery.',
        );
      }

      return cached;
    } catch (error) {
      if (this.isFileMissingError(error)) {
        return undefined;
      }

      this.log.debug(`Could not read Roborock room cache. ${formatRoborockError(error)}`);
      return undefined;
    }
  }

  private async writeServiceAreaCache(duid: string, discovery: ServiceAreaDiscovery): Promise<void> {
    if (discovery.serviceAreas.length === 0) {
      return;
    }

    const cachePath = this.serviceAreaCachePath();
    let cache: ServiceAreaDiscoveryCache = { version: SERVICE_AREA_CACHE_VERSION, devices: {} };

    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const existing = JSON.parse(raw) as unknown;
      if (this.isRecord(existing) && this.isRecord(existing.devices)) {
        cache = {
          version: SERVICE_AREA_CACHE_VERSION,
          devices: existing.devices as Record<string, CachedServiceAreaDiscovery | undefined>,
        };
      }
    } catch (error) {
      if (!this.isFileMissingError(error)) {
        this.log.debug(`Could not read existing Roborock room cache before writing. ${formatRoborockError(error)}`);
      }
    }

    cache.version = SERVICE_AREA_CACHE_VERSION;
    cache.devices[duid] = {
      ...this.finalizeServiceAreaDiscovery(discovery),
      updatedAt: new Date().toISOString(),
    };

    try {
      await fs.mkdir(this.storagePath, { recursive: true, mode: PRIVATE_CACHE_DIRECTORY_MODE });
      await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, {
        encoding: 'utf8',
        mode: PRIVATE_CACHE_FILE_MODE,
      });
      await this.restrictCacheFilePermissions(cachePath);
    } catch (error) {
      this.log.debug(`Could not write Roborock room cache. ${formatRoborockError(error)}`);
    }
  }

  private normalizeCachedServiceAreaDiscovery(value: unknown): CachedServiceAreaDiscovery | undefined {
    if (!this.isRecord(value) || !Array.isArray(value.serviceAreas) || value.serviceAreas.length === 0) {
      return undefined;
    }

    const serviceAreas = this.normalizeCachedServiceAreas(value.serviceAreas);
    if (serviceAreas.length === 0) {
      return undefined;
    }

    return {
      serviceAreas,
      serviceMaps: this.normalizeCachedServiceMaps(value.serviceMaps, serviceAreas),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : 'unknown time',
    };
  }

  private normalizeCachedServiceAreas(value: unknown[]): ServiceAreaConfig[] {
    const seenAreaIds = new Set<number>();
    const serviceAreas: ServiceAreaConfig[] = [];

    for (const entry of value) {
      if (!this.isRecord(entry)) {
        continue;
      }

      const areaId = this.toInteger(entry.areaId);
      const label = this.toNonEmptyString(entry.label);

      if (areaId === undefined || !label || seenAreaIds.has(areaId)) {
        continue;
      }

      seenAreaIds.add(areaId);
      serviceAreas.push(this.cachedServiceArea(entry, areaId, label));
    }

    return serviceAreas;
  }

  private cachedServiceArea(entry: Record<string, unknown>, areaId: number, label: string): ServiceAreaConfig {
    const serviceArea: ServiceAreaConfig = { areaId, label };
    const kind = entry.kind === 'room' || entry.kind === 'zone' ? entry.kind : undefined;
    const mapId = this.toInteger(entry.mapId);
    const roborockMapId = this.toInteger(entry.roborockMapId);
    const segmentId = this.toInteger(entry.segmentId);
    const repeat = this.toInteger(entry.repeat);
    const mapName = this.toNonEmptyString(entry.mapName);
    const roomId = this.toNonEmptyString(entry.roomId);
    const coordinates = this.cachedCoordinates(entry.coordinates);

    if (kind) {
      serviceArea.kind = kind;
    }
    if (mapId !== undefined) {
      serviceArea.mapId = mapId;
    }
    if (mapName) {
      serviceArea.mapName = mapName;
    }
    if (roborockMapId !== undefined) {
      serviceArea.roborockMapId = roborockMapId;
    }
    if (segmentId !== undefined) {
      serviceArea.segmentId = segmentId;
    }
    if (roomId) {
      serviceArea.roomId = roomId;
    }
    if (coordinates) {
      serviceArea.coordinates = coordinates;
    }
    if (repeat !== undefined) {
      serviceArea.repeat = repeat;
    }

    return serviceArea;
  }

  private cachedCoordinates(value: unknown): [number, number, number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 4) {
      return undefined;
    }

    const coordinates = value.map((entry) => this.toNumber(entry));
    if (coordinates.some((entry) => entry === undefined)) {
      return undefined;
    }

    return coordinates as [number, number, number, number];
  }

  private normalizeCachedServiceMaps(value: unknown, serviceAreas: ServiceAreaConfig[]): ServiceMapConfig[] {
    if (!Array.isArray(value)) {
      return this.serviceMapsFromAreas(serviceAreas);
    }

    const seenMapIds = new Set<number>();
    const serviceMaps: ServiceMapConfig[] = [];

    for (const entry of value) {
      if (!this.isRecord(entry)) {
        continue;
      }

      const mapId = this.toInteger(entry.mapId);
      const name = this.toNonEmptyString(entry.name);

      if (mapId === undefined || !name || seenMapIds.has(mapId)) {
        continue;
      }

      seenMapIds.add(mapId);
      serviceMaps.push({ mapId, name });
    }

    return serviceMaps.length > 0 ? serviceMaps : this.serviceMapsFromAreas(serviceAreas);
  }

  private serviceAreaCachePath(): string {
    return path.join(this.storagePath, SERVICE_AREA_CACHE_FILE);
  }

  private async restrictCacheFilePermissions(filePath: string): Promise<void> {
    try {
      await fs.chmod(filePath, PRIVATE_CACHE_FILE_MODE);
    } catch (error) {
      this.log.debug(`Could not restrict Roborock room cache permissions. ${formatRoborockError(error)}`);
    }
  }

  private isFileMissingError(error: unknown): boolean {
    return this.isRecord(error) && error.code === 'ENOENT';
  }

  private firstRecord(payload: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(payload)) {
      return this.firstRecord(payload[0]);
    }

    return this.isRecord(payload) ? payload : undefined;
  }

  private arrayFromUnknown(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private toNonEmptyString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async sendRequestWithRetry(
    duid: string,
    method: string,
    params: unknown[],
    action: string,
    attempts = 4,
  ): Promise<unknown> {
    const roborock = this.roborock;
    if (!roborock) {
      throw new Error('Roborock cloud client is not available.');
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await roborock.messageQueueHandler.sendRequest(duid, method, params);
      } catch (error) {
        lastError = error;

        if (attempt < attempts) {
          this.log.debug(`Could not ${action} on attempt ${attempt}/${attempts}; retrying. ${formatRoborockError(error)}`);
          await this.delay(3_000);
        }
      }
    }

    throw lastError;
  }

  private async waitForMqttConnection(timeoutMs = 12_000): Promise<void> {
    if (!this.roborock?.isInited()) {
      return;
    }

    const adapter = this.roborock;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (adapter.rr_mqtt_connector.isConnected()) {
        return;
      }

      await this.delay(1_000);
    }

    this.log.warn('Roborock cloud MQTT connection is not ready yet. The plugin will publish the vacuum now and retry normal status updates during polling; room discovery may be unavailable until a later restart.');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private toInteger(value: unknown): number | undefined {
    const number = this.toNumber(value);
    return number !== undefined && Number.isInteger(number) ? number : undefined;
  }

  private resolveModel(device: RoborockCloudDevice): string | null {
    const model = this.roborock?.getProductAttribute(device.duid, 'model');
    if (typeof model === 'string' && model.length > 0) {
      return model;
    }

    return device.model
      ?? device.productModel
      ?? device.productCode
      ?? device.modelId
      ?? null;
  }

  private resolveBaseUrl(): string {
    if (this.config.baseUrl) {
      const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
      if (!ALLOWED_ROBOROCK_BASE_URLS.has(baseUrl)) {
        throw new Error('Unsupported Roborock API host. Use the region setting instead of a custom host.');
      }

      return baseUrl;
    }

    const region: RoborockCloudRegion = this.config.region ?? 'us';
    return ROBOROCK_BASE_URLS[region];
  }

  private normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().toLowerCase();
    let url: URL;

    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      throw new Error('Unsupported Roborock API host. Configure only a Roborock region.');
    }

    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Unsupported Roborock API host. Configure only the Roborock host name.');
    }

    return url.hostname;
  }

  private deviceLabel(device: RoborockCloudDevice): string {
    return device.name ?? `Roborock ${this.maskIdentifier(device.duid)}`;
  }

  private maskIdentifier(value?: string): string {
    if (!value) {
      return 'unknown';
    }

    return value.length <= 4 ? '****' : `...${value.slice(-4)}`;
  }
}

export class RoborockCloudVacuumClient implements RoborockVacuumClient {
  private readonly statusListeners = new Set<RoborockStatusListener>();
  private readonly unsubscribeFromDpsUpdates: () => void;
  private mappedCleanToken = 0;

  constructor(
    private readonly roborock: Roborock,
    private readonly config: RoborockVacuumConfig,
    private readonly log: Logger,
    private readonly deviceOperations: DeviceOperationCoordinator,
  ) {
    this.unsubscribeFromDpsUpdates = this.roborock.onDpsUpdate((update) => {
      this.handleDpsUpdate(update);
    });
  }

  public async getStatus(): Promise<RoborockStatus> {
    const statusRequest = this.preferredStatusRequest();

    try {
      const payload = await this.call(statusRequest.method, statusRequest.params);
      return this.normalizeStatus(payload);
    } catch (error) {
      if (isCloudAckTimeout(error, statusRequest.method)) {
        if (await this.handleStatusTimeout()) {
          return this.retryStatusAfterRecovery(statusRequest.method, statusRequest.params);
        }
        throw error;
      }

      this.log.debug(
        `Roborock cloud call "${statusRequest.method}" failed for ${this.config.name}; `
        + `trying "${statusRequest.fallbackMethod}". ${String(error)}`,
      );
    }

    try {
      const payload = await this.call(statusRequest.fallbackMethod, statusRequest.fallbackParams);
      return this.normalizeStatus(payload);
    } catch (error) {
      if (isCloudAckTimeout(error, statusRequest.fallbackMethod)) {
        if (await this.handleStatusTimeout()) {
          return this.retryStatusAfterRecovery(statusRequest.fallbackMethod, statusRequest.fallbackParams);
        }
      }
      throw error;
    }
  }

  public async start(): Promise<void> {
    this.cancelPendingMappedClean();
    await this.command('app_start', []);
  }

  public async pause(): Promise<void> {
    this.cancelPendingMappedClean();
    await this.command('app_pause', []);
  }

  public async stop(): Promise<void> {
    this.cancelPendingMappedClean();
    await this.command('app_stop', []);
  }

  public async dock(): Promise<void> {
    this.cancelPendingMappedClean();
    await this.command('app_charge', []);
  }

  public async locate(): Promise<void> {
    await this.command('find_me', []);
  }

  public async setCleanMode(mode: CleanModeConfig): Promise<void> {
    const commands: Array<Promise<void>> = [];

    if (typeof mode.fanPower === 'number') {
      commands.push(this.command('set_custom_mode', [mode.fanPower]));
    }

    if (typeof mode.waterBoxMode === 'number') {
      commands.push(this.command('set_water_box_custom_mode', [mode.waterBoxMode]));
    }

    await Promise.all(commands);
  }

  public async cleanAreas(areas: ServiceAreaConfig[]): Promise<void> {
    const cleanToken = this.nextMappedCleanToken();

    if (areas.length === 0) {
      await this.start();
      return;
    }

    const roomAreas = areas.filter((area) => area.kind !== 'zone');
    const zoneAreas = areas.filter((area) => area.kind === 'zone');

    if (roomAreas.length > 0 && zoneAreas.length > 0) {
      throw new Error('Roborock room and zone cleaning cannot be mixed in one command.');
    }

    if (roomAreas.length > 0) {
      const segmentIds = roomAreas.map((area) => area.segmentId ?? area.areaId);
      const repeat = Math.max(...roomAreas.map((area) => area.repeat ?? 1));
      const payload = this.config.segmentCleanPayload ?? 'segmentsObject';
      const mapId = this.singleMapId(roomAreas);
      const cleanRooms = async () => {
        if (payload === 'segmentIds') {
          await this.command('app_segment_clean', segmentIds);
          return;
        }

        await this.command('app_segment_clean', [{ segments: segmentIds, repeat }]);
      };

      await this.runMappedClean(mapId, cleanToken, 'room clean', cleanRooms);
      return;
    }

    const zones = zoneAreas.map((area) => {
      if (!area.coordinates) {
        throw new Error(`Service area "${area.label}" is missing zone coordinates.`);
      }

      return [...area.coordinates, area.repeat ?? 1];
    });

    await this.runMappedClean(this.singleMapId(zoneAreas), cleanToken, 'zone clean', () => this.command('app_zoned_clean', zones));
  }

  public destroy(): void {
    this.cancelPendingMappedClean();
    this.unsubscribeFromDpsUpdates();
    this.statusListeners.clear();
    // The shared cloud connection owns the Roborock service lifecycle.
  }

  public onStatusUpdate(listener: RoborockStatusListener): () => void {
    this.statusListeners.add(listener);

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private handleDpsUpdate(update: RoborockDpsUpdate): void {
    if (update.duid !== this.config.duid) {
      return;
    }

    const status = this.normalizeDpsStatus(update.dps);
    if (!this.hasStatusValues(status)) {
      return;
    }

    for (const listener of this.statusListeners) {
      Promise.resolve(listener(status)).catch((error) => {
        this.log.warn(`Failed to apply Roborock push status update for ${this.config.name}: ${formatRoborockError(error)}`);
      });
    }
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    if (!this.config.duid) {
      throw new Error(`Missing Roborock cloud device ID for ${this.config.name}.`);
    }

    await this.deviceOperations.waitForExclusive(this.config.duid);
    return this.roborock.messageQueueHandler.sendRequest(this.config.duid, method, params);
  }

  private async handleStatusTimeout(): Promise<boolean> {
    this.log.warn(
      `A Roborock status request for ${this.config.name} timed out; `
      + 'reconnecting the cloud MQTT session.',
    );

    try {
      await this.roborock.recoverMqttConnection();
      this.log.info(`Roborock cloud MQTT session recovered for ${this.config.name}.`);
      return true;
    } catch (error) {
      this.log.warn(`Could not recover the Roborock cloud MQTT session for ${this.config.name}. ${formatRoborockError(error)}`);
      return false;
    }
  }

  private async retryStatusAfterRecovery(method: string, params: unknown[]): Promise<RoborockStatus> {
    const payload = await this.call(method, params);
    this.log.info(`Roborock status responses recovered for ${this.config.name}.`);
    return this.normalizeStatus(payload);
  }

  private async command(method: string, params: unknown[]): Promise<void> {
    const response = this.call(method, params);
    let timeout: NodeJS.Timeout | undefined;
    let returnedEarly = false;

    try {
      await Promise.race([
        response.then(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            returnedEarly = true;
            resolve();
          }, 2_000);
        }),
      ]);
    } catch (error) {
      if (isCloudAckTimeout(error, method)) {
        this.log.warn(`Roborock command "${method}" for ${this.config.name} timed out waiting for a cloud acknowledgement; treating it as sent.`);
        return;
      }

      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (returnedEarly) {
      response.catch((error) => {
        if (!isCloudAckTimeout(error, method)) {
          this.log.warn(`Roborock command "${method}" for ${this.config.name} eventually failed after Matter already returned. ${formatRoborockError(error)}`);
        }
      });
      this.log.debug(`Roborock command "${method}" for ${this.config.name} was sent but not acknowledged within 2 seconds; returning early so Apple Home stays responsive.`);
    }
  }

  private singleMapId(areas: ServiceAreaConfig[]): number | undefined {
    const mapIds = new Set(areas
      .map((area) => area.roborockMapId ?? area.mapId)
      .filter((mapId): mapId is number => typeof mapId === 'number'));

    if (mapIds.size > 1) {
      throw new Error('Roborock cannot clean rooms from multiple maps in one command.');
    }

    return [...mapIds][0];
  }

  private nextMappedCleanToken(): number {
    this.mappedCleanToken++;
    return this.mappedCleanToken;
  }

  private cancelPendingMappedClean(): void {
    this.mappedCleanToken++;
  }

  private isMappedCleanCurrent(token: number): boolean {
    return token === this.mappedCleanToken;
  }

  private async runMappedClean(
    mapId: number | undefined,
    token: number,
    action: string,
    clean: () => Promise<void>,
  ): Promise<void> {
    if (mapId === undefined) {
      await clean();
      return;
    }

    const currentMapId = await this.currentMapIdForCommand();
    if (currentMapId === mapId) {
      await clean();
      return;
    }

    this.log.info(
      `Roborock ${action} for ${this.config.name} needs map ${mapId}; `
      + 'switching maps in the background and waiting for confirmation before sending the clean command.',
    );
    void this.switchMapThenRunClean(mapId, token, action, clean).catch((error) => {
      this.log.warn(`Roborock ${action} for ${this.config.name} failed after Matter already returned. ${formatRoborockError(error)}`);
    });
  }

  private async currentMapIdForCommand(): Promise<number | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    const statusRequest = this.getStatus()
      .then((status) => status.mapId)
      .catch((error) => {
        this.log.debug(`Could not read current Roborock map for ${this.config.name} before a map-specific clean. ${formatRoborockError(error)}`);
        return undefined;
      });

    try {
      return await Promise.race([
        statusRequest,
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), COMMAND_MAP_STATUS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async switchMapThenRunClean(
    mapId: number,
    token: number,
    action: string,
    clean: () => Promise<void>,
  ): Promise<void> {
    const switched = await this.switchRoborockMapForCommand(mapId, action);
    if (!switched) {
      return;
    }

    if (!this.isMappedCleanCurrent(token)) {
      this.log.debug(`Skipping Roborock ${action} for ${this.config.name} because a newer command superseded it.`);
      return;
    }

    await clean();
  }

  private async switchRoborockMapForCommand(mapId: number, action: string): Promise<boolean> {
    try {
      await this.command('load_multi_map', [mapId]);
    } catch (error) {
      if (!isCloudAckTimeout(error, 'load_multi_map')) {
        throw error;
      }

      this.log.warn(`Roborock map switch to ${mapId} for ${this.config.name} timed out waiting for a cloud acknowledgement; waiting for map confirmation before ${action}.`);
    }

    const confirmation = await this.waitForRoborockMapForCommand(mapId);
    if (confirmation === 'confirmed') {
      await this.delay(MAP_DISCOVERY_SETTLE_MS);
      return true;
    }

    this.log.warn(
      `Roborock did not confirm map ${mapId} for ${this.config.name}; `
      + `not sending ${action} to avoid cleaning rooms on the wrong map.`,
    );
    return false;
  }

  private async waitForRoborockMapForCommand(mapId: number): Promise<'confirmed' | 'mismatch' | 'unknown'> {
    const startedAt = Date.now();
    let sawMapStatus = false;
    let lastMapId: number | undefined;

    while (Date.now() - startedAt < MAP_DISCOVERY_CONFIRM_TIMEOUT_MS) {
      await this.delay(MAP_DISCOVERY_CONFIRM_INTERVAL_MS);

      let status: RoborockStatus;
      try {
        status = await this.getStatus();
      } catch (error) {
        this.log.debug(`Could not confirm Roborock map ${mapId} for ${this.config.name}; retrying. ${formatRoborockError(error)}`);
        continue;
      }

      if (status.mapId === undefined) {
        continue;
      }

      sawMapStatus = true;
      lastMapId = status.mapId;

      if (status.mapId === mapId) {
        return 'confirmed';
      }
    }

    if (sawMapStatus) {
      this.log.debug(`Roborock ${this.config.name} last reported map ${lastMapId} while waiting for map ${mapId}.`);
      return 'mismatch';
    }

    this.log.debug(`Roborock ${this.config.name} did not report a current map while waiting for map ${mapId}.`);
    return 'unknown';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private preferredStatusRequest(): {
    method: string;
    params: unknown[];
    fallbackMethod: string;
    fallbackParams: unknown[];
  } {
    const version = this.config.duid ? this.roborock.getRobotVersion(this.config.duid) : undefined;
    const usesPropertyStatus = version === 'B01' || version === '\x81S\x19';

    if (usesPropertyStatus) {
      return {
        method: 'get_prop',
        params: ['get_status'],
        fallbackMethod: 'get_status',
        fallbackParams: [],
      };
    }

    return {
      method: 'get_status',
      params: [],
      fallbackMethod: 'get_prop',
      fallbackParams: ['get_status'],
    };
  }

  private normalizeStatus(payload: unknown): RoborockStatus {
    const raw = this.firstStatusObject(payload);

    return this.compactStatus({
      state: raw?.state,
      battery: raw?.battery,
      errorCode: raw?.error_code,
      fanPower: raw?.fan_power,
      waterBoxMode: raw?.water_box_mode,
      mopMode: raw?.mop_mode,
      inCleaning: raw?.in_cleaning,
      cleanArea: raw?.clean_area,
      cleanTime: raw?.clean_time,
      mapId: this.mapIdFromMapStatus(raw?.map_status),
    });
  }

  private normalizeDpsStatus(dps: Record<string, unknown>): RoborockStatus {
    const status = this.normalizeStatus(dps);
    const pushedState = this.toNumber(dps['121']);

    if (pushedState !== undefined) {
      status.state = pushedState;
    }

    const pushedMapId = this.mapIdFromMapStatus(this.toNumber(dps.map_status));
    if (pushedMapId !== undefined) {
      status.mapId = pushedMapId;
    }

    return status;
  }

  private compactStatus(status: RoborockStatus): RoborockStatus {
    return Object.fromEntries(
      Object.entries(status).filter(([, value]) => value !== undefined),
    );
  }

  private hasStatusValues(status: RoborockStatus): boolean {
    return Object.values(status).some((value) => value !== undefined);
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private firstStatusObject(payload: unknown): RawRoborockStatus | undefined {
    if (Array.isArray(payload)) {
      return this.firstStatusObject(payload[0]);
    }

    if (this.isRawStatus(payload)) {
      return payload;
    }

    return undefined;
  }

  private isRawStatus(value: unknown): value is RawRoborockStatus {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    return [
      'state',
      'battery',
      'error_code',
      'fan_power',
      'water_box_mode',
      'mop_mode',
      'in_cleaning',
      'clean_area',
      'clean_time',
      'map_status',
    ].some((key) => key in value);
  }

  private mapIdFromMapStatus(mapStatus?: number): number | undefined {
    if (mapStatus === undefined) {
      return undefined;
    }

    const mapId = mapStatus >> 2;
    return mapId === ROBOROCK_NO_MAP_ID ? undefined : mapId;
  }
}
