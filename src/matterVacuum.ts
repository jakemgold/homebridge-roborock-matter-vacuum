import type { API, Logger, MatterAccessory } from 'homebridge';
import type { RoborockStatus, RoborockVacuumClient } from './roborockClient';
import {
  DEFAULT_CLEAN_MODES,
  DEFAULT_MOP_ONLY_CLEAN_MODES,
  DEFAULT_POLLING_INTERVAL_SECONDS,
  DEFAULT_VACUUM_AND_MOP_CLEAN_MODES,
  PLUGIN_NAME,
  type CleanModeConfig,
  type RoborockMatterConfig,
  type RoborockVacuumConfig,
  type ServiceAreaConfig,
  type ServiceMapConfig,
} from './settings';

type MatterClusterState = Record<string, unknown>;
type CleanModeIntensityTag = NonNullable<CleanModeConfig['intensity']>;

const RVC_RUN_MODE_TAGS = {
  Idle: 0x4000,
  Cleaning: 0x4001,
} as const;

const RVC_CLEAN_MODE_TAGS = {
  Auto: 0,
  Quick: 1,
  Quiet: 2,
  LowNoise: 3,
  LowEnergy: 4,
  Vacation: 5,
  Min: 6,
  Max: 7,
  Night: 8,
  Day: 9,
  DeepClean: 0x4000,
  Vacuum: 0x4001,
  Mop: 0x4002,
  VacuumThenMop: 0x4003,
} as const;

const RVC_CLEAN_MODE_INTENSITY_TAGS: Record<CleanModeIntensityTag, number> = {
  auto: RVC_CLEAN_MODE_TAGS.Auto,
  quick: RVC_CLEAN_MODE_TAGS.Quick,
  quiet: RVC_CLEAN_MODE_TAGS.Quiet,
  lowNoise: RVC_CLEAN_MODE_TAGS.LowNoise,
  lowEnergy: RVC_CLEAN_MODE_TAGS.LowEnergy,
  min: RVC_CLEAN_MODE_TAGS.Min,
  max: RVC_CLEAN_MODE_TAGS.Max,
  night: RVC_CLEAN_MODE_TAGS.Night,
  day: RVC_CLEAN_MODE_TAGS.Day,
  deepClean: RVC_CLEAN_MODE_TAGS.DeepClean,
  vacation: RVC_CLEAN_MODE_TAGS.Vacation,
};

const RVC_CLEAN_MODE_TAG_NAMES = Object.fromEntries(
  Object.entries(RVC_CLEAN_MODE_TAGS).map(([key, value]) => [value, key]),
) as Record<number, string>;

const RVC_OPERATIONAL_STATES = {
  Stopped: 0,
  Running: 1,
  Paused: 2,
  Error: 3,
  SeekingCharger: 64,
  Charging: 65,
  Docked: 66,
  EmptyingDustBin: 67,
  CleaningMop: 68,
  FillingWaterTank: 69,
  UpdatingMaps: 70,
} as const;

const RVC_ERROR_STATES = {
  NoError: 0,
  UnableToCompleteOperation: 2,
  FailedToFindChargingDock: 64,
  Stuck: 65,
  DustBinMissing: 66,
  LowBattery: 72,
  WheelsJammed: 76,
  BrushJammed: 77,
  NavigationSensorObscured: 78,
} as const;

const POWER_SOURCE_STATUS = {
  Active: 1,
} as const;

const BATTERY_CHARGE_LEVEL = {
  Ok: 0,
  Warning: 1,
  Critical: 2,
} as const;

const BATTERY_CHARGE_STATE = {
  Unknown: 0,
  IsCharging: 1,
  IsAtFullCharge: 2,
  IsNotCharging: 3,
} as const;

const SERVICE_AREA_SELECT_STATUS = {
  Success: 0,
  UnsupportedArea: 1,
  InvalidSet: 3,
} as const;

const SERVICE_AREA_SKIP_STATUS = {
  Success: 0,
} as const;

const MIN_POLLING_INTERVAL_SECONDS = 60;
const REFRESH_WARNING_THROTTLE_MS = 10 * 60 * 1000;
const MAX_REFRESH_BACKOFF_MS = 5 * 60 * 1000;
const OPTIMISTIC_STATE_WINDOW_MS = 25 * 1000;
const COMMAND_RECONCILIATION_REFRESH_DELAYS_MS = [5 * 1000, 20 * 1000] as const;
const STARTUP_RECONCILIATION_REFRESH_DELAYS_MS = [3 * 1000, 10 * 1000] as const;
const MODEL_CODE_PATTERN = /(?:^|[.\s_-])(a\d+)(?=$|[.\s_-])/g;
const MOPPING_MODEL_CODES = new Set([
  'a09',
  'a10',
  'a11',
  'a15',
  'a21',
  'a27',
  'a38',
  'a40',
  'a51',
  'a62',
  'a65',
  'a70',
  'a72',
  'a73',
  'a75',
  'a87',
  'a97',
  'a101',
  'a104',
  'a117',
  'a135',
  'a144',
  'a147',
]);
const MOP_ONLY_MODEL_CODES = new Set([
  'a21',
  'a87',
  'a101',
  'a104',
  'a117',
  'a135',
]);
const MOPPING_MODEL_NAME_TOKENS = [
  's5e',
  's6 maxv',
  's7',
  's8',
  'q5 pro',
  'q7',
  'q8',
  'qrevo',
  'saros',
];
const MOP_ONLY_MODEL_NAME_TOKENS = [
  'qrevo',
];

