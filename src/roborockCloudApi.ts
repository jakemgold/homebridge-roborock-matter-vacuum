import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { buf as crc32Buffer } from 'crc-32';
import { formatRoborockError, RoborockRequestTimeoutError } from './roborockErrors';

export {
  formatRoborockError,
  isCloudAckTimeout,
  isRoborockRequestTimeoutError,
  ROBOROCK_REQUEST_TIMEOUT_ERROR_CODE,
  RoborockRequestTimeoutError,
} from './roborockErrors';

type RoborockLog = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type RoborockCloudDevice = {
  duid: string;
  name?: string;
  sn?: string;
  productId?: number | string;
  localKey?: string;
  online?: boolean;
  pv?: string;
  model?: string;
  productModel?: string;
  productCode?: string;
  modelId?: string;
  [key: string]: unknown;
};

type RoborockProduct = {
  id?: number | string;
  productId?: number | string;
  model?: string;
  productModel?: string;
  productCode?: string;
  modelId?: string;
  [key: string]: unknown;
};

type RoborockHomeRoom = {
  id?: number | string;
  name?: string;
};

type RoborockHomeData = {
  devices?: RoborockCloudDevice[];
  receivedDevices?: RoborockCloudDevice[];
  products?: RoborockProduct[];
  rooms?: RoborockHomeRoom[] | Record<string, RoborockHomeRoom>;
};

type RoborockRriot = {
  u: string;
  s: string;
  h: string;
  k: string;
  r: {
    a: string;
    m: string;
  };
};

type RoborockUserData = {
  token: string;
  rriot: RoborockRriot;
};

type PersistentState = {
  val?: unknown;
  ack?: boolean;
};

type LoginSignature = {
  k: string;
  s: string;
};

type LoginResult = {
  code?: number;
  msg?: string;
  data?: unknown;
};

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timeout: NodeJS.Timeout;
};

type ParsedMessage = {
  version: string;
  seq: number;
  random: number;
  timestamp: number;
  protocol: number;
  payload: Buffer;
};

type DecodedDps = Record<string, unknown> & {
  id?: unknown;
  msgId?: unknown;
  code?: unknown;
  error?: unknown;
  result?: unknown;
};

export type RoborockDpsUpdate = {
  duid: string;
  dps: DecodedDps;
};

type RoborockDpsListener = (update: RoborockDpsUpdate) => void;

type RoborockOptions = {
  username?: string;
  password?: string;
  baseURL?: string;
  language?: string;
  updateInterval?: number;
  storagePath?: string;
  skipDevices?: string[];
  ignoredDevices?: string[];
  log?: RoborockLog;
  userData?: unknown;
};

const API_V3_SIGN = 'api/v3/key/sign';
const API_V4_LOGIN_CODE = 'api/v4/auth/email/login/code';
const API_V4_LOGIN_PASSWORD = 'api/v4/auth/email/login/pwd';
const API_V4_EMAIL_CODE = 'api/v4/email/code/send';
const DEFAULT_BASE_URL = 'usiot.roborock.com';
const ROBOROCK_APP_VERSION = '4.54.02';
const REQUEST_TIMEOUT_MS = 10_000;
const PERSISTED_STATE_IDS = new Set(['UserData', 'clientID', 'HomeData']);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SALT = 'TXdfu$jyZ#TZHsg4';
const B01_SALT = '5wwh9ikChRjASpMU8cxg7o1d2E';

let sequence = 1;
let randomSeed = 4711;

export class RoborockCloudApi {
  public authState = {
    twoFactorRequired: false,
    statusMessage: '',
  };
  public roomIDs: Record<string, string> = {};
  public messageQueueHandler: RoborockMessageQueue;
  public rr_mqtt_connector: RoborockMqttConnector;

  private readonly config: RoborockOptions;
  public readonly log: RoborockLog;
  private readonly language: string;
  private readonly baseURL: string;
  private readonly updateInterval: number;
  private readonly ignoredDevices: string[];
  private readonly messageCodec: RoborockMessageCodec;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly dpsUpdateListeners = new Set<RoborockDpsListener>();
  private readonly states: Record<string, PersistentState | undefined> = {};
  private readonly persistedStateWrites = new Map<string, string>();

  private bInited = false;
  private loginApi?: AxiosInstance;
  private api?: AxiosInstance;
  private userData?: RoborockUserData;
  private pendingAuth?: LoginSignature;
  private persistBasePath?: string;
  private devices: RoborockCloudDevice[] = [];
  private products: RoborockProduct[] = [];
  private localKeys = new Map<string, string>();
  private requestId = 0;
  private homeDataRefreshInterval?: NodeJS.Timeout;

  constructor(options: RoborockOptions) {
    this.config = options;
    this.log = options.log ?? console;
    this.language = options.language ?? 'en';
    this.baseURL = normalizeBaseURL(options.baseURL);
    this.updateInterval = options.updateInterval ?? 180;
    this.ignoredDevices = [
      ...this.normalizeStringList(options.ignoredDevices),
      ...this.normalizeStringList(options.skipDevices),
    ];
    this.userData = isValidUserData(options.userData) ? options.userData : undefined;
    this.messageCodec = new RoborockMessageCodec(this);
    this.rr_mqtt_connector = new RoborockMqttConnector(this);
    this.messageQueueHandler = new RoborockMessageQueue(this);
  }

