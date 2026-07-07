import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_SCRIPT = join(REPO_ROOT, ".github", "scripts", "version-bump.sh");
const AUTO_VERSION_YAML = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "auto-version.yaml",
);

// --- Drift / single-source-of-truth contract ------------------------------
// The release path is a two-copy hazard: a `scripts/` and a `.github/scripts/`
// version-bump.sh once coexisted and silently diverged (one kept a
// `npm view ... || echo "0.0.0"` fallback that rebases the version to 0.0.1 on a
// transient registry outage). These assertions fail loudly if the duplicate
// reappears or the workflow stops pointing at the hardened live copy.

test("the deduplicated duplicate release scripts stay gone", () => {
  assert.equal(
    existsSync(join(REPO_ROOT, "scripts", "version-bump.sh")),
    false,
    "scripts/version-bump.sh must not exist; .github/scripts is the single source of truth",
  );
  assert.equal(
    existsSync(join(REPO_ROOT, "scripts", "promote-changelog.mjs")),
    false,
    "scripts/promote-changelog.mjs must not exist; .github/scripts is the single source of truth",
  );
});

test("auto-version.yaml invokes exactly the live hardened release script", () => {
  const yaml = readFileSync(AUTO_VERSION_YAML, "utf8");
  const invocations = [...yaml.matchAll(/bash\s+(\S*version-bump\.sh)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    invocations,
    [".github/scripts/version-bump.sh"],
    "the workflow must run one, and only the .github/scripts, version-bump.sh",
  );
  assert.ok(existsSync(LIVE_SCRIPT), "the invoked script must exist on disk");
});

test("the live release script carries the hardened npm-view logic", () => {
  const src = readFileSync(LIVE_SCRIPT, "utf8");
  // Positive markers: enumerate the idioms that make this the hardened copy, so
  // the guard fails if any is refactored away (it must not pass vacuously).
  const requiredMarkers = [
    /grep -q "E404"/, // distinguishes unpublished from a network outage
    /Refusing to guess a version/, // fails loud on a non-E404 npm error
    /max_version/, // reconciles npm vs the highest git tag
    /BASE_VERSION=\$\(max_version/,
    /emit_output "released=true"/, // couples the PyPI publish
    /emit_output "version=\$NEW_VERSION"/,
  ];
  for (const marker of requiredMarkers) {
    assert.match(src, marker);
  }
  // Negative marker: the vacuous fallback that rebases to 0.0.0 on any error.
  assert.doesNotMatch(
    src,
    /npm view[^\n]*\|\|\s*echo\s*"0\.0\.0"/,
    "the `npm view ... || echo 0.0.0` fallback must never return",
  );
});

// --- Behavioral: npm-view error handling ----------------------------------
// Run the REAL script in a throwaway git repo with `npm` stubbed on PATH. Both
// scenarios exit before any publish/push, so nothing leaves the sandbox.

/** Build a throwaway git repo tagged v0.0.0 at HEAD, plus a stubbed `npm`. */
function makeSandbox(npmStubBody) {
  const dir = mkdtempSync(join(tmpdir(), "vbump-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "sandbox-pkg", version: "0.0.0" }) + "\n",
  );
  const binDir = join(dir, "stub-bin");
  mkdirSync(binDir);
  const npmStub = join(binDir, "npm");
  writeFileSync(npmStub, `#!/usr/bin/env bash\n${npmStubBody}\n`);
  chmodSync(npmStub, 0o755);

  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "chore: seed");
  git("tag", "v0.0.0");
  return { dir, binDir };
}

/** Run the live script in `dir`; return {status, stderr, stdout}. */
function runScript(dir, binDir) {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  delete env.ANTHROPIC_API_KEY;
  delete env.GITHUB_OUTPUT;
  const res = spawnSync("bash", [LIVE_SCRIPT], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(res.error, undefined, "failed to spawn the release script");
  return { status: res.status, stderr: res.stderr, stdout: res.stdout };
}

test("a network-error npm view aborts rather than rebasing to 0.0.0", () => {
  // Non-E404 failure: the registry is unreachable.
  const { dir, binDir } = makeSandbox(
    'echo "npm error code ETIMEDOUT" >&2\necho "npm error network request to https://registry.npmjs.org failed" >&2\nexit 1',
  );
  try {
    const { status, stderr } = runScript(dir, binDir);
    assert.notEqual(status, 0, "must exit non-zero on an unexpected npm error");
    assert.match(stderr, /failed unexpectedly \(not E404\)/);
    assert.doesNotMatch(
      stderr,
      /Current npm version: 0\.0\.0/,
      "must not silently treat a network outage as an unpublished package",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an E404 npm view treats the package as unpublished (0.0.0)", () => {
  const { dir, binDir } = makeSandbox(
    'echo "npm error code E404" >&2\necho "npm error 404 Not Found - GET https://registry.npmjs.org/sandbox-pkg" >&2\nexit 1',
  );
  try {
    const { status, stderr } = runScript(dir, binDir);
    // HEAD is already tagged v0.0.0, so the script logs the resolved version and
    // exits 0 at the "no new commits" guard — proving E404 -> 0.0.0, no abort.
    assert.equal(status, 0, "E404 must not abort the release run");
    assert.match(stderr, /Current npm version: 0\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
