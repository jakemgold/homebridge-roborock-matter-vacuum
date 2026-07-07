import { describe, expect, it } from 'vitest';
import {
  formatRoborockError,
  isCloudAckTimeout,
  isRoborockRequestTimeoutError,
  RoborockRequestTimeoutError,
} from '../src/roborockErrors';

describe('RoborockRequestTimeoutError', () => {
  it('classifies request timeouts by method without parsing log text', () => {
    const error = new RoborockRequestTimeoutError(42, 'get_status', true, 10_000);

    expect(isRoborockRequestTimeoutError(error)).toBe(true);
    expect(isRoborockRequestTimeoutError(error, 'get_status')).toBe(true);
    expect(isRoborockRequestTimeoutError(error, 'app_start')).toBe(false);
    expect(isCloudAckTimeout(error, 'get_status')).toBe(true);
    expect(isCloudAckTimeout(error, 'app_start')).toBe(false);
    expect(isRoborockRequestTimeoutError(new Error(error.message), 'get_status')).toBe(false);
    expect(error.message).toContain('method get_status');
  });

  it('formats non-error Roborock failures consistently', () => {
    expect(formatRoborockError(undefined)).toContain('rejected without details');
    expect(formatRoborockError('plain failure')).toBe('plain failure');
    expect(formatRoborockError({ code: 7 })).toBe('{"code":7}');
  });
});