  public isInited(): boolean {
    return this.bInited;
  }

  public setDeviceNotify(_callback: (id: string, state: unknown) => void): void {
    // Kept for API compatibility with the previous adapter boundary.
  }

  public async startService(callback?: () => void): Promise<void> {
    if (this.bInited) {
      callback?.();
      return;
    }

    this.log.info('Starting Roborock cloud client.');

    const clientID = this.getOrCreateClientId();

    if (!this.config.username) {
      this.log.error('Roborock username is missing.');
      callback?.();
      return;
    }

    this.loginApi = createLoginApi({
      baseURL: this.baseURL,
      username: this.config.username,
      clientID,
      language: this.language,
    });

    let userData = await this.getUserData();
    if (!userData) {
      this.log.error('Login failed or requires 2FA. Please complete authentication in the Config UI.');
      callback?.();
      return;
    }

    try {
      await this.initializeSession(userData);
    } catch (error) {
      if (!this.isAuthFailure(error)) {
        throw error;
      }

      this.log.warn('Cached Roborock session was rejected by the cloud API; clearing it and retrying login once.');
      this.clearCachedSession();
      userData = await this.getUserData();
      if (!userData) {
        this.log.error('Roborock session expired and no replacement session could be created. Add the password temporarily, restart Homebridge, then remove it after login succeeds.');
        callback?.();
        return;
      }

      await this.initializeSession(userData);
    }

    this.bInited = true;
    this.log.info('Roborock cloud client is ready.');
    callback?.();

    if (this.updateInterval > 0) {
      this.scheduleHomeDataRefresh(userData);
    }
  }

