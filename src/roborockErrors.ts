export const ROBOROCK_REQUEST_TIMEOUT_ERROR_CODE = 'cloud-request-timeout';

const DEFAULT_ROBOROCK_ERROR_MESSAGE = 'The Roborock request was rejected without details, usually because MQTT/local transport is unavailable at that moment.';

export class RoborockRequestTimeoutError extends Error {
  public readonly code = ROBOROCK_REQUEST_TIMEOUT_ERROR_CODE;

  constructor(
    public readonly requestId: number,
    public readonly method: string,
    public readonly mqttConnected: boolean,
    public readonly timeoutMs: number,
  ) {
    super(
      `Cloud request with id ${requestId} with method ${method} timed out after ${timeoutMs / 1000} seconds. `
      + `MQTT connection state: ${mqttConnected}`,
    );
    this.name = 'RoborockRequestTimeoutError';
  }
}

export function isRoborockRequestTimeoutError(error: unknown, method?: string): error is RoborockRequestTimeoutError {
  return error instanceof RoborockRequestTimeoutError && (method === undefined || error.method === method);
}

export function isCloudAckTimeout(error: unknown, method: string): boolean {
  return isRoborockRequestTimeoutError(error, method);
}

export function formatRoborockError(error: unknown, fallbackMessage = DEFAULT_ROBOROCK_ERROR_MESSAGE): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error === undefined) {
    return fallbackMessage;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
