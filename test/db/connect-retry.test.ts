import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withConnectRetry } from "./helpers.ts";

function timedOut(): Error {
  return Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:5432"), {
    code: "ETIMEDOUT",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a connect that times out once succeeds on the second attempt", async () => {
  const attempt = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(timedOut())
    .mockResolvedValueOnce("connected");
  const result = withConnectRetry(attempt);
  await vi.advanceTimersByTimeAsync(999);
  expect(attempt).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("connected");
  expect(attempt).toHaveBeenCalledTimes(2);
});

test("a timeout carried on the cause is retried", async () => {
  const attempt = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("query failed", { cause: timedOut() }))
    .mockResolvedValueOnce("connected");
  const result = withConnectRetry(attempt);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toBe("connected");
  expect(attempt).toHaveBeenCalledTimes(2);
});

test("an error other than ETIMEDOUT is rethrown after one attempt", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(refused);
  await expect(withConnectRetry(attempt)).rejects.toBe(refused);
  expect(attempt).toHaveBeenCalledTimes(1);
});

test("the last ETIMEDOUT is rethrown after 3 attempts", async () => {
  const errors = [timedOut(), timedOut(), timedOut()];
  const attempt = vi.fn<() => Promise<string>>();
  for (const error of errors) attempt.mockRejectedValueOnce(error);
  const result = withConnectRetry(attempt);
  const settled = expect(result).rejects.toBe(errors[2]);
  await vi.advanceTimersByTimeAsync(2_000);
  await settled;
  expect(attempt).toHaveBeenCalledTimes(3);
});
