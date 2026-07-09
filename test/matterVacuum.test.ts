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

function createVacuumFixture(config: Partial<RoborockVacuumConfig> = {}) {
  const matter = {
    deviceTypes: {
      RoboticVacuumCleaner: 0x74,
    },
    uuid: {
      generate: (value: string) => `uuid:${value}`,
    },
    updateAccessoryState: vi.fn(async () => undefined),
    updatePlatformAccessories: vi.fn(async () => undefined),
  };
  const client = {
    getStatus: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    dock: vi.fn(),
    locate: vi.fn(),
    setCleanMode: vi.fn(),
    cleanAreas: vi.fn(),
    destroy: vi.fn(),
  };
  const vacuum = new RoborockMatterVacuum(
    { matter } as any,
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
    client as unknown as RoborockVacuumClient,
  );

  return { client, matter, vacuum };
}

function createVacuum(config: Partial<RoborockVacuumConfig> = {}): RoborockMatterVacuum {
  return createVacuumFixture(config).vacuum;
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

  it('rejects unsupported run modes before sending a Roborock command', async () => {
    const { client, vacuum } = createVacuumFixture();
    const accessory = vacuum.buildAccessory({ state: 3, battery: 100, errorCode: 0 }) as any;

    await expect(accessory.handlers.rvcRunMode.changeToMode({ newMode: 2 })).rejects.toThrow('Unsupported run mode');
    expect(client.start).not.toHaveBeenCalled();
    expect(client.pause).not.toHaveBeenCalled();
    expect(client.cleanAreas).not.toHaveBeenCalled();
  });

  it('rejects room selections that span multiple Roborock maps', async () => {
    const { matter, vacuum } = createVacuumFixture({
      serviceMaps: [
        { mapId: 1, name: 'Downstairs' },
        { mapId: 2, name: 'Upstairs' },
      ],
      serviceAreas: [
        { areaId: 100_017, label: 'Kitchen', mapId: 1, segmentId: 17 },
        { areaId: 200_017, label: 'Bedroom', mapId: 2, segmentId: 17 },
      ],
    });
    vacuum.restoreSelectedAreaIds([100_017]);
    const accessory = vacuum.buildAccessory({ state: 3, battery: 100, errorCode: 0 }) as any;

    await expect(accessory.handlers.serviceArea.selectAreas({
      newAreas: [100_017, 200_017],
    })).rejects.toThrow('one Roborock map');
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();
    expect(accessory.context.selectedAreaIds).toEqual([100_017]);
  });

  it('removes only the requested room when Matter skips an area', async () => {
    const { matter, vacuum } = createVacuumFixture({
      serviceMaps: [{ mapId: 1, name: 'Downstairs' }],
      serviceAreas: [
        { areaId: 100_017, label: 'Kitchen', mapId: 1, segmentId: 17 },
        { areaId: 100_018, label: 'Office', mapId: 1, segmentId: 18 },
      ],
    });
    vacuum.restoreSelectedAreaIds([100_017, 100_018]);
    const accessory = vacuum.buildAccessory({ state: 3, battery: 100, errorCode: 0 }) as any;

    await accessory.handlers.serviceArea.skipArea({ skippedArea: 100_017 });

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      vacuum.UUID,
      'serviceArea',
      { selectedAreas: [100_018] },
    );
    expect(accessory.context.selectedAreaIds).toEqual([100_018]);
  });
});
