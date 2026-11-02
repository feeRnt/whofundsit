import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  green,
  isRetryableHttpStatus,
  red,
  redactUrlSecrets,
  userAgentFromEnv,
} from "./httpCache.js";

describe("userAgentFromEnv", () => {
  function withWarnCapture(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return lines;
  }

  it("returns the configured value silently", () => {
    const name = "__PROBE_UA_SET__";
    const prev = process.env[name];
    process.env[name] = "Probe/1.0 (probe@example.org)";
    try {
      const lines = withWarnCapture(() => {
        assert.equal(userAgentFromEnv(name), "Probe/1.0 (probe@example.org)");
      });
      assert.equal(lines.length, 0);
    } finally {
      if (prev === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prev;
      }
    }
  });

  it("falls back with a warning when unset, empty, or placeholder", () => {
    const cases: [string, string | undefined][] = [
      ["__PROBE_UA_UNSET__", undefined],
      ["__PROBE_UA_EMPTY__", ""],
      ["__PROBE_UA_PH__", "Your Name you@example.com"],
    ];
    for (const [name, value] of cases) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      try {
        const lines = withWarnCapture(() => {
          assert.equal(
            userAgentFromEnv(name),
            "WhoFundsIt/0.1 (contact: dev@example.com)",
          );
        });
        assert.equal(lines.length, 1);
        assert.ok(lines[0].includes(name));
      } finally {
        delete process.env[name];
      }
    }
    // Custom fallback honored too.
    delete process.env.__PROBE_UA_CF__;
    try {
      withWarnCapture(() => {
        assert.equal(userAgentFromEnv("__PROBE_UA_CF__", "Custom/1.0"), "Custom/1.0");
      });
    } finally {
      delete process.env.__PROBE_UA_CF__;
    }
  });

  it("warns only once per variable", () => {
    const name = "__PROBE_UA_ONCE__";
    delete process.env[name];
    try {
      const lines = withWarnCapture(() => {
        userAgentFromEnv(name);
        userAgentFromEnv(name);
      });
      assert.equal(lines.length, 1);
    } finally {
      delete process.env[name];
    }
  });
});

describe("terminal colors", () => {
  it("passes text through untouched when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(green("hit"), "hit");
      assert.equal(red("miss"), "miss");
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });
});

describe("redactUrlSecrets", () => {
  it("masks credential params but keeps the rest of the URL", () => {
    assert.equal(
      redactUrlSecrets(
        "https://api.openalex.org/funders/F1?api_key=KEY123",
      ),
      "https://api.openalex.org/funders/F1?api_key=***",
    );
    assert.equal(
      redactUrlSecrets("https://x.test/a?b=1&token=sekret&c=2"),
      "https://x.test/a?b=1&token=***&c=2",
    );
    assert.equal(
      redactUrlSecrets("https://query.wikidata.org/sparql?query=SELECT"),
      "https://query.wikidata.org/sparql?query=SELECT",
    );
  });
});

describe("isRetryableHttpStatus", () => {
  it("retries 429 and 5xx, throws everything else immediately", () => {
    assert.equal(isRetryableHttpStatus(429), true);
    assert.equal(isRetryableHttpStatus(500), true);
    assert.equal(isRetryableHttpStatus(502), true);
    assert.equal(isRetryableHttpStatus(504), true);
    assert.equal(isRetryableHttpStatus(400), false);
    assert.equal(isRetryableHttpStatus(403), false);
    assert.equal(isRetryableHttpStatus(404), false);
    assert.equal(isRetryableHttpStatus(undefined), false);
  });
});
