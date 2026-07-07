import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { APIEvent } from 'homebridge';
import path from 'node:path';
import { RoborockMatterVacuum } from './matterVacuum';
import type { RoborockStatus, RoborockVacuumClient } from './roborockClient';
import { RoborockCloudConnection } from './roborockCloudClient';
import { PLATFORM_NAME, PLUGIN_NAME, type RoborockMatterConfig, type RoborockVacuumConfig } from './settings';

type LegacyLocalVacuumConfig = RoborockVacuumConfig & {
  address?: string;
  connection?: string;
  miioId?: string;
  token?: string;
};

const REGISTRATION_RETRY_DELAYS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export class RoborockMatterPlatform implements DynamicPlatformPlugin {
  private readonly config: RoborockMatterConfig;
  private readonly cachedMatterAccessories = new Map<string, MatterAccessory>();
  private readonly vacuums = new Map<string, RoborockMatterVacuum>();
  private cloudConnection?: RoborockCloudConnection;
  private registrationRetryTimer?: NodeJS.Timeout;
  private registrationRetryAttempt = 0;
  private shutdownRequested = false;

  constructor(
    private readonly log: Logger,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.config = config as RoborockMatterConfig;

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.scheduleRegistrationAttempt(0));

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shutdownRequested = true;
      this.clearRegistrationRetry();
      for (const vacuum of this.vacuums.values()) {
        vacuum.destroy();
      }
      void this.cloudConnection?.destroy();
    });
  }

  public configureAccessory(_accessory: PlatformAccessory): void {
    // This plugin intentionally exposes Matter accessories only.
  }

  public configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedMatterAccessories.set(accessory.UUID, accessory);
  }

  private scheduleRegistrationAttempt(delayMs: number): void {
    this.clearRegistrationRetry();
    this.registrationRetryTimer = setTimeout(() => {
      this.registrationRetryTimer = undefined;
      void this.tryRegisterMatterVacuums();
    }, delayMs);
    this.registrationRetryTimer.unref();
  }

  private clearRegistrationRetry(): void {
    if (this.registrationRetryTimer) {
      clearTimeout(this.registrationRetryTimer);
      this.registrationRetryTimer = undefined;
    }
  }

  private async tryRegisterMatterVacuums(): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }

    try {
      await this.registerMatterVacuums();
      this.registrationRetryAttempt = 0;
    } catch (error) {
      const delayMs = REGISTRATION_RETRY_DELAYS_MS[Math.min(this.registrationRetryAttempt, REGISTRATION_RETRY_DELAYS_MS.length - 1)];
      this.registrationRetryAttempt++;

      if (this.registrationRetryAttempt === 1) {
        this.log.error(`Failed to register Matter Roborock vacuums: ${String(error)}`);
      } else {
        this.log.warn(`Roborock Matter registration still failing: ${String(error)}`);
      }

      this.log.info(`Retrying Roborock Matter registration in ${Math.round(delayMs / 1000)} seconds.`);
      this.scheduleRegistrationAttempt(delayMs);
    }
  }

  private async registerMatterVacuums(): Promise<void> {
    if (!this.api.isMatterAvailable()) {
      this.log.warn('Homebridge Matter support is not available. Use Homebridge 2.0 or newer.');
      return;
    }

    if (!this.api.isMatterEnabled()) {
      this.log.warn('Matter is not enabled for this bridge. Enable Matter on this bridge or child bridge to publish vacuums.');
      return;
    }

    if (!this.api.matter) {
      this.log.warn('Matter API is unavailable even though Matter is enabled.');
      return;
    }

    const vacuumRegistrations = await this.getVacuumRegistrations();

    if (vacuumRegistrations.length === 0) {
      this.log.warn('No Roborock vacuums found. Configure a Roborock account with at least one supported vacuum.');
      if (this.cloudConnection?.isStarted()) {
        await this.removeStaleMatterAccessories(new Set());
      }
      return;
    }

    const expectedUuids = new Set<string>();

    for (const { config: vacuumConfig, client } of vacuumRegistrations) {
      const vacuum = new RoborockMatterVacuum(this.api, this.log, this.config, vacuumConfig, client);
      expectedUuids.add(vacuum.UUID);
      const cachedAccessory = this.cachedMatterAccessories.get(vacuum.UUID);
      const cachedContext = (cachedAccessory as unknown as { context?: Record<string, unknown> } | undefined)?.context;
      vacuum.restoreSelectedAreaIds(cachedContext?.selectedAreaIds);

      let initialStatus: RoborockStatus | undefined;

      try {
        initialStatus = await client.getStatus();
      } catch (error) {
        this.log.warn(`Could not read initial state for ${vacuumConfig.name}; publishing with default stopped state. ${String(error)}`);
      }

      const accessory = vacuum.buildAccessory(initialStatus);

      if (cachedAccessory) {
        await this.api.matter.updatePlatformAccessories([accessory]);
        this.log.info(`Updated Matter Roborock vacuum: ${vacuumConfig.name}`);
      } else {
        await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered Matter Roborock vacuum: ${vacuumConfig.name}`);
      }

      vacuum.startPolling();
      this.vacuums.set(vacuum.UUID, vacuum);
    }

    await this.removeStaleMatterAccessories(expectedUuids);
  }

  private async removeStaleMatterAccessories(expectedUuids: Set<string>): Promise<void> {
    if (!this.api.matter) {
      return;
    }

    const staleAccessories = [...this.cachedMatterAccessories.values()].filter((accessory) => {
      return !expectedUuids.has(accessory.UUID);
    });

    if (staleAccessories.length > 0) {
      await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.cachedMatterAccessories.delete(accessory.UUID);
      }
      this.log.info(`Removed ${staleAccessories.length} stale Matter Roborock vacuum accessory record(s).`);
    }
  }

  private async getVacuumRegistrations(): Promise<Array<{
    config: RoborockVacuumConfig;
    client: RoborockVacuumClient;
  }>> {
    const registrations: Array<{
      config: RoborockVacuumConfig;
      client: RoborockVacuumClient;
    }> = [];

    this.warnAboutUnsupportedLocalConfig();

    if (this.config.username) {
      await this.cloudConnection?.destroy().catch((error) => {
        this.log.debug(`Could not stop previous Roborock cloud connection before retrying registration: ${String(error)}`);
      });
      this.cloudConnection = new RoborockCloudConnection(
        this.config,
        this.log,
        path.join(this.api.user.storagePath(), PLUGIN_NAME),
      );

      await this.cloudConnection.start();
      registrations.push(...await this.cloudConnection.getVacuumRegistrations());
    }

    return registrations;
  }

  private warnAboutUnsupportedLocalConfig(): void {
    const localEntries = ((this.config.vacuums ?? []) as LegacyLocalVacuumConfig[]).filter((vacuumConfig) => {
      return vacuumConfig.connection === 'local'
        || Boolean(vacuumConfig.token)
        || Boolean(vacuumConfig.address)
        || Boolean(vacuumConfig.miioId);
    });

    if (localEntries.length === 0) {
      return;
    }

    this.log.warn(
      `Ignoring ${localEntries.length} local miIO vacuum config entr${localEntries.length === 1 ? 'y' : 'ies'} because this beta build is cloud-only. `
      + 'Remove local IP/token settings and configure Roborock username/password instead.',
    );
  }
}
