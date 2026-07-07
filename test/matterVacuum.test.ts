import { describe, expect, it, vi } from 'vitest';
import { RoborockMatterVacuum } from '../src/matterVacuum';
import type { RoborockStatus, RoborockVacuumClient } from '../src/roborockClient';
import { PLATFORM_NAME, type RoborockMatterConfig, type RoborockVacuumConfig } from '../src/settings';

const RVC_OPERATIONAL_STATES = {
  Running: 1,
  Error: 3,
  Docked: 66,
} as const;

const BATTERY_CHARGE_STATE = {
  IsAtFullCharge: 2,
} as const;

function createVacuum(config: Partial<RoborockVacuumConfig> = {}): RoborockMatterVacuum {
  return new RoborockMatterVacuum(
    {
      matter: {
        deviceTypes: {
          RoboticVacuumCleaner: 0x74,
        },
        uuid: {
          generate: (value: string) => `uuid:${value}`,
        },
        updateAccessoryState: vi.fn(),
        updatePlatformAccessories: vi.fn(),
      },
    } as any,
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    {
      platform: PLATFORM_NAME,
    } as RoborockMatterConfig,
    {
      name: 'Roborock Test',
      duid: 'test-duid',
      ...config,
    },
    {
      getStatus: vi.fn(),
      start: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      dock: vi.fn(),
      locate: vi.fn(),
      setCleanMode: vi.fn(),
      cleanAreas: vi.fn(),
      destroy: vi.fn(),
    } as unknown as RoborockVacuumClient,
  );
}

function buildClusters(status?: RoborockStatus): any {
  return createVacuum().buildAccessory(status).clusters;
}

describe('RoborockMatterVacuum', () => {
  it('maps fully charged Roborock state 100 as docked and full', () => {
    const clusters = buildClusters({ state: 100, battery: 100, errorCode: 0 });

    expect(clusters.rvcOperationalState.operationalState).toBe(RVC_OPERATIONAL_STATES.Docked);
    expect(clusters.powerSource.batChargeState).toBe(BATTERY_CHARGE_STATE.IsAtFullCharge);
  });

  it('keeps returning-to-wash-mop state running', () => {
    const clusters = buildClusters({ state: 26, battery: 80, errorCode: 0 });

    expect(clusters.rvcRunMode.currentMode).toBe(1);
    expect(clusters.rvcOperationalState.operationalState).toBe(RVC_OPERATIONAL_STATES.Running);
  });

  it('maps Roborock error-like states without error codes to Matter error', () => {
    for (const state of [9, 12, 101]) {
      const clusters = buildClusters({ state, battery: 80, errorCode: 0 });

      expect(clusters.rvcOperationalState.operationalState).toBe(RVC_OPERATIONAL_STATES.Error);
      expect(clusters.rvcOperationalState.operationalError.errorStateId).not.toBe(0);
    }
  });

  it('drops duplicate or invalid advanced config before building Matter clusters', () => {
    const accessory = createVacuum({
      cleanModes: [
        { mode: 1, label: ' Balanced ', tag: 'vacuum', fanPower: 102 },
        { mode: 1, label: 'Duplicate', tag: 'vacuum', fanPower: 103 },
        { mode: 2, label: '', tag: 'vacuum' },
        { mode: 3, label: 'Bad Tag', tag: 'invalid' as any },
      ],
      defaultCleanMode: 42,
      serviceMaps: [{ mapId: 5, name: 'Main' }],
      serviceAreas: [
        { areaId: 1, label: ' Kitchen ', kind: 'room', mapId: 5, segmentId: 16 },
        { areaId: 1, label: 'Duplicate', kind: 'room', mapId: 5, segmentId: 17 },
        { areaId: 2, label: '', kind: 'room', mapId: 5, segmentId: 18 },
      ],
    }).buildAccessory({ state: 3, battery: 100, errorCode: 0 });

    expect(accessory.clusters.rvcCleanMode.currentMode).toBe(1);
    expect(accessory.clusters.rvcCleanMode.supportedModes).toEqual([
      {
        label: 'Balanced',
        mode: 1,
        modeTags: [{ value: 0x4001 }, { value: 0 }],
      },
    ]);
    expect(accessory.clusters.serviceArea.supportedAreas).toEqual([
      {
        areaId: 1,
        mapId: 5,
        areaInfo: {
          locationInfo: {
            locationName: 'Kitchen',
          },
        },
      },
    ]);
  });
});
