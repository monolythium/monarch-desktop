import { describe, expect, it } from "vitest";
import {
  EMPTY_ONBOARDING_PROBES,
  MIN_REGISTER_BOND_LYTHOSHI,
  MONARCH_OS_ISO_URL,
  onboardingConfigured,
  reduceOnboardingSteps,
  type OnboardingProbeInputs,
} from "./onboarding";

function probes(overrides: Partial<OnboardingProbeInputs>): OnboardingProbeInputs {
  return { ...EMPTY_ONBOARDING_PROBES, ...overrides };
}

describe("reduceOnboardingSteps", () => {
  it("returns exactly the 9 canonical steps in order", () => {
    const steps = reduceOnboardingSteps(EMPTY_ONBOARDING_PROBES);
    expect(steps.map((step) => step.id)).toEqual([
      "flash-iso",
      "pair-node",
      "operator-key",
      "fund-bond",
      "register",
      "set-name",
      "publish-chat-peers",
      "join-cluster",
      "dkg-attestation",
    ]);
    expect(steps.map((step) => step.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("links the ISO download on step 1", () => {
    const steps = reduceOnboardingSteps(EMPTY_ONBOARDING_PROBES);
    expect(steps[0]?.href).toBe(MONARCH_OS_ISO_URL);
    expect(MONARCH_OS_ISO_URL).toBe("https://github.com/monolythium/monarch-os-talos/releases");
  });

  it("renders everything unknown — never 'not done' — when nothing is verifiable", () => {
    const steps = reduceOnboardingSteps(EMPTY_ONBOARDING_PROBES);
    expect(steps[0]?.status).toBe("unknown");
    expect(steps[2]?.status).toBe("unknown");
    // Chain steps depend on the key, which is unverifiable → blocked, not todo.
    expect(steps.filter((step) => step.status === "todo")).toHaveLength(0);
  });

  it("blocks fund/register until the key is verified present", () => {
    const steps = reduceOnboardingSteps(probes({ inTauri: true, hasOperatorKey: false }));
    expect(steps[2]?.status).toBe("todo"); // operator-key
    expect(steps[3]?.status).toBe("blocked"); // fund-bond
    expect(steps[4]?.status).toBe("blocked"); // register
  });

  it("marks fund-bond done at exactly the 5,000 LYTH floor", () => {
    const base = {
      inTauri: true,
      hasOperatorKey: true,
      walletAddress: "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46",
    };
    const under = reduceOnboardingSteps(
      probes({ ...base, balanceLythoshi: MIN_REGISTER_BOND_LYTHOSHI - 1n }),
    );
    const at = reduceOnboardingSteps(
      probes({ ...base, balanceLythoshi: MIN_REGISTER_BOND_LYTHOSHI }),
    );
    expect(under[3]?.status).toBe("todo");
    expect(at[3]?.status).toBe("done");
  });

  it("walks a fully-onboarded operator to 10/10 done", () => {
    const steps = reduceOnboardingSteps(
      probes({
        inTauri: true,
        talosConfigured: true,
        talosReachable: true,
        rpcReachable: true,
        hasOperatorKey: true,
        walletAddress: "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46",
        balanceLythoshi: MIN_REGISTER_BOND_LYTHOSHI * 2n,
        registered: true,
        hasDisplayName: true,
        chatPeersPublished: true,
        inCluster: true,
        lifecycleState: "active",
      }),
    );
    expect(steps.every((step) => step.status === "done")).toBe(true);
  });

  it("keeps post-register steps blocked while unregistered", () => {
    const steps = reduceOnboardingSteps(
      probes({
        inTauri: true,
        hasOperatorKey: true,
        registered: false,
        chatPeersPublished: false,
        inCluster: false,
      }),
    );
    expect(steps[4]?.status).toBe("todo"); // register
    expect(steps[5]?.status).toBe("blocked"); // set-name
    expect(steps[6]?.status).toBe("blocked"); // publish-chat-peers
    expect(steps[7]?.status).toBe("blocked"); // join cluster
  });

  it("distinguishes not-exposed (unknown) from not-done after registration", () => {
    const steps = reduceOnboardingSteps(
      probes({
        inTauri: true,
        hasOperatorKey: true,
        registered: true,
        hasDisplayName: false,
        chatPeersPublished: null, // lookup unavailable
        inCluster: false,
      }),
    );
    expect(steps[5]?.status).toBe("todo"); // set-name
    expect(steps[6]?.status).toBe("unknown"); // publish-chat-peers
    expect(steps[7]?.status).toBe("todo"); // join-cluster
  });
});

describe("onboardingConfigured", () => {
  it("is false on a blank install", () => {
    expect(onboardingConfigured(EMPTY_ONBOARDING_PROBES)).toBe(false);
  });
  it("is true once any anchor (key / talos / ssh / registration) is verified", () => {
    expect(onboardingConfigured(probes({ hasOperatorKey: true }))).toBe(true);
    expect(onboardingConfigured(probes({ talosConfigured: true }))).toBe(true);
    expect(onboardingConfigured(probes({ sshConnected: true }))).toBe(true);
    expect(onboardingConfigured(probes({ registered: true }))).toBe(true);
  });
});