  public async stopService(): Promise<void> {
    if (this.homeDataRefreshInterval) {
      clearInterval(this.homeDataRefreshInterval);
      this.homeDataRefreshInterval = undefined;
    }

    for (const [requestId, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Roborock cloud client stopped before the request completed.'));
      this.pendingRequests.delete(requestId);
    }

    await this.rr_mqtt_connector.disconnect();
    this.bInited = false;
  }

  private async initializeSession(userData: RoborockUserData): Promise<void> {
    if (!this.loginApi) {
      throw new Error('Login API is not initialized.');
    }

    this.setAuthorizationHeader(this.loginApi, userData.token);
    this.api = this.createCloudApi(userData.rriot);

    await this.refreshHomeData(userData);
    await this.rr_mqtt_connector.connect(userData);
  }

  public getVacuumList(): RoborockCloudDevice[] {
    const stored = this.getStoredHomeData();
    return this.getAllHomeDevices(stored).filter((device) => !this.shouldSkipDevice(device));
  }

  public async refreshHomeDataNow(): Promise<void> {
    if (!this.userData) {
      throw new Error('Roborock user data is not available for home data refresh.');
    }

    await this.refreshHomeData(this.userData);
  }

  public onDpsUpdate(listener: RoborockDpsListener): () => void {
    this.dpsUpdateListeners.add(listener);

    return () => {
      this.dpsUpdateListeners.delete(listener);
    };
  }

  public notifyDpsUpdate(update: RoborockDpsUpdate): void {
    for (const listener of this.dpsUpdateListeners) {
      listener(update);
    }
  }

  public getProductAttribute(duid: string, attribute: string): string | number | null {
    const device = this.getAllHomeDevices().find((entry) => entry.duid === duid);
    const deviceValue = this.getObjectAttribute(device, attribute);
    if (deviceValue !== null) {
      return deviceValue;
    }

    const productId = device?.productId;
    const product = this.getKnownProducts().find((entry) => {
      return entry.id === productId || entry.productId === productId;
    });

    return this.getObjectAttribute(product, attribute);
  }

  public getVacuumDeviceStatus(_duid: string, _property: string): unknown {
    return undefined;
  }

  public isSupportedVacuumModel(model: unknown): boolean {
    return typeof model === 'string' && model.startsWith('roborock.vacuum.');
  }

  public async sendTwoFactorEmail(): Promise<{ ok: boolean }> {
    if (!this.loginApi) {
      throw new Error('Login API is not initialized.');
    }

    if (!this.config.username) {
      throw new Error('Roborock username is missing.');
    }

    await requestEmailCode(this.loginApi, this.config.username);
    this.authState.twoFactorRequired = true;
    this.authState.statusMessage = 'Verification email sent.';
    return { ok: true };
  }

  public async verifyTwoFactorCode(code: string): Promise<RoborockUserData> {
    if (!this.loginApi) {
      throw new Error('Login API is not initialized.');
    }

    if (!this.config.username) {
      throw new Error('Roborock username is missing.');
    }

    const signData = await this.ensureAuthSignature();
    const region = getRegionConfig(this.baseURL);
    const loginResult = await loginWithCode(this.loginApi, {
      email: this.config.username,
      code,
      country: region.country,
      countryCode: region.countryCode,
      k: signData.k,
      s: signData.s,
    });

    if (loginResult.code === 200 && isValidUserData(loginResult.data)) {
      this.userData = loginResult.data;
      this.pendingAuth = undefined;
      this.setStateAsync('UserData', {
        val: JSON.stringify(this.userData),
        ack: true,
      });
      this.authState.twoFactorRequired = false;
      this.authState.statusMessage = 'Two-factor authentication completed.';
      return this.userData;
    }

    throw new Error(`2FA verification failed: ${formatLoginFailure(loginResult)}`);
  }

  public getRequestId(): number {
    this.requestId = (this.requestId + 1) % 10_000;
    return this.requestId;
  }

  public getRobotVersion(duid: string): string {
    const device = this.getAllHomeDevices().find((entry) => entry.duid === duid);
    return typeof device?.pv === 'string' && device.pv.length > 0 ? device.pv : '1.0';
  }

  public getLocalKey(duid: string): string | undefined {
    return this.localKeys.get(duid);
  }

  public isDeviceOnline(duid: string): boolean {
    const device = this.getAllHomeDevices().find((entry) => entry.duid === duid);
    return device?.online !== false;
  }

  public buildPayload(duid: string, protocol: number, messageID: number, method: string, params: unknown[]): string {
    return this.messageCodec.buildPayload(duid, protocol, messageID, method, params);
  }

  public buildMessage(duid: string, protocol: number, timestamp: number, payload: string): Buffer {
    return this.messageCodec.buildMessage(duid, protocol, timestamp, payload);
  }

  public decodeMessage(message: Buffer, duid: string): ParsedMessage | null {
    return this.messageCodec.decodeMessage(message, duid);
  }

  public addPendingRequest(id: number, request: PendingRequest): void {
    this.pendingRequests.set(id, request);
  }

  public takePendingRequest(id: number): PendingRequest | undefined {
    const request = this.pendingRequests.get(id);
    if (request) {
      this.pendingRequests.delete(id);
    }

    return request;
  }

  private async getUserData(): Promise<RoborockUserData | null> {
    if (isValidUserData(this.userData)) {
      this.log.info('Using Roborock session from memory.');
      return this.userData;
    }

    const cachedState = this.getStateAsync('UserData');
    const cachedValue = this.parseStateJson(cachedState);
    if (isValidUserData(cachedValue)) {
      this.userData = cachedValue;
      this.log.info('Using cached Roborock session from disk.');
      return cachedValue;
    }

    if (!this.config.password) {
      this.log.error('Roborock password is missing and no cached session is available.');
      return null;
    }

    if (!this.loginApi || !this.config.username) {
      throw new Error('Login API is not initialized.');
    }

    const signData = await this.ensureAuthSignature();
    const loginResult = await loginByPassword(this.loginApi, {
      email: this.config.username,
      password: this.config.password,
      k: signData.k,
      s: signData.s,
    });

    if (loginResult.code === 200 && isValidUserData(loginResult.data)) {
      this.userData = loginResult.data;
      this.pendingAuth = undefined;
      this.setStateAsync('UserData', {
        val: JSON.stringify(this.userData),
        ack: true,
      });
      this.authState.twoFactorRequired = false;
      this.authState.statusMessage = '';
      return this.userData;
    }

    if (loginResult.code === 2031) {
      this.authState.twoFactorRequired = true;
      this.authState.statusMessage = 'Two-factor authentication required.';
      this.log.error('Two-factor authentication required. Use the Config UI to continue.');
      return null;
    }

    this.deleteStateAsync('HomeData');
    this.deleteStateAsync('UserData');
    throw new Error(`Roborock login failed: ${formatLoginFailure(loginResult)}`);
  }

  private clearCachedSession(): void {
    this.userData = undefined;
    this.api = undefined;
    if (this.loginApi) {
      const commonHeaders = this.loginApi.defaults.headers.common as Record<string, string | undefined>;
      delete commonHeaders.Authorization;
    }
    this.deleteStateAsync('HomeData');
    this.deleteStateAsync('UserData');
  }

  private isAuthFailure(error: unknown): boolean {
    return axios.isAxiosError(error)
      && (error.response?.status === 401 || error.response?.status === 403);
  }

  private async ensureAuthSignature(): Promise<LoginSignature> {
    if (this.pendingAuth) {
      return this.pendingAuth;
    }

    if (!this.loginApi) {
      throw new Error('Login API is not initialized.');
    }

    const s = crypto
      .randomBytes(12)
      .toString('base64')
      .substring(0, 16)
      .replace(/\+/g, 'X')
      .replace(/\//g, 'Y');
    const signData = await signRequest(this.loginApi, s);

    if (!isRecord(signData) || typeof signData.k !== 'string') {
      throw new Error('Failed to obtain Roborock login signature.');
    }

    this.pendingAuth = { k: signData.k, s };
    return this.pendingAuth;
  }

  private createCloudApi(rriot: RoborockRriot): AxiosInstance {
    const api = axios.create({ baseURL: rriot.r.a });

    api.interceptors.request.use((config) => {
      this.applyHawkAuthorization(config, api, rriot);
      return config;
    });

    return api;
  }

  private applyHawkAuthorization(config: InternalAxiosRequestConfig, api: AxiosInstance, rriot: RoborockRriot): void {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto
      .randomBytes(6)
      .toString('base64')
      .substring(0, 6)
      .replace(/\+/g, 'X')
      .replace(/\//g, 'Y');
    const url = new URL(api.getUri(config));
    const prestr = [
      rriot.u,
      rriot.s,
      nonce,
      timestamp,
      md5hex(url.pathname),
      '',
      '',
    ].join(':');
    const mac = crypto.createHmac('sha256', rriot.h).update(prestr).digest('base64');
    const authorization = `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
    const headers = config.headers as unknown as Record<string, string>;
    headers.Authorization = authorization;
  }

  private async refreshHomeData(userData: RoborockUserData): Promise<void> {
    if (!this.loginApi || !this.api) {
      throw new Error('Roborock APIs are not initialized.');
    }

    const homeDetail = await this.loginApi.get('api/v1/getHomeDetail');
    const homeId = this.extractHomeId(homeDetail.data);
    if (!homeId) {
      throw new Error('Roborock home ID was not returned by the cloud API.');
    }

    const homeDataResponse = await this.api.get(`v2/user/homes/${homeId}`);
    const homeData = this.extractHomeData(homeDataResponse.data);
    this.setStateAsync('HomeData', {
      val: JSON.stringify(homeData),
      ack: true,
    });

    const devices = this.getAllHomeDevices(homeData).filter((device) => !this.shouldSkipDevice(device));
    this.products = this.normalizeArray(homeData.products).filter(isRoborockProduct);
    this.devices = devices;
    this.localKeys = new Map(
      devices
        .filter((device): device is RoborockCloudDevice & { localKey: string } => {
          return typeof device.localKey === 'string' && device.localKey.length > 0;
        })
        .map((device) => [device.duid, device.localKey]),
    );
    this.roomIDs = this.buildRoomLookup(homeData.rooms);

    // Keep userData referenced so refreshes stay tied to the same authenticated session.
    this.userData = userData;
  }

  private scheduleHomeDataRefresh(userData: RoborockUserData): void {
    if (this.homeDataRefreshInterval) {
      clearInterval(this.homeDataRefreshInterval);
    }

    const interval = Math.max(this.updateInterval, 60) * 1000;
    this.homeDataRefreshInterval = setInterval(() => {
      this.refreshHomeData(userData).catch((error) => {
        this.log.debug(`Roborock home data refresh failed: ${formatRoborockError(error)}`);
      });
    }, interval);
    this.homeDataRefreshInterval.unref();
  }

  private extractHomeId(payload: unknown): string | number | null {
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root.data) ? root.data : {};
    const homeId = data.rrHomeId ?? data.homeId;
    return typeof homeId === 'string' || typeof homeId === 'number' ? homeId : null;
  }

  private extractHomeData(payload: unknown): RoborockHomeData {
    const root = isRecord(payload) ? payload : {};
    const result = isRecord(root.result) ? root.result : {};

    return {
      devices: this.normalizeArray(result.devices).filter(isRoborockCloudDevice),
      receivedDevices: this.normalizeArray(result.receivedDevices).filter(isRoborockCloudDevice),
      products: this.normalizeArray(result.products).filter(isRoborockProduct),
      rooms: this.normalizeRooms(result.rooms),
    };
  }

  private buildRoomLookup(rooms: RoborockHomeData['rooms']): Record<string, string> {
    const lookup: Record<string, string> = {};
    const entries = Array.isArray(rooms) ? rooms : Object.values(rooms ?? {});

    for (const room of entries) {
      if (!room) {
        continue;
      }

      const id = room.id;
      const name = room.name;

      if ((typeof id === 'string' || typeof id === 'number') && typeof name === 'string' && name.length > 0) {
        lookup[String(id)] = name;
      }
    }

    return lookup;
  }

  private getStoredHomeData(): RoborockHomeData | null {
    const homeData = this.getStateAsync('HomeData');
    return this.parseStateJson(homeData) as RoborockHomeData | null;
  }

  private getAllHomeDevices(homeData = this.getStoredHomeData()): RoborockCloudDevice[] {
    if (!homeData) {
      return this.devices;
    }

    return [
      ...this.normalizeArray(homeData.devices).filter(isRoborockCloudDevice),
      ...this.normalizeArray(homeData.receivedDevices).filter(isRoborockCloudDevice),
    ];
  }

  private getKnownProducts(): RoborockProduct[] {
    const stored = this.getStoredHomeData();
    return stored?.products ?? this.products;
  }

  private getObjectAttribute(value: unknown, attribute: string): string | number | null {
    if (!isRecord(value)) {
      return null;
    }

    const keys = attribute === 'model'
      ? ['model', 'productModel', 'productCode', 'modelId']
      : [attribute];

    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }

      if (typeof candidate === 'number') {
        return candidate;
      }
    }

    return null;
  }

  private shouldSkipDevice(device: RoborockCloudDevice): boolean {
    return [device.duid, device.sn]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .some((value) => this.ignoredDevices.includes(value));
  }

  private normalizeStringList(value?: string[]): string[] {
    return (value ?? [])
      .map((entry) => `${entry}`.trim())
      .filter((entry) => entry.length > 0);
  }

  private normalizeArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private normalizeRooms(value: unknown): RoborockHomeData['rooms'] {
    if (Array.isArray(value)) {
      return value.filter(isRoborockRoom);
    }

    if (!isRecord(value)) {
      return [];
    }

    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, RoborockHomeRoom] => isRoborockRoom(entry[1])),
    );
  }

  private getOrCreateClientId(): string {
    const stored = this.getStateAsync('clientID');
    if (typeof stored?.val === 'string' && stored.val.length > 0) {
      return stored.val;
    }

    const clientID = crypto.randomUUID();
    this.setStateAsync('clientID', { val: clientID, ack: true });
    return clientID;
  }

  private getStateAsync(id: string): PersistentState | null {
    if (!PERSISTED_STATE_IDS.has(id)) {
      return this.states[id] ?? null;
    }

    const persistPath = this.getPersistPath(id);
    try {
      if (!fs.existsSync(persistPath)) {
        return null;
      }

      const raw = fs.readFileSync(persistPath, 'utf8');
      this.persistedStateWrites.set(id, raw);
      return JSON.parse(raw) as PersistentState;
    } catch (error) {
      this.log.debug(`Could not read Roborock state ${id}: ${formatRoborockError(error)}`);
      return null;
    }
  }

  private setStateAsync(id: string, state: PersistentState): void {
    this.states[id] = state;

    if (!PERSISTED_STATE_IDS.has(id)) {
      return;
    }

    const persistPath = this.getPersistPath(id);
    const serialized = JSON.stringify(state, null, 2);
    if (this.persistedStateWrites.get(id) === serialized) {
      return;
    }

    fs.mkdirSync(path.dirname(persistPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.writeFileSync(persistPath, serialized, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
    });
    this.persistedStateWrites.set(id, serialized);
    this.restrictFilePermissions(persistPath);
  }

  private deleteStateAsync(id: string): void {
    delete this.states[id];

    if (!PERSISTED_STATE_IDS.has(id)) {
      return;
    }

    const persistPath = this.getPersistPath(id);
    this.persistedStateWrites.delete(id);
    if (fs.existsSync(persistPath)) {
      fs.unlinkSync(persistPath);
    }
  }

  private parseStateJson(state: PersistentState | null): unknown {
    if (!state || typeof state.val !== 'string') {
      return null;
    }

    try {
      return JSON.parse(state.val);
    } catch {
      return null;
    }
  }

  private getPersistPath(id: string): string {
    return path.join(this.resolvePersistBasePath(), `roborock.${id}`);
  }

  private resolvePersistBasePath(): string {
    if (this.persistBasePath) {
      return this.persistBasePath;
    }

    const candidates = [
      this.config.storagePath,
      process.env.HOMEBRIDGE_STORAGE_PATH,
      path.join(os.tmpdir(), 'homebridge-roborock-matter-vacuum'),
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    for (const candidate of candidates) {
      try {
        const resolved = path.resolve(candidate);
        fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        fs.accessSync(resolved, fs.constants.W_OK);
        this.persistBasePath = resolved;
        return resolved;
      } catch (error) {
        this.log.debug(`Roborock persist path '${candidate}' is not writable: ${formatRoborockError(error)}`);
      }
    }

    const fallback = path.join(os.tmpdir(), 'homebridge-roborock-matter-vacuum');
    fs.mkdirSync(fallback, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    this.persistBasePath = fallback;
    return fallback;
  }

  private restrictFilePermissions(filePath: string): void {
    try {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch (error) {
      this.log.debug(`Could not restrict Roborock persisted state permissions: ${formatRoborockError(error)}`);
    }
  }

  private setAuthorizationHeader(api: AxiosInstance, token: string): void {
    const commonHeaders = api.defaults.headers.common as Record<string, string>;
    commonHeaders.Authorization = token;
  }
}

class RoborockMessageQueue {
  constructor(private readonly api: RoborockCloudApi) {}

  public async sendRequest(duid: string, method: string, params: unknown[]): Promise<unknown> {
    if (!this.api.isDeviceOnline(duid)) {
      throw new Error('Roborock reports the vacuum is offline.');
    }

    if (!this.api.rr_mqtt_connector.isConnected()) {
      throw new Error('Roborock cloud MQTT connection is unavailable.');
    }

    const messageID = this.api.getRequestId();
    const timestamp = Math.floor(Date.now() / 1000);
    const protocol = 101;
    const payload = this.api.buildPayload(duid, protocol, messageID, method, params);
    const message = this.api.buildMessage(duid, protocol, timestamp, payload);

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.api.takePendingRequest(messageID);
        reject(new RoborockRequestTimeoutError(messageID, method, this.api.rr_mqtt_connector.isConnected(), REQUEST_TIMEOUT_MS));
      }, REQUEST_TIMEOUT_MS);

      this.api.addPendingRequest(messageID, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        this.api.rr_mqtt_connector.sendMessage(duid, message);
      } catch (error) {
        clearTimeout(timeout);
        this.api.takePendingRequest(messageID);
        reject(error instanceof Error ? error : new Error(formatRoborockError(error)));
      }
    });
  }
}

class RoborockMqttConnector {
  private client?: MqttClient;
  private connected = false;
  private endpoint = '';
  private mqttUser = '';
  private userData?: RoborockUserData;

  constructor(private readonly api: RoborockCloudApi) {}

  public async connect(userData: RoborockUserData): Promise<void> {
    this.userData = userData;
    this.endpoint = md5bin(userData.rriot.k).subarray(8, 14).toString('base64');
    this.mqttUser = md5hex(`${userData.rriot.u}:${userData.rriot.k}`).substring(2, 10);
    const mqttPassword = md5hex(`${userData.rriot.s}:${userData.rriot.k}`).substring(16);

    await this.disconnect();

    this.client = mqtt.connect(userData.rriot.r.m, {
      clientId: this.mqttUser,
      username: this.mqttUser,
      password: mqttPassword,
      keepalive: 30,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.subscribe();
      this.api.log.debug('Roborock MQTT connection connected.');
    });
    this.client.on('reconnect', () => {
      this.connected = false;
      this.api.log.debug('Roborock MQTT connection reconnecting.');
    });
    this.client.on('close', () => {
      this.connected = false;
      this.api.log.debug('Roborock MQTT connection closed.');
    });
    this.client.on('offline', () => {
      this.connected = false;
      this.api.log.debug('Roborock MQTT connection offline.');
    });
    this.client.on('error', (error) => {
      this.connected = false;
      this.api.log.warn(`Roborock MQTT connection error: ${formatRoborockError(error)}`);
    });
    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message);
    });
  }

  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;

    if (!client) {
      return;
    }

    await new Promise<void>((resolve) => {
      client.end(true, {}, () => resolve());
    });
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getEndpoint(): string {
    return this.endpoint;
  }

  public sendMessage(duid: string, message: Buffer): void {
    if (!this.client || !this.userData) {
      throw new Error('Roborock MQTT client is not initialized.');
    }

    const topic = `rr/m/i/${this.userData.rriot.u}/${this.mqttUser}/${duid}`;
    this.client.publish(topic, message, { qos: 1 });
  }

  private subscribe(): void {
    if (!this.client || !this.userData) {
      return;
    }

    const topic = `rr/m/o/${this.userData.rriot.u}/${this.mqttUser}/#`;
    this.client.subscribe(topic, { qos: 1 }, (error) => {
      if (error) {
        this.api.log.warn(`Failed to subscribe to Roborock MQTT topic: ${formatRoborockError(error)}`);
      }
    });
  }

  private handleMessage(topic: string, message: Buffer): void {
    try {
      const duid = this.resolveDuidFromTopic(topic);
      if (!duid) {
        this.api.log.debug('Skipping Roborock MQTT message with an unmatched topic.');
        return;
      }

      const decoded = this.api.decodeMessage(message, duid);
      if (!decoded) {
        return;
      }

      if (decoded.protocol !== 102) {
        return;
      }

      const dps = this.parseDps(decoded.payload);
      if (!dps) {
        return;
      }

      const id = this.normalizeMessageId(dps.id ?? dps.msgId);
      if (id === undefined) {
        this.api.notifyDpsUpdate({ duid, dps });
        return;
      }

      const pending = this.api.takePendingRequest(id);
      if (!pending) {
        this.api.log.debug(`Received Roborock cloud response for unknown request id ${id}.`);
        return;
      }

      clearTimeout(pending.timeout);

      if (dps.code !== undefined || dps.error !== undefined) {
        pending.reject(new Error(`Roborock request ${id} (${pending.method}) failed: ${this.formatDpsError(dps)}`));
        return;
      }

      pending.resolve(dps.result);
    } catch (error) {
      this.api.log.warn(`Failed to process Roborock MQTT message: ${formatRoborockError(error)}`);
    }
  }

  private parseDps(payload: Buffer): DecodedDps | null {
    const parsed = JSON.parse(payload.toString('utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.dps)) {
      return null;
    }

    const dps = parsed.dps;
    const candidates = [
      dps['102'],
      dps['10001'],
      dps['10000'],
      dps,
    ];

    for (const candidate of candidates) {
      const value = typeof candidate === 'string' ? JSON.parse(candidate) as unknown : candidate;
      if (isRecord(value)) {
        return value;
      }
    }

    return null;
  }

  private formatDpsError(dps: DecodedDps): string {
    const details = [
      dps.code === undefined ? undefined : `code=${formatRoborockError(dps.code, 'unknown')}`,
      dps.error === undefined ? undefined : `error=${formatRoborockError(dps.error, 'unknown')}`,
    ].filter((detail): detail is string => detail !== undefined);

    return details.length > 0 ? details.join(', ') : 'unknown device error';
  }

  private normalizeMessageId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private resolveDuidFromTopic(topic: string): string | null {
    const segments = topic.split('/').filter((segment) => segment.length > 0);
    const tail = segments[segments.length - 1];
    if (!tail) {
      return null;
    }

    if (this.api.getLocalKey(tail)) {
      return tail;
    }

    for (let index = segments.length - 2; index >= 0; index--) {
      if (this.api.getLocalKey(segments[index])) {
        return segments[index];
      }
    }

    return tail;
  }
}

class RoborockMessageCodec {
  private readonly missingLocalKeyWarnings = new Set<string>();

  constructor(private readonly api: RoborockCloudApi) {}

  public buildPayload(duid: string, protocol: number, messageID: number, method: string, params: unknown[]): string {
    const version = this.api.getRobotVersion(duid);
    const timestamp = Math.floor(Date.now() / 1000);
    const inner: Record<string, unknown> = {
      id: messageID,
      method,
      params,
    };

    if (version === 'B01' || version === '\x81S\x19') {
      inner.msgId = String(messageID);

      if (method === 'get_prop') {
        inner.method = 'prop.get';
        inner.params = { property: params };
      }

      return JSON.stringify({
        dps: {
          10000: inner,
        },
        t: timestamp,
      });
    }

    return JSON.stringify({
      dps: {
        [protocol]: JSON.stringify(inner),
      },
      t: timestamp,
    });
  }

  public buildMessage(duid: string, protocol: number, timestamp: number, payload: string): Buffer {
    const version = this.api.getRobotVersion(duid);
    const currentSeq = sequence >>> 0;
    const currentRandom = randomSeed >>> 0;
    const encrypted = this.encryptPayload(duid, version, currentRandom, timestamp, payload);
    const message = Buffer.alloc(23 + encrypted.length);

    message.write(version, 0, 3, 'latin1');
    message.writeUInt32BE(currentSeq, 3);
    message.writeUInt32BE(currentRandom, 7);
    message.writeUInt32BE(timestamp >>> 0, 11);
    message.writeUInt16BE(protocol, 15);
    message.writeUInt16BE(encrypted.length, 17);
    encrypted.copy(message, 19);
    message.writeUInt32BE(crc32Buffer(message.subarray(0, message.length - 4)) >>> 0, message.length - 4);

    sequence++;
    randomSeed++;

    return message;
  }

  public decodeMessage(message: Buffer, duid: string): ParsedMessage | null {
    try {
      const version = message.toString('latin1', 0, 3);
      if (!this.isSupportedProtocolVersion(version)) {
        throw new Error(`Unknown protocol version ${version}`);
      }

      const actualCrc32 = crc32Buffer(message.subarray(0, message.length - 4)) >>> 0;
      const expectedCrc32 = message.readUInt32BE(message.length - 4);
      if (actualCrc32 !== expectedCrc32) {
        throw new Error(`Wrong CRC32 ${actualCrc32}, expected ${expectedCrc32}`);
      }

      const parsed: ParsedMessage = {
        version,
        seq: message.readUInt32BE(3),
        random: message.readUInt32BE(7),
        timestamp: message.readUInt32BE(11),
        protocol: message.readUInt16BE(15),
        payload: message.subarray(19, 19 + message.readUInt16BE(17)),
      };

      parsed.payload = this.decryptPayload(duid, parsed);
      return parsed;
    } catch (error) {
      if (!this.missingLocalKeyWarnings.has(duid)) {
        this.missingLocalKeyWarnings.add(duid);
        this.api.log.debug(`Could not decode Roborock MQTT message for ${maskIdentifier(duid)}: ${formatRoborockError(error)}`);
      }
      return null;
    }
  }

  private encryptPayload(duid: string, version: string, random: number, timestamp: number, payload: string): Buffer {
    const localKey = this.getRequiredLocalKey(duid);
    const payloadBuffer = Buffer.from(payload, 'utf8');

    if (version === '1.0') {
      const aesKey = md5bin(this.encodeTimestamp(timestamp) + localKey + SALT);
      const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
      return Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
    }

    if (version === 'A01') {
      const iv = md5hex(random.toString(16).padStart(8, '0') + '726f626f726f636b2d67a6d6da').substring(8, 24);
      const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(localKey, 'utf8'), Buffer.from(iv, 'utf8'));
      return Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
    }

    if (version === 'B01' || version === '\x81S\x19') {
      const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(localKey, 'utf8'), this.deriveB01Iv(random));
      return Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
    }

    throw new Error(`Roborock protocol ${version} is not supported by the minimal cloud client.`);
  }

  private decryptPayload(duid: string, message: ParsedMessage): Buffer {
    const localKey = this.getRequiredLocalKey(duid);

    if (message.version === '1.0') {
      const aesKey = md5bin(this.encodeTimestamp(message.timestamp) + localKey + SALT);
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null);
      return Buffer.concat([decipher.update(message.payload), decipher.final()]);
    }

    if (message.version === 'A01') {
      const iv = md5hex(message.random.toString(16).padStart(8, '0') + '726f626f726f636b2d67a6d6da').substring(8, 24);
      const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(localKey, 'utf8'), Buffer.from(iv, 'utf8'));
      return Buffer.concat([decipher.update(message.payload), decipher.final()]);
    }

    if (message.version === 'B01' || message.version === '\x81S\x19') {
      const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(localKey, 'utf8'), this.deriveB01Iv(message.random));
      return Buffer.concat([decipher.update(message.payload), decipher.final()]);
    }

