import { describe, expect, it } from "vitest";
import {
  getChannelAnomalyThreshold,
  getChannelBaselines,
  getTransportProfile,
  isPassiveChannel,
  isPollingChannel,
  registerChannelTransport,
  resolveChannelTransport,
} from "./oag-channel-profiles.js";

describe("resolveChannelTransport", () => {
  it("maps websocket channels correctly", () => {
    expect(resolveChannelTransport("discord")).toBe("websocket");
    expect(resolveChannelTransport("slack")).toBe("websocket");
    expect(resolveChannelTransport("whatsapp")).toBe("websocket");
    expect(resolveChannelTransport("mattermost")).toBe("websocket");
    expect(resolveChannelTransport("irc")).toBe("websocket");
  });

  it("maps polling channels correctly", () => {
    expect(resolveChannelTransport("telegram")).toBe("polling");
    expect(resolveChannelTransport("matrix")).toBe("polling");
    expect(resolveChannelTransport("zalo")).toBe("polling");
    expect(resolveChannelTransport("zalouser")).toBe("polling");
    expect(resolveChannelTransport("nextcloud-talk")).toBe("polling");
    expect(resolveChannelTransport("tlon")).toBe("polling");
    expect(resolveChannelTransport("nostr")).toBe("polling");
  });

  it("maps webhook channels correctly", () => {
    expect(resolveChannelTransport("line")).toBe("webhook");
    expect(resolveChannelTransport("googlechat")).toBe("webhook");
    expect(resolveChannelTransport("msteams")).toBe("webhook");
    expect(resolveChannelTransport("synology-chat")).toBe("webhook");
  });

  it("maps local channels correctly", () => {
    expect(resolveChannelTransport("imessage")).toBe("local");
    expect(resolveChannelTransport("bluebubbles")).toBe("local");
    expect(resolveChannelTransport("signal")).toBe("local");
  });

  it("defaults unknown channels to websocket", () => {
    expect(resolveChannelTransport("unknown-channel")).toBe("websocket");
    expect(resolveChannelTransport("")).toBe("websocket");
  });
});

describe("getTransportProfile", () => {
  it("returns websocket profile defaults", () => {
    const profile = getTransportProfile("discord");
    expect(profile.transport).toBe("websocket");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(30_000);
    expect(profile.maxRetries).toBe(5);
    expect(profile.stalePollFactor).toBe(1);
    expect(profile.restartBackoffInitialMs).toBe(5_000);
    expect(profile.restartBackoffMaxMs).toBe(5 * 60_000);
  });

  it("returns polling profile defaults", () => {
    const profile = getTransportProfile("telegram");
    expect(profile.transport).toBe("polling");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(90_000);
    expect(profile.maxRetries).toBe(8);
    expect(profile.stalePollFactor).toBe(2);
    expect(profile.restartBackoffInitialMs).toBe(10_000);
    expect(profile.restartBackoffMaxMs).toBe(10 * 60_000);
  });

  it("returns webhook profile defaults", () => {
    const profile = getTransportProfile("line");
    expect(profile.transport).toBe("webhook");
    expect(profile.staleThresholdMs).toBe(0);
    expect(profile.recoveryBudgetMs).toBe(60_000);
    expect(profile.maxRetries).toBe(5);
    expect(profile.stalePollFactor).toBe(1);
  });

  it("returns local profile defaults", () => {
    const profile = getTransportProfile("signal");
    expect(profile.transport).toBe("local");
    expect(profile.staleThresholdMs).toBe(30 * 60_000);
    expect(profile.recoveryBudgetMs).toBe(15_000);
    expect(profile.maxRetries).toBe(3);
    expect(profile.stalePollFactor).toBe(2);
    expect(profile.restartBackoffInitialMs).toBe(3_000);
    expect(profile.restartBackoffMaxMs).toBe(2 * 60_000);
  });

  it("returns websocket profile for unknown channels", () => {
    const profile = getTransportProfile("some-future-channel");
    expect(profile.transport).toBe("websocket");
  });
});

describe("registerChannelTransport", () => {
  it("registers a new channel transport at runtime", () => {
    expect(resolveChannelTransport("my-custom-channel")).toBe("websocket"); // default
    registerChannelTransport("my-custom-channel", "polling");
    expect(resolveChannelTransport("my-custom-channel")).toBe("polling");
    // Clean up: restore to a known state so other tests aren't affected.
    registerChannelTransport("my-custom-channel", "websocket");
  });

  it("overrides an existing channel transport", () => {
    const original = resolveChannelTransport("discord");
    expect(original).toBe("websocket");
    registerChannelTransport("discord", "polling");
    expect(resolveChannelTransport("discord")).toBe("polling");
    // Restore
    registerChannelTransport("discord", "websocket");
  });
});

