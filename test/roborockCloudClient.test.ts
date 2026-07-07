import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoborockCloudConnection, RoborockCloudVacuumClient } from '../src/roborockCloudClient';
import { PLATFORM_NAME, type RoborockMatterConfig, type ServiceAreaConfig } from '../src/settings';

function log() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function connection(config: Partial<RoborockMatterConfig> = {}): any {
  return new RoborockCloudConnection(
    {
      platform: PLATFORM_NAME,
      username: 'user@example.com',
      ...config,
    } as RoborockMatterConfig,
    log() as any,
    '/tmp/homebridge-roborock-test',
  ) as any;
}

function room(area: Partial<ServiceAreaConfig> = {}): ServiceAreaConfig {
  return {
    areaId: 200017,
    label: 'Upstairs Room',
    kind: 'room',
    mapId: 2,
    roborockMapId: 2,
    segmentId: 17,
    ...area,
  };
}

describe('RoborockCloudConnection room cache', () => {
  it('uses fresh room cache before live discovery and rejects stale or forced cache', () => {
    const device = { duid: 'duid-1', name: 'Vacuum' };
    const fresh = {
      serviceAreas: [room()],
      serviceMaps: [{ mapId: 2, name: 'Upstairs' }],
      updatedAt: new Date().toISOString(),
    };
    const stale = {
      ...fresh,
      updatedAt: new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString(),
    };

    expect(connection().shouldUseCachedServiceAreas(device, fresh)).toBe(true);
    expect(connection().shouldUseCachedServiceAreas(device, stale)).toBe(false);
    expect(connection({ forceRoomRediscovery: true }).shouldUseCachedServiceAreas(device, fresh)).toBe(false);
    expect(connection({ roomDiscoveryCacheTtlHours: 0 }).shouldUseCachedServiceAreas(device, fresh)).toBe(false);
  });

  it('normalizes cached service areas and maps instead of trusting raw JSON shape', () => {
    const normalized = connection().normalizeCachedServiceAreaDiscovery({
      serviceAreas: [
        room({ label: ' Valid ' }),
        room({ areaId: 200017, label: 'Duplicate' }),
        { areaId: 'not-a-number', label: 'Invalid' },
        { areaId: 200018, label: '' },
      ],
      serviceMaps: [
        { mapId: 2, name: ' Upstairs ' },
        { mapId: 2, name: 'Duplicate' },
        { mapId: 'bad', name: 'Bad' },
      ],
      updatedAt: '2026-07-06T10:00:00.000Z',
    });

    expect(normalized).toEqual({
      serviceAreas: [room({ label: 'Valid' })],
      serviceMaps: [{ mapId: 2, name: 'Upstairs' }],
      updatedAt: '2026-07-06T10:00:00.000Z',
    });
  });
});

describe('RoborockCloudVacuumClient map-specific cleaning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for map confirmation before sending a room clean command', async () => {
    let activeMapId = 1;
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const client = vacuumClient(async (_duid, method, params) => {
      calls.push({ method, params });

      if (method === 'get_status') {
        return [{ state: 3, battery: 100, map_status: activeMapId << 2 }];
      }

      if (method === 'load_multi_map') {
        activeMapId = params[0] as number;
      }

      return {};
    });

    await client.cleanAreas([room()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.map((call) => call.method)).toContain('load_multi_map');
    expect(calls.map((call) => call.method)).not.toContain('app_segment_clean');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((call) => call.method)).not.toContain('app_segment_clean');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toContainEqual({
      method: 'app_segment_clean',
      params: [{ segments: [17], repeat: 1 }],
    });
  });

  it('does not send a room clean command when the requested map never confirms', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const client = vacuumClient(async (_duid, method, params) => {
      calls.push({ method, params });

      if (method === 'get_status') {
        return [{ state: 3, battery: 100, map_status: 1 << 2 }];
      }

      return {};
    });

    await client.cleanAreas([room()]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(calls.map((call) => call.method)).toContain('load_multi_map');
    expect(calls.map((call) => call.method)).not.toContain('app_segment_clean');
  });
});

function vacuumClient(sendRequest: (duid: string, method: string, params: unknown[]) => Promise<unknown>): RoborockCloudVacuumClient {
  return new RoborockCloudVacuumClient(
    {
      onDpsUpdate: vi.fn(() => vi.fn()),
      getRobotVersion: vi.fn(() => '1.0'),
      messageQueueHandler: {
        sendRequest,
      },
    } as any,
    {
      name: 'Vacuum',
      duid: 'duid-1',
    },
    log() as any,
    {
      waitForExclusive: vi.fn(async () => undefined),
    } as any,
  );
}