    throw new Error(`Roborock protocol ${message.version} is not supported by the minimal cloud client.`);
  }

  private isSupportedProtocolVersion(version: string): boolean {
    return version === '1.0' || version === 'A01' || version === 'B01' || version === '\x81S\x19';
  }

  private getRequiredLocalKey(duid: string): string {
    const localKey = this.api.getLocalKey(duid);
    if (localKey) {
      return localKey;
    }

    throw new Error(`No localKey found for device ${maskIdentifier(duid)}`);
  }

  private encodeTimestamp(timestamp: number): string {
    const hex = timestamp.toString(16).padStart(8, '0').split('');
    return [5, 6, 3, 7, 1, 2, 0, 4].map((index) => hex[index]).join('');
  }

  private deriveB01Iv(random: number): Buffer {
    const randomBuffer = Buffer.alloc(4);
    randomBuffer.writeUInt32BE(random >>> 0, 0);
    const iv = md5hex(randomBuffer.toString('hex').toLowerCase() + B01_SALT).substring(9, 25);
    return Buffer.from(iv, 'utf8');
  }
}

function createLoginApi(options: { baseURL: string; username: string; clientID: string; language: string }): AxiosInstance {
  return axios.create({
    baseURL: `https://${normalizeBaseURL(options.baseURL)}`,
    headers: {
      header_clientid: crypto.createHash('md5').update(options.username).update(options.clientID).digest().toString('base64'),
      header_clientlang: options.language,
      header_appversion: ROBOROCK_APP_VERSION,
      header_phonemodel: 'Pixel 7',
      header_phonesystem: 'Android',
    },
  });
}

