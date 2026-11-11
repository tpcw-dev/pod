import { loadFixtureCodeHost } from "../adapters/code-host/fixture.ts";
import { realCodeHost } from "../adapters/code-host/real.ts";
import type { CodeHostPort } from "../core/ports/code-host.ts";

export function codeHostFor(): CodeHostPort {
  const fixtures = process.env["POD_CODE_HOST_FIXTURES"];
  return fixtures === undefined || fixtures === ""
    ? realCodeHost
    : loadFixtureCodeHost(fixtures);
}
