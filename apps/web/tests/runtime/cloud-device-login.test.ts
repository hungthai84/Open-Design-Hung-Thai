import { afterEach, expect, it, vi } from 'vitest';
import { createCloudDeviceLogin } from '../../src/runtime/cloud-device-login';

afterEach(() => vi.unstubAllEnvs());
const activation = 'https://open-design.powerformer.net/cloud/cli/activate?deviceId=test&userCode=ABC123';
function fixture(blocked = false) {
  const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  const browser = { open: vi.fn(() => blocked ? null : popup), location: { replace: vi.fn() } };
  return { popup, browser, login: createCloudDeviceLogin(browser as unknown as Window) };
}
it('opens synchronously, detaches opener, navigates only the allowed device page, and enters Home once', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  const { login, browser, popup } = fixture();
  login.begin();
  expect(browser.open).toHaveBeenCalledWith('about:blank', '_blank');
  expect(popup.opener).toBeNull();
  for (const url of ['javascript:alert(1)', 'https://evil.test/cloud/cli/activate', 'https://open-design.ai.evil.test/cloud/cli/activate', 'https://open-design.ai/cloud/dashboard', 'https://x:y@open-design.ai/cloud/cli/activate']) login.activate(url);
  expect(popup.location.replace).not.toHaveBeenCalled();
  login.activate(activation);
  login.activate(activation);
  expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(activation);
  expect(login.finish()).toBe(true);
  expect(login.finish()).toBe(true);
  expect(browser.location.replace).toHaveBeenCalledExactlyOnceWith('/');
  expect(popup.close).toHaveBeenCalledTimes(1);
});
it('does not try another asynchronous popup when blocked or manually closed', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  const blocked = fixture(true);
  blocked.login.begin(); blocked.login.activate(activation);
  expect(blocked.browser.open).toHaveBeenCalledTimes(1);
  expect(blocked.popup.location.replace).not.toHaveBeenCalled();
  const closed = fixture(); closed.login.begin(); closed.popup.closed = true;
  closed.login.activate(activation);
  expect(closed.popup.location.replace).not.toHaveBeenCalled();
  expect(closed.login.finish()).toBe(true);
});
it('closes a cancelled attempt and starts a new device flow without reusing its URL', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  const { login, browser, popup } = fixture();
  login.begin(); login.activate(activation); login.close();
  login.begin(); login.activate(activation.replace('ABC123', 'NEW456'));
  expect(browser.open).toHaveBeenCalledTimes(2);
  expect(popup.location.replace).toHaveBeenLastCalledWith(activation.replace('ABC123', 'NEW456'));
});
it('keeps the desktop login lifecycle unchanged when the POC flag is disabled', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '0');
  const { login, browser } = fixture();
  login.begin(); login.activate(activation);
  expect(login.finish()).toBe(false);
  expect(browser.open).not.toHaveBeenCalled();
  expect(browser.location.replace).not.toHaveBeenCalled();
});

it('ignores delayed cleanup and URLs from a cancelled attempt after a new click', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  const { login, popup } = fixture();
  const old = login.begin(); login.close(old);
  const next = login.begin();
  popup.close.mockClear();
  login.activate(activation, old); login.close(old);
  expect(login.isCurrent(old)).toBe(false);
  expect(popup.close).not.toHaveBeenCalled();
  expect(popup.location.replace).not.toHaveBeenCalled();
  login.activate(activation, next);
  expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(activation);
});

it('pins a deployed build to its configured activation authority', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_AUTH_BASE_URL', 'https://odcloud-amr.inner.nexu.space/cloud');
  const { login, popup } = fixture();
  login.begin();
  for (const url of [activation, 'https://amr-4114.inner.nexu.space/cloud/cli/activate?deviceId=test', 'https://odcloud-amr.inner.nexu.space.evil.test/cloud/cli/activate',
    'https://odcloud-amr.inner.nexu.space/cloud/cli/activate#other',
    'https://odcloud-amr.inner.nexu.space/cli/activate']) login.activate(url);
  expect(popup.location.replace).not.toHaveBeenCalled();
  const isolated = 'https://odcloud-amr.inner.nexu.space/cloud/cli/activate?deviceId=test&userCode=ABC123';
  login.activate(isolated);
  expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(isolated);
});

it('does not fall back to another authority when isolated configuration is invalid', () => {
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_POC', '1');
  vi.stubEnv('NEXT_PUBLIC_OD_CLOUD_AUTH_BASE_URL', 'https://user:secret@auth.example.test/cloud');
  const { login, popup } = fixture();
  login.begin(); login.activate(activation);
  expect(popup.location.replace).not.toHaveBeenCalled();
});
