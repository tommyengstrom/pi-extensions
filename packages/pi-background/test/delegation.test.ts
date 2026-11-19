import { expect, it, vi } from "vitest";
import { backgroundFixture } from "../../../test/background-fixture.js";
import { delegationServiceV2 } from "../src/delegation.js";

it("never falls back to a listener that could ignore worker overrides", () => {
  const { pi } = backgroundFixture();
  const old = vi.fn();
  pi.events.on("pi-herdr-core:delegate-and-wait:v1", old);
  expect(() => delegationServiceV2(pi)).toThrow(/v2 is unavailable/);
  expect(old).not.toHaveBeenCalled();
});
