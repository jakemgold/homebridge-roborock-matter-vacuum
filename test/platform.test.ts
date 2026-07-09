import { describe, expect, it, vi } from 'vitest';
import { RoborockMatterPlatform } from '../src/platform';
import type { RoborockVacuumClient } from '../src/roborockClient';
import { PLATFORM_NAME, type RoborockMatterConfig, type RoborockVacuumConfig } from '../src/settings';

vi.mock('homebridge', () => ({
  APIEvent: {
    DID_FINISH_LAUNCHING: 'didFinishLaunching',
    SHUTDOWN: 'shutdown',
  },
}));

function client(): RoborockVacuumClient & {
  destroy: ReturnType<typeof vi.fn>;
  onStatusUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn(async () => ({ state: 3, battery: 100, errorCode: 0 })),
    start: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    dock: vi.fn(),
    locate: vi.fn(),
    setCleanMode: vi.fn(),
    cleanAreas: vi.fn(),
    onStatusUpdate: vi.fn(() => vi.fn()),
    destroy: vi.fn(),
  };
}

function vacuumConfig(name: string, duid: string): RoborockVacuumConfig {
  return { name, duid };
}

describe('RoborockMatterPlatform registration retries', () => {
  it('destroys staged clients and updates already-published accessories after a partial failure', async () => {
    const matter = {
      deviceTypes: { RoboticVacuumCleaner: 0x74 },
      uuid: { generate: (value: string) => `uuid:${value}` },
      updateAccessoryState: vi.fn(),
      updatePlatformAccessories: vi.fn(),
      registerPlatformAccessories: vi.fn(async () => undefined),
      unregisterPlatformAccessories: vi.fn(),
    };
    matter.registerPlatformAccessories
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second accessory failed'));

    const api = {
      isMatterAvailable: vi.fn(() => true),
      isMatterEnabled: vi.fn(() => true),
      matter,
      on: vi.fn(),
    };
    const platform = new RoborockMatterPlatform(
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      {
        platform: PLATFORM_NAME,
        username: 'user@example.com',
      } as RoborockMatterConfig,
      api as any,
    ) as any;

    const firstClients = [client(), client()];
    const secondClients = [client(), client()];
    vi.spyOn(platform, 'getVacuumRegistrations')
      .mockResolvedValueOnce([
        { config: vacuumConfig('Vacuum One', 'duid-1'), client: firstClients[0] },
        { config: vacuumConfig('Vacuum Two', 'duid-2'), client: firstClients[1] },
      ])
      .mockResolvedValueOnce([
        { config: vacuumConfig('Vacuum One', 'duid-1'), client: secondClients[0] },
        { config: vacuumConfig('Vacuum Two', 'duid-2'), client: secondClients[1] },
      ]);

    await expect(platform.registerMatterVacuums()).rejects.toThrow('second accessory failed');
    expect(firstClients[0].destroy).toHaveBeenCalledTimes(1);
    expect(firstClients[1].destroy).toHaveBeenCalledTimes(1);
    expect(firstClients[0].onStatusUpdate).not.toHaveBeenCalled();
    expect(firstClients[1].onStatusUpdate).not.toHaveBeenCalled();

    await platform.registerMatterVacuums();

    expect(matter.updatePlatformAccessories).toHaveBeenCalledTimes(1);
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(3);
    expect(secondClients[0].onStatusUpdate).toHaveBeenCalledTimes(1);
    expect(secondClients[1].onStatusUpdate).toHaveBeenCalledTimes(1);

    platform.destroyVacuums(platform.vacuums);
  });
});