describe("isPollingChannel", () => {
  it("returns true for polling channels", () => {
    expect(isPollingChannel("telegram")).toBe(true);
    expect(isPollingChannel("matrix")).toBe(true);
    expect(isPollingChannel("zalo")).toBe(true);
    expect(isPollingChannel("nostr")).toBe(true);
  });

  it("returns true for local channels (local uses polling pattern)", () => {
    expect(isPollingChannel("signal")).toBe(true);
    expect(isPollingChannel("imessage")).toBe(true);
    expect(isPollingChannel("bluebubbles")).toBe(true);
  });

  it("returns false for websocket channels", () => {
    expect(isPollingChannel("discord")).toBe(false);
    expect(isPollingChannel("slack")).toBe(false);
  });

  it("returns false for webhook channels", () => {
    expect(isPollingChannel("line")).toBe(false);
    expect(isPollingChannel("msteams")).toBe(false);
  });
});

describe("isPassiveChannel", () => {
  it("returns true for webhook channels", () => {
    expect(isPassiveChannel("line")).toBe(true);
    expect(isPassiveChannel("googlechat")).toBe(true);
    expect(isPassiveChannel("msteams")).toBe(true);
    expect(isPassiveChannel("synology-chat")).toBe(true);
  });

  it("returns false for non-webhook channels", () => {
    expect(isPassiveChannel("discord")).toBe(false);
    expect(isPassiveChannel("telegram")).toBe(false);
    expect(isPassiveChannel("signal")).toBe(false);
  });
});

describe("getChannelAnomalyThreshold", () => {
  it("returns elevated threshold for noisy channels", () => {
    expect(getChannelAnomalyThreshold("discord")).toBe(2.5);
    expect(getChannelAnomalyThreshold("slack")).toBe(2.5);
  });

  it("returns threshold for quiet channels", () => {
    expect(getChannelAnomalyThreshold("signal")).toBe(2.0);
  });

  it("returns default threshold for channels without overrides", () => {
    expect(getChannelAnomalyThreshold("telegram")).toBe(2.0);
    expect(getChannelAnomalyThreshold("whatsapp")).toBe(2.0);
    expect(getChannelAnomalyThreshold("unknown")).toBe(2.0);
  });
});

describe("getChannelBaselines", () => {
  it("returns discord baselines with rate_limit and auth_resource", () => {
    const baselines = getChannelBaselines("discord");
    expect(baselines).toBeDefined();
    expect(baselines!.rate_limit).toBeDefined();
    expect(baselines!.rate_limit.expectedPerHour).toBeGreaterThan(0);
    expect(baselines!.auth_resource).toBeDefined();
    expect(baselines!.auth_resource.note).toContain("4014");
  });

  it("returns telegram baselines with poll_stall and network_timeout", () => {
    const baselines = getChannelBaselines("telegram");
    expect(baselines).toBeDefined();
    expect(baselines!.poll_stall).toBeDefined();
    expect(baselines!.network_timeout).toBeDefined();
    expect(baselines!.network_timeout.expectedPerHour).toBeGreaterThan(0);
  });

  it("returns signal baselines with low general threshold", () => {
    const baselines = getChannelBaselines("signal");
    expect(baselines).toBeDefined();
    expect(baselines!.general).toBeDefined();
    expect(baselines!.general.expectedPerHour).toBeLessThan(1);
  });

  it("returns slack baselines with websocket_408 and reconnect", () => {
    const baselines = getChannelBaselines("slack");
    expect(baselines).toBeDefined();
    expect(baselines!.websocket_408).toBeDefined();
    expect(baselines!.reconnect).toBeDefined();
  });

  it("returns whatsapp baselines with auth_pairing", () => {
    const baselines = getChannelBaselines("whatsapp");
    expect(baselines).toBeDefined();
    expect(baselines!.auth_pairing).toBeDefined();
    expect(baselines!.auth_pairing.note).toContain("Session rotation");
  });

  it("returns web baselines with auth_pairing (WhatsApp Web alias)", () => {
    const baselines = getChannelBaselines("web");
    expect(baselines).toBeDefined();
    expect(baselines!.auth_pairing).toBeDefined();
  });

  it("returns undefined for channels without baselines", () => {
    expect(getChannelBaselines("matrix")).toBeUndefined();
    expect(getChannelBaselines("unknown-channel")).toBeUndefined();
  });

  it("every baseline has required fields", () => {
    for (const channel of ["discord", "telegram", "signal", "slack", "whatsapp", "web"]) {
      const baselines = getChannelBaselines(channel);
      expect(baselines).toBeDefined();
      for (const [_key, baseline] of Object.entries(baselines!)) {
        expect(baseline.expectedPerHour).toBeTypeOf("number");
        expect(baseline.stddev).toBeTypeOf("number");
        expect(baseline.note).toBeTypeOf("string");
        expect(baseline.note.length).toBeGreaterThan(0);
        // stddev must be non-negative
        expect(baseline.stddev).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