async function signRequest(loginApi: AxiosInstance, s: string): Promise<unknown> {
  const response = await loginApi.post(`${API_V3_SIGN}?s=${s}`);
  return isRecord(response.data) ? response.data.data : null;
}

async function requestEmailCode(loginApi: AxiosInstance, email: string): Promise<unknown> {
  const params = new URLSearchParams();
  params.append('type', 'login');
  params.append('email', email);
  params.append('platform', '');

  const response = await loginApi.post(API_V4_EMAIL_CODE, params.toString());
  if (isRecord(response.data) && response.data.code !== 200) {
    throw new Error(
      `Send code failed: ${formatRoborockError(response.data.msg, 'Unknown error')} `
      + `(Code: ${formatRoborockError(response.data.code, 'unknown')})`,
    );
  }

  return response.data;
}

async function loginByPassword(
  loginApi: AxiosInstance,
  options: { email: string; password: string; k: string; s: string },
): Promise<LoginResult> {
  const params = new URLSearchParams({
    email: options.email,
    password: encryptPassword(options.password, options.k),
    majorVersion: '14',
    minorVersion: '0',
  });

  return postLogin(loginApi, API_V4_LOGIN_PASSWORD, params, options.k, options.s);
}

async function loginWithCode(
  loginApi: AxiosInstance,
  options: { email: string; code: string; country: string; countryCode: string; k: string; s: string },
): Promise<LoginResult> {
  const params = new URLSearchParams({
    country: options.country,
    countryCode: options.countryCode,
    email: options.email,
    code: options.code,
    majorVersion: '14',
    minorVersion: '0',
  });

  return postLogin(loginApi, API_V4_LOGIN_CODE, params, options.k, options.s);
}

