import type { API, Logger, MatterAccessory } from 'homebridge';
import type { RoborockStatus, RoborockVacuumClient } from './roborockClient';
import {
  DEFAULT_CLEAN_MODES,
  DEFAULT_MOPPING_CLEAN_MODES,
  DEFAULT_POLLING_INTERVAL_SECONDS,
  PLUGIN_NAME,
  type CleanModeConfig,
  type RoborockMatterConfig,
  type RoborockVacuumConfig,
  type ServiceAreaConfig,
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

export class RoborockMatterVacuum {
  private readonly uuid: string;
  private readonly cleanModes: CleanModeConfig[];
  private readonly serviceAreas: ServiceAreaConfig[];
  private pollTimer?: NodeJS.Timeout;
  private selectedAreaIds: number[] = [];

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
    this.cleanModes = this.config.cleanModes?.length ? this.config.cleanModes : this.defaultCleanModes();
    this.serviceAreas = this.config.serviceAreas ?? [];
  }

  public get UUID(): string {
    return this.uuid;
  }

  public buildAccessory(initialStatus?: RoborockStatus): MatterAccessory {
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
          },
        },
        rvcCleanMode: {
          changeToMode: async (request: { newMode: number }) => {
            await this.changeCleanMode(request.newMode);
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await this.withMatterError('pause vacuum', () => this.client.pause());
          },
          resume: async () => {
            await this.withMatterError('resume vacuum', () => this.client.start());
          },
          goHome: async () => {
            await this.withMatterError('dock vacuum', () => this.client.dock());
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
      },
    } as unknown as MatterAccessory;

    return accessory;
  }

  public startPolling(): void {
    const seconds = this.config.pollingIntervalSeconds
      ?? this.platformConfig.pollingIntervalSeconds
      ?? DEFAULT_POLLING_INTERVAL_SECONDS;

    this.pollTimer = setInterval(() => {
      void this.refreshState();
    }, Math.max(seconds, 5) * 1000);

    void this.refreshState();
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public destroy(): void {
    this.stopPolling();
    this.client.destroy();
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

  private async refreshState(): Promise<void> {
    if (!this.api.matter) {
      return;
    }

    try {
      const status = await this.client.getStatus();
      const state = this.toMatterState(status);

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
    } catch (error) {
      this.log.warn(`Unable to refresh ${this.config.name}: ${String(error)}`);
    }
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
      operationalError: this.toOperationalError(errorCode),
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

    if ((status.state === 3 || status.state === 8) && battery !== undefined && battery >= 100) {
      return BATTERY_CHARGE_STATE.IsAtFullCharge;
    }

    if (status.state === 8) {
      return BATTERY_CHARGE_STATE.IsCharging;
    }

    return BATTERY_CHARGE_STATE.IsNotCharging;
  }

  private toOperationalError(errorCode: number): MatterClusterState {
    if (errorCode === 0) {
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
        return RVC_OPERATIONAL_STATES.Running;
      case 6:
      case 15:
        return RVC_OPERATIONAL_STATES.SeekingCharger;
      case 8:
        return RVC_OPERATIONAL_STATES.Charging;
      case 10:
        return RVC_OPERATIONAL_STATES.Paused;
      case 3:
        return RVC_OPERATIONAL_STATES.Docked;
      default:
        return RVC_OPERATIONAL_STATES.Stopped;
    }
  }

  private isCleaningState(state?: number): boolean {
    return [5, 11, 16, 17, 18, 22, 23].includes(state ?? -1);
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
      ...DEFAULT_MOPPING_CLEAN_MODES,
    ];
  }

  private shouldEnableMoppingModes(): boolean {
    if (typeof this.config.enableMoppingModes === 'boolean') {
      return this.config.enableMoppingModes;
    }

    const model = this.config.model?.toLowerCase() ?? '';

    return [
      's5e',
      's6 maxv',
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
    ].some((token) => model.includes(token));
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

    return matches[0]?.mode ?? this.config.defaultCleanMode ?? this.cleanModes[0]?.mode ?? 0;
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
          mapId: 1,
          areaInfo: {
            locationInfo: {
              locationName: area.label,
            },
          },
        })),
        supportedMaps: [
          {
            mapId: 1,
            name: `${this.config.name} Map`,
          },
        ],
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
          const selectedAreas = request.newAreas ?? request.areas ?? [];
          const unknownAreas = selectedAreas.filter((areaId) => {
            return !this.serviceAreas.some((area) => area.areaId === areaId);
          });

          if (unknownAreas.length > 0) {
            throw new Error(`Unknown service area(s): ${unknownAreas.join(', ')}`);
          }

          this.selectedAreaIds = selectedAreas;
        },
        skipArea: async () => {
          this.selectedAreaIds = [];
        },
      },
    };
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
      throw new Error(`Failed to ${action}.`);
    }
  }
}