type StatusUpdateSource = 'refresh' | 'push' | 'optimistic';

export class RoborockMatterVacuum {
  private readonly uuid: string;
  private readonly cleanModes: CleanModeConfig[];
  private readonly serviceAreas: ServiceAreaConfig[];
  private readonly serviceMaps: ServiceMapConfig[];
  private pollTimer?: NodeJS.Timeout;
  private statusUpdateUnsubscribe?: () => void;
  private readonly commandRefreshTimers = new Set<NodeJS.Timeout>();
  private readonly startupRefreshTimers = new Set<NodeJS.Timeout>();
  private accessory?: MatterAccessory;
  private readonly defaultCleanModeValue: number;
  private selectedAreaIds: number[] = [];
  private lastKnownStatus?: RoborockStatus;
  private refreshInFlight = false;
  private consecutiveRefreshFailures = 0;
  private lastRefreshWarningAt = 0;
  private nextRefreshAllowedAt = 0;
  private optimisticOperationalState?: number;
  private optimisticStateExpiresAt = 0;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly platformConfig: RoborockMatterConfig,
    private readonly config: RoborockVacuumConfig,
    private readonly client: RoborockVacuumClient,
  ) {
    const identity = this.config.id
      ?? this.config.duid
      ?? this.config.serialNumber
      ?? this.config.name;
    this.uuid = this.api.matter!.uuid.generate(`${PLUGIN_NAME}:${identity}`);
    this.cleanModes = this.normalizeCleanModes(this.config.cleanModes?.length ? this.config.cleanModes : this.defaultCleanModes());
    this.defaultCleanModeValue = this.resolveDefaultCleanMode();
    this.serviceMaps = this.normalizeServiceMaps(this.config.serviceMaps ?? this.serviceMapsFromAreas(this.config.serviceAreas ?? []));
    this.serviceAreas = this.normalizeServiceAreas(this.config.serviceAreas ?? []);
  }

  public get UUID(): string {
    return this.uuid;
  }

  public buildAccessory(initialStatus?: RoborockStatus): MatterAccessory {
    if (initialStatus) {
      this.lastKnownStatus = this.mergeStatus(initialStatus);
    }

    const state = this.toMatterState(initialStatus);
    const cleanModeStructs = this.cleanModeStructs();
    this.log.info(`Matter clean modes for ${this.config.name}: ${this.describeCleanModeStructs(cleanModeStructs)}`);

    const accessory: MatterAccessory = {
      UUID: this.uuid,
      displayName: this.config.name,
      deviceType: this.api.matter!.deviceTypes.RoboticVacuumCleaner,
      serialNumber: this.config.serialNumber ?? this.config.duid ?? this.config.id ?? this.config.name,
      manufacturer: this.config.manufacturer ?? 'Roborock',
      model: this.config.model ?? 'Roborock Vacuum',
      clusters: {
        rvcRunMode: {
          currentMode: state.runMode,
          supportedModes: this.runModes(),
        },
        rvcCleanMode: {
          currentMode: state.cleanMode,
          supportedModes: cleanModeStructs,
        },
        rvcOperationalState: {
          operationalStateList: this.operationalStateList(),
          operationalState: state.operationalState,
          operationalError: state.operationalError,
        },
        identify: {
          identifyTime: 0,
          identifyType: 3,
        },
        powerSource: state.powerSource,
        ...this.serviceAreaCluster(),
      },
      handlers: {
        rvcRunMode: {
          changeToMode: async (request: { newMode: number }) => {
            await this.changeRunMode(request.newMode);
            await this.applyOptimisticRunMode(request.newMode);
            this.scheduleCommandRefreshes();
          },
        },
        rvcCleanMode: {
          changeToMode: async (request: { newMode: number }) => {
            await this.changeCleanMode(request.newMode);
            this.scheduleCommandRefreshes();
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await this.withMatterError('pause vacuum', () => this.client.pause());
            await this.applyOptimisticStatus({ state: 10 }, RVC_OPERATIONAL_STATES.Paused);
            this.scheduleCommandRefreshes();
          },
          resume: async () => {
            await this.withMatterError('resume vacuum', () => this.client.start());
            await this.applyOptimisticStatus({ state: 5 }, RVC_OPERATIONAL_STATES.Running);
            this.scheduleCommandRefreshes();
          },
          goHome: async () => {
            await this.withMatterError('dock vacuum', () => this.client.dock());
            await this.applyOptimisticStatus({ state: 6 }, RVC_OPERATIONAL_STATES.SeekingCharger);
            this.scheduleCommandRefreshes();
          },
        },
        identify: {
          identify: async (request: { identifyTime?: number }) => {
            await this.identify(request.identifyTime);
          },
        },
        ...this.serviceAreaHandlers(),
      },
      context: {
        duid: this.config.duid,
        id: this.config.id,
        manufacturer: this.config.manufacturer ?? 'Roborock',
        model: this.config.model ?? 'Roborock Vacuum',
        serialNumber: this.config.serialNumber ?? this.config.duid ?? this.config.id,
        selectedAreaIds: this.selectedAreaIds,
      },
    } as unknown as MatterAccessory;

    this.accessory = accessory;
    return accessory;
  }

  public restoreSelectedAreaIds(value: unknown): void {
    if (!Array.isArray(value) || this.serviceAreas.length === 0) {
      return;
    }

    const supportedAreaIds = new Set(this.serviceAreas.map((area) => area.areaId));
    this.selectedAreaIds = [...new Set(value)]
      .filter((areaId): areaId is number => typeof areaId === 'number' && Number.isInteger(areaId) && supportedAreaIds.has(areaId));
  }

  public startPolling(): void {
    this.statusUpdateUnsubscribe ??= this.client.onStatusUpdate?.((status) => {
      void this.applyStatusUpdate(status, 'push').catch((error) => {
        this.log.warn(`Failed to apply Roborock push update for ${this.config.name}: ${String(error)}`);
      });
    });

    const seconds = this.config.pollingIntervalSeconds
      ?? this.platformConfig.pollingIntervalSeconds
      ?? DEFAULT_POLLING_INTERVAL_SECONDS;
    const intervalSeconds = Math.max(seconds, MIN_POLLING_INTERVAL_SECONDS);

    this.pollTimer = setInterval(() => {
      void this.refreshState();
    }, intervalSeconds * 1000);

    this.scheduleStartupRefreshes();
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    this.statusUpdateUnsubscribe?.();
    this.statusUpdateUnsubscribe = undefined;
    this.clearStartupRefreshes();
    this.clearCommandRefreshes();
  }

  public destroy(): void {
    this.stopPolling();
    void Promise.resolve(this.client.destroy()).catch((error) => {
      this.log.warn(`Failed to destroy Roborock client for ${this.config.name}: ${String(error)}`);
    });
  }

  private async changeRunMode(newMode: number): Promise<void> {
    await this.withMatterError('change run mode', async () => {
      if (newMode === 0) {
        await this.client.pause();
        return;
      }

      if (this.selectedAreaIds.length > 0) {
        const selectedAreas = this.serviceAreas.filter((area) => this.selectedAreaIds.includes(area.areaId));
        await this.client.cleanAreas(selectedAreas);
        return;
      }

      await this.client.start();
    });
  }

  private async changeCleanMode(newMode: number): Promise<void> {
    const mode = this.cleanModes.find((cleanMode) => cleanMode.mode === newMode);

    if (!mode) {
      throw new Error(`Unsupported clean mode: ${newMode}`);
    }

    await this.withMatterError('change clean mode', () => this.client.setCleanMode(mode));
    await this.api.matter?.updateAccessoryState(this.uuid, this.clusterName('RvcCleanMode', 'rvcCleanMode'), {
      currentMode: newMode,
    });
  }

  private async identify(identifyTime?: number): Promise<void> {
    if (identifyTime === 0) {
      return;
    }

    await this.withMatterError('locate vacuum', () => this.client.locate());
    await this.api.matter?.updateAccessoryState(this.uuid, this.clusterName('Identify', 'identify'), {
      identifyTime: 0,
    });
  }

  private async applyOptimisticRunMode(newMode: number): Promise<void> {
    if (newMode === 0) {
      await this.applyOptimisticStatus({ state: 10 }, RVC_OPERATIONAL_STATES.Paused);
      return;
    }

    await this.applyOptimisticStatus({ state: 5 }, RVC_OPERATIONAL_STATES.Running);
  }

  private async applyOptimisticStatus(status: RoborockStatus, operationalState: number): Promise<void> {
    this.optimisticOperationalState = operationalState;
    this.optimisticStateExpiresAt = Date.now() + OPTIMISTIC_STATE_WINDOW_MS;
    await this.applyStatusUpdate(status, 'optimistic');
  }

  private scheduleCommandRefreshes(): void {
    this.clearCommandRefreshes();

    for (const delay of COMMAND_RECONCILIATION_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.commandRefreshTimers.delete(timer);
        void this.refreshState(true);
      }, delay);
      this.commandRefreshTimers.add(timer);
    }
  }

  private clearCommandRefreshes(): void {
    for (const timer of this.commandRefreshTimers) {
      clearTimeout(timer);
    }
    this.commandRefreshTimers.clear();
  }

  private scheduleStartupRefreshes(): void {
    this.clearStartupRefreshes();

    for (const delay of STARTUP_RECONCILIATION_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.startupRefreshTimers.delete(timer);
        void this.refreshState(true);
      }, delay);
      this.startupRefreshTimers.add(timer);
    }
  }

  private clearStartupRefreshes(): void {
    for (const timer of this.startupRefreshTimers) {
      clearTimeout(timer);
    }
    this.startupRefreshTimers.clear();
  }

  private async refreshState(force = false): Promise<void> {
    if (!this.api.matter) {
      return;
    }

    const now = Date.now();
    if (this.refreshInFlight || (!force && now < this.nextRefreshAllowedAt)) {
      return;
    }

    this.refreshInFlight = true;

    try {
      const status = await this.client.getStatus();
      await this.applyStatusUpdate(status, 'refresh');

      if (this.consecutiveRefreshFailures > 0) {
        this.log.info(`Roborock status refresh recovered for ${this.config.name} after ${this.consecutiveRefreshFailures} failed attempt(s).`);
      }
      this.consecutiveRefreshFailures = 0;
      this.nextRefreshAllowedAt = 0;
    } catch (error) {
      this.handleRefreshError(error);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async applyStatusUpdate(status: RoborockStatus, source: StatusUpdateSource): Promise<void> {
    if (!this.api.matter) {
      return;
    }

    const holdOptimisticState = source !== 'optimistic' && this.shouldHoldOptimisticState(status);
    const effectiveStatus = holdOptimisticState
      ? { ...status, state: undefined }
      : status;

    if (!this.hasStatusValues(effectiveStatus)) {
      return;
    }

    const mergedStatus = this.mergeStatus(effectiveStatus);
    const state = this.toMatterState(mergedStatus);

    await this.api.matter.updateAccessoryState(this.uuid, this.clusterName('RvcRunMode', 'rvcRunMode'), {
      currentMode: state.runMode,
    });

    await this.api.matter.updateAccessoryState(this.uuid, this.clusterName('RvcCleanMode', 'rvcCleanMode'), {
      currentMode: state.cleanMode,
    });

    await this.api.matter.updateAccessoryState(
      this.uuid,
      this.clusterName('RvcOperationalState', 'rvcOperationalState'),
      {
        operationalState: state.operationalState,
        operationalError: state.operationalError,
      },
    );

    await this.api.matter.updateAccessoryState(this.uuid, this.clusterName('PowerSource', 'powerSource'), state.powerSource);

    if (source !== 'optimistic' && status.state !== undefined && !holdOptimisticState) {
      this.clearOptimisticState();
    }
  }

  private mergeStatus(status: RoborockStatus): RoborockStatus {
    const nextStatus: RoborockStatus = { ...(this.lastKnownStatus ?? {}) };

    for (const [key, value] of Object.entries(status)) {
      if (value !== undefined) {
        (nextStatus as Record<string, unknown>)[key] = value;
      }
    }

    this.lastKnownStatus = nextStatus;
    return nextStatus;
  }

  private hasStatusValues(status: RoborockStatus): boolean {
    return Object.values(status).some((value) => value !== undefined);
  }

  private shouldHoldOptimisticState(status: RoborockStatus): boolean {
    if (status.state === undefined || this.optimisticOperationalState === undefined) {
      return false;
    }

    if (Date.now() > this.optimisticStateExpiresAt) {
      this.clearOptimisticState();
      return false;
    }

    const observedStatus = {
      ...(this.lastKnownStatus ?? {}),
      ...status,
    };
    const observedOperationalState = this.toOperationalState(observedStatus);

    return !this.optimisticStateAccepts(observedOperationalState);
  }

  private optimisticStateAccepts(operationalState: number): boolean {
    switch (this.optimisticOperationalState) {
      case RVC_OPERATIONAL_STATES.Running:
        return operationalState === RVC_OPERATIONAL_STATES.Running;
      case RVC_OPERATIONAL_STATES.Paused:
        return operationalState === RVC_OPERATIONAL_STATES.Paused;
      case RVC_OPERATIONAL_STATES.SeekingCharger:
        return ([
          RVC_OPERATIONAL_STATES.SeekingCharger,
          RVC_OPERATIONAL_STATES.Charging,
          RVC_OPERATIONAL_STATES.Docked,
        ] as number[]).includes(operationalState);
      default:
        return operationalState === this.optimisticOperationalState;
    }
  }

  private clearOptimisticState(): void {
    this.optimisticOperationalState = undefined;
    this.optimisticStateExpiresAt = 0;
  }

  private handleRefreshError(error: unknown): void {
    this.consecutiveRefreshFailures++;
    const now = Date.now();
    const backoffMs = this.refreshBackoffMs(this.consecutiveRefreshFailures);
    this.nextRefreshAllowedAt = now + backoffMs;

    if (this.consecutiveRefreshFailures === 1 || now - this.lastRefreshWarningAt >= REFRESH_WARNING_THROTTLE_MS) {
      this.lastRefreshWarningAt = now;
      this.log.warn(
        `Unable to refresh ${this.config.name}: ${String(error)} `
        + `Status polling will retry in ${Math.round(backoffMs / 1000)} seconds; repeated refresh errors are throttled.`,
      );
      return;
    }

    this.log.debug(`Suppressed repeated refresh error for ${this.config.name}: ${String(error)}`);
  }

  private refreshBackoffMs(failures: number): number {
    const exponentialBackoffSeconds = 30 * (2 ** Math.min(failures - 1, 4));
    return Math.min(exponentialBackoffSeconds * 1000, MAX_REFRESH_BACKOFF_MS);
  }

  private toMatterState(status?: RoborockStatus): {
    runMode: number;
    cleanMode: number;
    operationalState: number;
    operationalError: MatterClusterState;
    powerSource: MatterClusterState;
  } {
    const errorCode = status?.errorCode ?? 0;
    const cleanMode = this.currentCleanMode(status);

    return {
      runMode: this.isCleaningState(status?.state) ? 1 : 0,
      cleanMode,
      operationalState: this.toOperationalState(status),
      operationalError: this.toOperationalError(status, errorCode),
      powerSource: this.toPowerSourceState(status),
    };
  }

  private toPowerSourceState(status?: RoborockStatus): MatterClusterState {
    const battery = this.normalizeBattery(status?.battery);

    return {
      status: POWER_SOURCE_STATUS.Active,
      order: 0,
      description: 'Rechargeable battery',
      batPresent: true,
      batPercentRemaining: battery === undefined ? null : battery * 2,
      batChargeLevel: this.toBatteryChargeLevel(battery),
      batChargeState: this.toBatteryChargeState(status, battery),
      batFunctionalWhileCharging: false,
    };
  }

  private normalizeBattery(battery?: number): number | undefined {
    if (typeof battery !== 'number' || Number.isNaN(battery)) {
      return undefined;
    }

    return Math.max(0, Math.min(100, Math.round(battery)));
  }

  private toBatteryChargeLevel(battery?: number): number {
    if (battery === undefined) {
      return BATTERY_CHARGE_LEVEL.Ok;
    }

    if (battery <= 10) {
      return BATTERY_CHARGE_LEVEL.Critical;
    }

    if (battery <= 20) {
      return BATTERY_CHARGE_LEVEL.Warning;
    }

    return BATTERY_CHARGE_LEVEL.Ok;
  }

  private toBatteryChargeState(status?: RoborockStatus, battery?: number): number {
    if (!status) {
      return BATTERY_CHARGE_STATE.Unknown;
    }

    if (status.state === 100 || ((status.state === 3 || status.state === 8) && battery !== undefined && battery >= 100)) {
      return BATTERY_CHARGE_STATE.IsAtFullCharge;
    }

    if (status.state === 8) {
      return BATTERY_CHARGE_STATE.IsCharging;
    }

    return BATTERY_CHARGE_STATE.IsNotCharging;
  }

  private toOperationalError(status: RoborockStatus | undefined, errorCode: number): MatterClusterState {
    if (errorCode === 0) {
      switch (status?.state) {
        case 9:
          return {
            errorStateId: RVC_ERROR_STATES.UnableToCompleteOperation,
            errorStateDetails: 'Roborock reported a charging problem.',
          };
        case 12:
          return {
            errorStateId: RVC_ERROR_STATES.UnableToCompleteOperation,
            errorStateDetails: 'Roborock reported an error state.',
          };
        case 101:
          return {
            errorStateId: RVC_ERROR_STATES.UnableToCompleteOperation,
            errorStateDetails: 'Roborock reports the vacuum is offline.',
          };
      }

      return { errorStateId: RVC_ERROR_STATES.NoError };
    }

    return {
      errorStateId: this.toMatterErrorState(errorCode),
      errorStateDetails: `Roborock reported error code ${errorCode}.`,
    };
  }

  private toOperationalState(status?: RoborockStatus): number {
    if ((status?.errorCode ?? 0) !== 0) {
      return RVC_OPERATIONAL_STATES.Error;
    }

    switch (status?.state) {
      case 5:
      case 11:
      case 16:
      case 17:
      case 18:
      case 22:
      case 23:
      case 26:
        return RVC_OPERATIONAL_STATES.Running;
      case 6:
      case 15:
        return RVC_OPERATIONAL_STATES.SeekingCharger;
      case 8:
        if (status.battery !== undefined && status.battery >= 99) {
          return RVC_OPERATIONAL_STATES.Docked;
        }
        return RVC_OPERATIONAL_STATES.Charging;
      case 10:
        return RVC_OPERATIONAL_STATES.Paused;
      case 9:
      case 12:
      case 101:
        return RVC_OPERATIONAL_STATES.Error;
      case 100:
        return RVC_OPERATIONAL_STATES.Docked;
      case 3:
        return RVC_OPERATIONAL_STATES.Docked;
      default:
        return RVC_OPERATIONAL_STATES.Stopped;
    }
  }

  private isCleaningState(state?: number): boolean {
    return [5, 11, 16, 17, 18, 22, 23, 26].includes(state ?? -1);
  }

  private defaultCleanModes(): CleanModeConfig[] {
    if (!this.shouldEnableMoppingModes()) {
      return DEFAULT_CLEAN_MODES;
    }

    return [
      ...DEFAULT_CLEAN_MODES.map((mode) => ({
        ...mode,
        waterBoxMode: 200,
      })),
      ...DEFAULT_VACUUM_AND_MOP_CLEAN_MODES,
      ...(this.shouldEnableMopOnlyModes() ? DEFAULT_MOP_ONLY_CLEAN_MODES : []),
    ];
  }

  private shouldEnableMoppingModes(): boolean {
    if (typeof this.config.enableMoppingModes === 'boolean') {
      return this.config.enableMoppingModes;
    }

    return this.modelMatches(MOPPING_MODEL_CODES, MOPPING_MODEL_NAME_TOKENS);
  }

  private shouldEnableMopOnlyModes(): boolean {
    return this.modelMatches(MOP_ONLY_MODEL_CODES, MOP_ONLY_MODEL_NAME_TOKENS);
  }

  private modelMatches(modelCodes: Set<string>, nameTokens: string[]): boolean {
    const normalizedModel = this.config.model?.toLowerCase() ?? '';
    if (!normalizedModel) {
      return false;
    }

    for (const code of this.modelCodes(normalizedModel)) {
      if (modelCodes.has(code)) {
        return true;
      }
    }

    return nameTokens.some((token) => normalizedModel.includes(token));
  }

  private modelCodes(model: string): Set<string> {
    return new Set([...model.matchAll(MODEL_CODE_PATTERN)].map((match) => match[1]));
  }

  private currentCleanMode(status?: RoborockStatus): number {
    const matches = this.cleanModes
      .map((mode) => {
        const fanScore = this.cleanModeAttributeScore(mode.fanPower, status?.fanPower);
        const waterScore = this.cleanModeAttributeScore(mode.waterBoxMode, status?.waterBoxMode);

        if (fanScore === -1 || waterScore === -1 || fanScore + waterScore === 0) {
          return undefined;
        }

        return {
          mode: mode.mode,
          score: fanScore + waterScore,
        };
      })
      .filter((match): match is { mode: number; score: number } => match !== undefined)
      .sort((left, right) => right.score - left.score);

    return matches[0]?.mode ?? this.defaultCleanModeValue;
  }

  private cleanModeAttributeScore(expected?: number, actual?: number): number {
    if (expected === undefined) {
      return 0;
    }

    if (actual === undefined) {
      return -1;
    }

    return expected === actual ? 1 : -1;
  }

  private runModes(): MatterClusterState[] {
    return [
      {
        label: 'Idle',
        mode: 0,
        modeTags: [{ value: RVC_RUN_MODE_TAGS.Idle }],
      },
      {
        label: 'Clean',
        mode: 1,
        modeTags: [{ value: RVC_RUN_MODE_TAGS.Cleaning }],
      },
    ];
  }

  private cleanModeStructs(): MatterClusterState[] {
    return this.cleanModes.map((mode) => ({
      label: mode.label,
      mode: mode.mode,
      modeTags: this.cleanModeTagValues(mode).map((value) => ({ value })),
    }));
  }

  private cleanModeTagValues(mode: CleanModeConfig): number[] {
    const tagValues: number[] = [];

    switch (mode.tag) {
      case 'mop':
        tagValues.push(RVC_CLEAN_MODE_TAGS.Mop);
        break;
      case 'vacuumAndMop':
        tagValues.push(RVC_CLEAN_MODE_TAGS.Vacuum, RVC_CLEAN_MODE_TAGS.Mop);
        break;
      case 'vacuum':
      default:
        tagValues.push(RVC_CLEAN_MODE_TAGS.Vacuum);
        break;
    }

    const intensity = mode.intensity ?? this.inferCleanModeIntensity(mode);
    if (intensity) {
      tagValues.push(RVC_CLEAN_MODE_INTENSITY_TAGS[intensity]);
    }

    return [...new Set(tagValues)];
  }

  private inferCleanModeIntensity(mode: CleanModeConfig): CleanModeIntensityTag | undefined {
    const label = mode.label.toLowerCase();

    if (mode.fanPower === 101 || /\b(quiet|silent|gentle|soft)\b/.test(label)) {
      return 'quiet';
    }

    if (mode.fanPower === 102 || /\b(balanced|standard|normal|auto|automatic)\b/.test(label)) {
      return 'auto';
    }

    if (mode.fanPower === 103 || /\b(turbo|strong|quick|fast)\b/.test(label)) {
      return 'quick';
    }

    if (mode.fanPower === 104 || /\b(max|maximum|full)\b/.test(label)) {
      return 'max';
    }

    return undefined;
  }

  private describeCleanModeStructs(cleanModeStructs: MatterClusterState[]): string {
    return cleanModeStructs.map((mode) => {
      const tags = (mode.modeTags as Array<{ value: number }> | undefined)
        ?.map(({ value }) => RVC_CLEAN_MODE_TAG_NAMES[value] ?? String(value))
        .join('+');

      return `${String(mode.label)}=${tags ?? 'none'}`;
    }).join(', ');
  }

  private operationalStateList(): MatterClusterState[] {
    return [
      { operationalStateId: RVC_OPERATIONAL_STATES.Stopped },
      { operationalStateId: RVC_OPERATIONAL_STATES.Running },
      { operationalStateId: RVC_OPERATIONAL_STATES.Paused },
      { operationalStateId: RVC_OPERATIONAL_STATES.Error },
      { operationalStateId: RVC_OPERATIONAL_STATES.SeekingCharger },
      { operationalStateId: RVC_OPERATIONAL_STATES.Charging },
      { operationalStateId: RVC_OPERATIONAL_STATES.Docked },
    ];
  }

  private toMatterErrorState(errorCode: number): number {
    switch (errorCode) {
      case 0:
        return RVC_ERROR_STATES.NoError;
      case 1:
      case 4:
      case 10:
      case 15:
        return RVC_ERROR_STATES.NavigationSensorObscured;
      case 5:
      case 6:
      case 17:
        return RVC_ERROR_STATES.BrushJammed;
      case 7:
        return RVC_ERROR_STATES.WheelsJammed;
      case 8:
        return RVC_ERROR_STATES.Stuck;
      case 9:
        return RVC_ERROR_STATES.DustBinMissing;
      case 12:
        return RVC_ERROR_STATES.LowBattery;
      case 13:
        return RVC_ERROR_STATES.FailedToFindChargingDock;
      default:
        return RVC_ERROR_STATES.UnableToCompleteOperation;
    }
  }

  private serviceAreaCluster(): Record<string, MatterClusterState> {
    if (this.serviceAreas.length === 0) {
      return {};
    }

    return {
      serviceArea: {
        supportedAreas: this.serviceAreas.map((area) => ({
          areaId: area.areaId,
          mapId: this.areaMapId(area),
          areaInfo: {
            locationInfo: {
              locationName: area.label,
            },
          },
        })),
        supportedMaps: this.serviceMaps,
        selectedAreas: this.selectedAreaIds,
      },
    };
  }

  private serviceAreaHandlers(): Record<string, MatterClusterState> {
    if (this.serviceAreas.length === 0) {
      return {};
    }

    return {
      serviceArea: {
        selectAreas: async (request: { newAreas?: number[]; areas?: number[] }) => {
          const selectedAreas = [...new Set(request.newAreas ?? request.areas ?? [])];
          const unknownAreas = selectedAreas.filter((areaId) => {
            return !this.serviceAreas.some((area) => area.areaId === areaId);
          });

          if (unknownAreas.length > 0) {
            return {
              status: SERVICE_AREA_SELECT_STATUS.UnsupportedArea,
              statusText: `Unknown service area(s): ${unknownAreas.join(', ')}`,
            };
          }

          const selectedAreaConfigs = this.serviceAreas.filter((area) => selectedAreas.includes(area.areaId));
          const selectedMapIds = new Set(selectedAreaConfigs.map((area) => this.areaMapId(area)));

          if (selectedMapIds.size > 1) {
            return {
              status: SERVICE_AREA_SELECT_STATUS.InvalidSet,
              statusText: 'Select rooms from one Roborock map at a time.',
            };
          }

          this.selectedAreaIds = selectedAreas;
          await this.updateSelectedAreas();

          return {
            status: SERVICE_AREA_SELECT_STATUS.Success,
            statusText: '',
          };
        },
        skipArea: async () => {
          this.selectedAreaIds = [];
          await this.updateSelectedAreas();
          return {
            status: SERVICE_AREA_SKIP_STATUS.Success,
            statusText: '',
          };
        },
      },
    };
  }

  private async updateSelectedAreas(): Promise<void> {
    await this.api.matter?.updateAccessoryState(this.uuid, this.clusterName('ServiceArea', 'serviceArea'), {
      selectedAreas: this.selectedAreaIds,
    });
    await this.persistSelectedAreaContext();
  }

  private normalizeServiceAreas(serviceAreas: ServiceAreaConfig[]): ServiceAreaConfig[] {
    const labelCounts = new Map<string, number>();
    const seenAreaIds = new Set<number>();
    const normalizedAreas: ServiceAreaConfig[] = [];

    for (const area of serviceAreas) {
      if (!Number.isInteger(area.areaId)) {
        this.log.warn(`Ignoring invalid service area for ${this.config.name}; areaId must be an integer.`);
        continue;
      }

      if (seenAreaIds.has(area.areaId)) {
        this.log.warn(`Ignoring duplicate service area ${area.areaId} for ${this.config.name}; Matter area IDs must be unique.`);
        continue;
      }

      const label = typeof area.label === 'string' ? area.label.trim() : '';
      if (!label) {
        this.log.warn(`Ignoring service area ${area.areaId} for ${this.config.name}; label must be a non-empty string.`);
        continue;
      }

      seenAreaIds.add(area.areaId);
      const mapId = this.areaMapId(area);
      const labelKey = `${mapId}:${label}`;
      const labelCount = labelCounts.get(labelKey) ?? 0;
      labelCounts.set(labelKey, labelCount + 1);

      normalizedAreas.push({
        ...area,
        label: labelCount === 0 ? label : `${label} (${labelCount + 1})`,
        mapId,
        mapName: area.mapName ?? this.serviceMaps.find((map) => map.mapId === mapId)?.name,
      });
    }

    return normalizedAreas;
  }

  private normalizeCleanModes(cleanModes: CleanModeConfig[]): CleanModeConfig[] {
    const seenModes = new Set<number>();
    const normalizedModes: CleanModeConfig[] = [];

    for (const mode of cleanModes) {
      if (!Number.isInteger(mode.mode)) {
        this.log.warn(`Ignoring invalid clean mode for ${this.config.name}; mode must be an integer.`);
        continue;
      }

      if (seenModes.has(mode.mode)) {
        this.log.warn(`Ignoring duplicate clean mode ${mode.mode} for ${this.config.name}; Matter mode IDs must be unique.`);
        continue;
      }

      const label = typeof mode.label === 'string' ? mode.label.trim() : '';
      if (!label) {
        this.log.warn(`Ignoring clean mode ${mode.mode} for ${this.config.name}; label must be a non-empty string.`);
        continue;
      }

      if (!this.isCleanModeTag(mode.tag)) {
        this.log.warn(`Ignoring clean mode ${mode.mode} for ${this.config.name}; tag must be vacuum, mop, or vacuumAndMop.`);
        continue;
      }

      seenModes.add(mode.mode);
      normalizedModes.push({
        ...mode,
        label,
      });
    }

    if (normalizedModes.length > 0) {
      return normalizedModes;
    }

    this.log.warn(`No valid clean modes were configured for ${this.config.name}; using built-in Roborock clean modes.`);
    return this.defaultCleanModes();
  }

  private isCleanModeTag(value: unknown): value is CleanModeConfig['tag'] {
    return value === 'vacuum' || value === 'mop' || value === 'vacuumAndMop';
  }

  private resolveDefaultCleanMode(): number {
    if (this.config.defaultCleanMode === undefined) {
      return this.cleanModes[0]?.mode ?? 0;
    }

    if (this.cleanModes.some((mode) => mode.mode === this.config.defaultCleanMode)) {
      return this.config.defaultCleanMode;
    }

    this.log.warn(`Ignoring default clean mode ${this.config.defaultCleanMode} for ${this.config.name}; it is not in supported clean modes.`);
    return this.cleanModes[0]?.mode ?? 0;
  }

  private async persistSelectedAreaContext(): Promise<void> {
    if (!this.accessory || !this.api.matter) {
      return;
    }

    const context = (this.accessory as unknown as { context?: Record<string, unknown> }).context;
    if (!context) {
      return;
    }

    context.selectedAreaIds = this.selectedAreaIds;
    await this.api.matter.updatePlatformAccessories([this.accessory]).catch((error) => {
      this.log.debug(`Could not persist selected Roborock service areas for ${this.config.name}: ${String(error)}`);
    });
  }

  private serviceMapsFromAreas(serviceAreas: ServiceAreaConfig[]): ServiceMapConfig[] {
    const mapsById = new Map<number, ServiceMapConfig>();

    for (const area of serviceAreas) {
      const mapId = area.mapId ?? 1;
      if (!mapsById.has(mapId)) {
        mapsById.set(mapId, {
          mapId,
          name: area.mapName ?? (mapId === 1 ? `${this.config.name} Map` : `Map ${mapId}`),
        });
      }
    }

    return [...mapsById.values()];
  }

  private normalizeServiceMaps(serviceMaps: ServiceMapConfig[]): ServiceMapConfig[] {
    const seenMapIds = new Set<number>();
    const seenNames = new Set<string>();
    const normalizedMaps: ServiceMapConfig[] = [];

    for (const serviceMap of serviceMaps) {
      if (!Number.isInteger(serviceMap.mapId) || seenMapIds.has(serviceMap.mapId)) {
        continue;
      }

      const baseName = serviceMap.name || `Map ${serviceMap.mapId}`;
      const name = this.uniqueMapName(baseName, seenNames, serviceMap.mapId);
      seenMapIds.add(serviceMap.mapId);
      normalizedMaps.push({ mapId: serviceMap.mapId, name });
    }

    if (normalizedMaps.length === 0 && (this.config.serviceAreas?.length ?? 0) > 0) {
      normalizedMaps.push({ mapId: 1, name: `${this.config.name} Map` });
    }

    return normalizedMaps.sort((left, right) => left.mapId - right.mapId);
  }

  private areaMapId(area: ServiceAreaConfig): number {
    return area.mapId ?? this.serviceMaps[0]?.mapId ?? 1;
  }

  private uniqueMapName(baseName: string, seenNames: Set<string>, mapId: number): string {
    if (!seenNames.has(baseName)) {
      seenNames.add(baseName);
      return baseName;
    }

    const suffixed = `${baseName} ${mapId}`;
    if (!seenNames.has(suffixed)) {
      seenNames.add(suffixed);
      return suffixed;
    }

    let counter = 2;
    while (seenNames.has(`${suffixed} ${counter}`)) {
      counter++;
    }

    const unique = `${suffixed} ${counter}`;
    seenNames.add(unique);
    return unique;
  }

  private clusterName(key: string, fallback: string): string {
    const clusterNames = this.api.matter?.clusterNames as Record<string, string> | undefined;
    return clusterNames?.[key] ?? fallback;
  }

  private async withMatterError(action: string, callback: () => Promise<void>): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.log.error(`Failed to ${action} for ${this.config.name}: ${String(error)}`);
      throw new Error(`Failed to ${action}.`, { cause: error });
    }
  }
}