async function postLogin(loginApi: AxiosInstance, url: string, params: URLSearchParams, k: string, s: string): Promise<LoginResult> {
  try {
    const response = await loginApi.post(url, params.toString(), {
      headers: {
        'x-mercy-k': k,
        'x-mercy-ks': s,
      },
    });
    return isRecord(response.data) ? response.data : {};
  } catch (error) {
    const responseData = axios.isAxiosError(error) ? error.response?.data : undefined;
    if (isRecord(responseData)) {
      return responseData;
    }

    throw error;
  }
}

function encryptPassword(password: string, k: string): string {
  const derivedKey = k.slice(4) + k.slice(0, 4);
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(derivedKey, 'utf8'), null);
  cipher.setAutoPadding(true);
  return cipher.update(password, 'utf8', 'base64') + cipher.final('base64');
}

function normalizeBaseURL(baseURL?: string): string {
  if (!baseURL) {
    return DEFAULT_BASE_URL;
  }

  return baseURL.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function getRegionConfig(baseURL: string): { country: string; countryCode: string } {
  const hostname = parseHostname(baseURL);
  const labels = hostname.split('.').filter(Boolean);

  if (labels.includes('euiot')) {
    return { country: 'DE', countryCode: '49' };
  }

  if (labels.includes('cniot')) {
    return { country: 'CN', countryCode: '86' };
  }

  if (hostname === 'api.roborock.com') {
    return { country: 'SG', countryCode: '65' };
  }

  return { country: 'US', countryCode: '1' };
}

function parseHostname(baseURL: string): string {
  try {
    return new URL(`https://${normalizeBaseURL(baseURL)}`).hostname.toLowerCase();
  } catch {
    return normalizeBaseURL(baseURL).split('/')[0].split(':')[0].toLowerCase();
  }
}

function md5bin(value: string): Buffer {
  return crypto.createHash('md5').update(value).digest();
}

function md5hex(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

function formatLoginFailure(result: LoginResult): string {
  const message = typeof result.msg === 'string' && result.msg.length > 0
    ? result.msg
    : 'Unknown error';
  const code = result.code === undefined ? '' : ` (Code: ${result.code})`;
  return `${message}${code}`;
}

function maskIdentifier(value: string): string {
  if (value.length <= 8) {
    return '[redacted]';
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidUserData(value: unknown): value is RoborockUserData {
  if (!isRecord(value) || typeof value.token !== 'string' || !isRecord(value.rriot)) {
    return false;
  }

  const rriot = value.rriot;
  return typeof rriot.u === 'string'
    && typeof rriot.s === 'string'
    && typeof rriot.h === 'string'
    && typeof rriot.k === 'string'
    && isRecord(rriot.r)
    && typeof rriot.r.a === 'string'
    && typeof rriot.r.m === 'string';
}

function isRoborockCloudDevice(value: unknown): value is RoborockCloudDevice {
  return isRecord(value) && typeof value.duid === 'string' && value.duid.length > 0;
}

function isRoborockProduct(value: unknown): value is RoborockProduct {
  return isRecord(value);
}

function isRoborockRoom(value: unknown): value is RoborockHomeRoom {
  return isRecord(value)
    && (typeof value.id === 'string' || typeof value.id === 'number')
    && typeof value.name === 'string';
}
