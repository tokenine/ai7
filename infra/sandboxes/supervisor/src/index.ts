import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
<<<<<<< HEAD
import { computerResourceLimits } from "./computer-spec.js";
import { computerEgressSetting, ensureComputerImage, screenNetworkMode } from "./context.js";
import { computerEgressMode, ensureRestrictedEgressEnforced } from "./egress.js";
import { reclaimIdleComputerNetworks } from "./networks.js";
import { supervisorApp } from "./routes.js";

export { supervisorApp };
=======
import { requestLogging } from "@rakazo/logging/hono";
import Docker from "dockerode";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { computerImageEnsurer } from "./computer-image.js";
import type { ComputerEgressMode } from "./computer-spec.js";
import {
  assertComputerMountSources,
  assertVolumeSubpathSupport,
  COMPUTER_GID,
  COMPUTER_IMAGE,
  COMPUTER_UID,
  COMPUTER_USER,
  computerBridgeNameFor,
  computerDnsMatches,
  computerHomeStorage,
  computerMountsMatch,
  computerNetworkCreateOptions,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  computerNetworkOwnerFor,
  computerResourceLimits,
  containerCreateOptions,
  containerNameFor,
  controlPortPublicationMatches,
  homeVolumeMatches,
  hostComputerUser,
  isIpv6NetworkUnavailable,
  legacyNetworkOwnedSolelyBy,
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
  resolveComputerDns,
  resolveComputerEgressMode,
  resolveComputerMounts,
  resolveScreenNetworkMode,
  resolveScreenPublishTarget,
  resolveSpaceComputerLimit,
  resolveTeamScreenLimit,
  SCREEN_HOST,
  screenPeerNetworkConnectOptions,
  screenPorts,
  screenUrlFor,
  screenUrlWithToken,
  xdotoolCommand,
} from "./computer-spec.js";
import { EgressNotEnforced, verifyRestrictedEgress } from "./egress-probe.js";
import { assertComputerHomeWritable } from "./home-ownership.js";
import type { ScreenAssignment } from "./supervisor-logic.js";
import {
  assertRequestIdentity,
  attemptComputerControl,
  browserProfilePathForScreen,
  ComputerControlUnavailableError,
  clearComputerScreenRegistry,
  completeWarmReleasedScreen,
  computerActionSchema,
  computerCommandEnv,
  computerControlTimeoutMs,
  containerActionSteps,
  controlHandlesActions,
  createComputerWithNameRetry,
  createDockerStreamDemuxer,
  currentComputerScreens,
  demuxDockerStream,
  ensureScreenCommand,
  hasValidBearerToken,
  interactiveScreenCommand,
  isComputerControlUnavailable,
  isManagedComputer,
  launchBrowserCommand,
  nextScreenIndex,
  normalizeWorkspaceRelative,
  oldestIdleScreen,
  pageBrowserNotReady,
  parseObservation,
  preferComputerControl,
  quiesceBrowserProfilesCommand,
  refusedCommand,
  releaseAssignedScreen,
  removeOwnedComputer,
  resetManagedScreensCommand,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  screenRecentlyEnsured,
  screenReleaseStopCommand,
  shouldReplayComputerActions,
  stopExtraScreenCommand,
  teardownReleasedScreen,
  terminalCommand,
  toSandboxInput,
  withKeyedLock,
  workspaceTarget,
} from "./supervisor-logic.js";

loadRootEnv();

const dockerSocketPath = resolveDockerSocketPath();
const docker = dockerSocketPath ? new Docker({ socketPath: dockerSocketPath }) : new Docker();
const computerContext =
  process.env.RAKAZO_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
const ensureComputerImage = computerImageEnsurer(docker, COMPUTER_IMAGE, computerContext);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
let supervisorInfo: Docker.ContainerInspectInfo | undefined;
let dockerApiVersion: string | undefined;
const supervisorToken = resolveSupervisorToken(process.env);
const screenNetworkMode = resolveScreenNetworkMode(process.env.SANDBOX_SCREEN_NETWORK);
const computerEgressSetting = resolveComputerEgressMode();
// `auto` starts open and becomes restricted once the probe shows the host rules are in place.
let computerEgressMode: ComputerEgressMode =
  computerEgressSetting === "restricted" ? "restricted" : "open";
const computerDns = resolveComputerDns();
const computerMounts = resolveComputerMounts(undefined, [dataDir, dockerSocketPath]);
// Docker follows symlinks in a bind source, so also check where a locally visible source points.
assertComputerMountSources(
  computerMounts.map((mount) => ({
    ...mount,
    source: existsSync(mount.source) ? realpathSync(mount.source) : mount.source,
  })),
  [dataDir, dockerSocketPath],
);
const teamScreenLimit = resolveTeamScreenLimit();
// Host-run supervisors on Docker Desktop (macOS/Windows) cannot reach container
// IPs, so computer control must use a published loopback port instead.
const controlViaLoopback = process.env.SANDBOX_CONTROL_VIA_LOOPBACK === "true";
const computerScreens = new Map<string, Map<string, ScreenAssignment>>();
// Container start time each screen registry was built under; see currentComputerScreens.
const computerScreenBoots = new Map<string, string>();

export const MAX_SUPERVISOR_REQUEST_BYTES = 1024 * 1024;
const maxUploadSizeBytes = uploadSizeFromEnv(process.env);

function supervisorFileContentLimit(maxBytes: number): number {
  // Preserve the internal workspace-write allowance as well as configured chat uploads.
  return Math.max(16 * 1024 * 1024, Math.ceil(maxBytes / 3) * 4);
}

export const MAX_SUPERVISOR_FILE_REQUEST_BYTES =
  supervisorFileContentLimit(maxUploadSizeBytes) + 64 * 1024;

/** Keep normal control requests small; file writes also need a base64 JSON envelope. */
export function supervisorRequestBodyLimit(
  method: string,
  pathname: string,
  maxBytes = maxUploadSizeBytes,
): number {
  return method === "POST" && /^\/computers\/[^/]+\/files\/?$/.test(pathname)
    ? supervisorFileContentLimit(maxBytes) + 64 * 1024
    : MAX_SUPERVISOR_REQUEST_BYTES;
}

export function supervisorFileWriteSchema(maxBytes = maxUploadSizeBytes) {
  return z.object({
    path: z.string(),
    content: z.string().max(supervisorFileContentLimit(maxBytes)),
    executable: z.boolean().optional(),
  });
}

const limitSupervisorRequestBody: MiddlewareHandler = async (c, next) => {
  return bodyLimit({
    maxSize: supervisorRequestBodyLimit(c.req.method, c.req.path),
    onError: (context) => context.json({ error: "Request body is too large." }, 413),
  })(c, next);
};

const app = new Hono();

export { app as supervisorApp };

app.use("*", requestLogging());

export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (env.DOCKER_HOST) return undefined;
  if (env.DOCKER_SOCKET) return env.DOCKER_SOCKET;
  if (platform === "darwin") {
    const userSocket = path.join(env.HOME ?? homedir(), ".docker", "run", "docker.sock");
    if (existsSync(userSocket)) return userSocket;
  }
  return platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
}

app.get("/health", (c) => c.json({ ok: true, image: COMPUTER_IMAGE }));

app.use("/computers", async (c, next) => {
  if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/computers/*", async (c, next) => {
  if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
app.use("/computers", limitSupervisorRequestBody);
app.use("/computers/*", limitSupervisorRequestBody);

app.post("/computers", async (c) => {
  const body = z
    .object({
      botId: z.string().min(1),
      homePath: z.string().min(1),
      spaceId: z.string().min(1),
    })
    .parse(await c.req.json());
  try {
    assertRequestIdentity(c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-space-id"), {
      botId: body.botId,
      spaceId: body.spaceId,
    });
    return await withBotLifecycleLock(body.botId, async () => {
      await ensureComputerImage();
      await ensureRestrictedEgressEnforced();
      const runtimeInfo = await inspectSupervisorContainer();
      // A containerized supervisor's host paths (data directory, Docker socket) are known only now.
      assertComputerMountSources(
        computerMounts,
        (runtimeInfo?.Mounts ?? []).map((mount) => mount.Source),
      );
      const networkMode = computerNetworkName(body.botId, runtimeInfo);
      const networkOwner = computerNetworkOwnerFor(dataDir, runtimeInfo);
      const serviceHomePath = path.resolve(body.homePath);
      assertBotHomePath(serviceHomePath, body.botId);
      const hostUid = process.getuid?.();
      const hostGid = process.getgid?.();
      // The API normally creates the home. A non-root standalone supervisor may
      // do so as the same user, but a root supervisor must never create or chown
      // user-controlled paths at runtime; Compose data-init handles legacy data.
      if (hostUid !== 0) await mkdir(serviceHomePath, { recursive: true });
      const storage = computerHomeStorage(serviceHomePath, dataDir, runtimeInfo);
      if (storage.homeVolume) {
        assertVolumeSubpathSupport((await docker.version()).ApiVersion);
      }
      const computerUser = runtimeInfo ? COMPUTER_USER : hostComputerUser(hostUid, hostGid);
      const existing = await findBotContainer(body.botId, body.spaceId);
      if (existing) {
        const info = await existing.inspect();
        const desired = await docker.getImage(COMPUTER_IMAGE).inspect();
        const controlPublishOk = controlPortPublicationMatches(
          info.HostConfig.PortBindings,
          controlViaLoopback,
        );
        const botNetwork =
          networkMode === computerNetworkNameFor(body.botId) ? networkMode : undefined;
        let endpoint = botNetwork ? info.NetworkSettings?.Networks?.[botNetwork] : undefined;
        let botNetworkInfo =
          botNetwork && (computerEgressMode === "restricted" || !info.State.Running)
            ? await inspectNetworkIfPresent(botNetwork)
            : undefined;
        // An IPv4-only network left by the daemon fallback outlives a crash (no
        // /stop to hand it back). Give it back here — the same safe removal the
        // stop path uses — so the reconnect below recreates it IPv6-first. On a
        // host without IPv6 this costs one failed dual-stack create plus the
        // IPv4 create per resume.
        let recreateForIpv6 = false;
        if (
          computerEgressMode !== "restricted" &&
          botNetwork &&
          endpoint &&
          !info.State.Running &&
          botNetworkInfo &&
          botNetworkInfo.EnableIPv6 !== true
        ) {
          await removeUnusedComputerNetwork(botNetwork, existing.id).catch((error) => {
            getLogger().error("computer network reclaim failed", error);
          });
          recreateForIpv6 = !(await inspectNetworkIfPresent(botNetwork));
          // A partial cleanup may have disconnected the computer yet left the
          // network in place; the cached endpoint would then still match the
          // surviving network and the resume would start with no attachment.
          // Re-read both and reconnect whenever the endpoint is absent or stale.
          endpoint = (await existing.inspect()).NetworkSettings?.Networks?.[botNetwork];
          botNetworkInfo = await inspectNetworkIfPresent(botNetwork);
        }
        // A stop gives the network back after disconnecting the computer, and a
        // network removed or recreated under a stopped computer leaves its endpoint
        // on the old network ID. Either way it rejoins the network before starting:
        // Docker would start it with no network, or not at all.
        const reconnect =
          Boolean(botNetwork) &&
          !info.State.Running &&
          (recreateForIpv6 || !endpoint || botNetworkInfo?.Id !== endpoint.NetworkID);
        // A network created while egress was open keeps a generic br-* bridge
        // the host ruleset does not match, so restricted mode must not resume a
        // computer on it — the replace path rekeys the network instead.
        const restrictedBridgeOk =
          !botNetwork ||
          reconnect ||
          computerEgressMode !== "restricted" ||
          botNetworkInfo?.Options?.["com.docker.network.bridge.name"] ===
            computerBridgeNameFor(body.botId);
        if (
          info.Image === desired.Id &&
          // A named-network container must also still be attached: a network
          // deleted mid-recreate leaves HostConfig.NetworkMode set while
          // NetworkSettings is empty, and resuming that yields no connectivity.
          (!networkMode ||
            (info.HostConfig.NetworkMode === networkMode &&
              (reconnect || Boolean(info.NetworkSettings?.Networks?.[networkMode])))) &&
          restrictedBridgeOk &&
          info.Config.User === computerUser &&
          // DNS is fixed when a container is created, so a changed setting replaces it.
          computerDnsMatches(info.HostConfig.Dns, computerDns) &&
          // So are host mounts: an added, changed or removed one replaces the computer.
          computerMountsMatch(info, computerMounts) &&
          controlPublishOk &&
          (!storage.homeVolume || homeVolumeMatches(info.HostConfig.Mounts, storage.homeVolume)) &&
          // A computer that cannot rejoin its network is replaced below instead.
          (!reconnect ||
            (await reconnectBotComputer(existing, body.botId, networkOwner, Boolean(endpoint))))
        ) {
          const started = !info.State.Running;
          if (started) await existing.start();
          return c.json({
            id: existing.id,
            image: COMPUTER_IMAGE,
            resumed: true,
            started,
          });
        }
      }

      // Under a space cap, serialize count+create and incompatible replace (remove+create)
      // per space inside the bot lock. Replacements skip the admission check but still
      // take the lock so a temporary free slot cannot be stolen by another bot's create.
      // Lock order is always bot → space; never take a bot lock while holding a space lock.
      const spaceComputerLimit = resolveSpaceComputerLimit();
      const createComputer = async () => {
        if (!existing && spaceComputerLimit > 0) {
          const currentCount = await countSpaceContainers(body.spaceId);
          if (currentCount >= spaceComputerLimit) {
            return c.json(
              { error: `Computer limit reached for space (max: ${spaceComputerLimit})` },
              429,
            );
          }
        }

        // Existing containers with the current image already use the selected user.
        // Before replacing or creating a container, validate its home without
        // privileged filesystem mutations that could escape via concurrent renames.
        // Match hostComputerUser(): missing/root host identity falls back to 1000:1000.
        const effectiveUid =
          runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
            ? COMPUTER_UID
            : hostUid;
        const effectiveGid =
          runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
            ? COMPUTER_GID
            : hostGid;
        await assertComputerHomeWritable(serviceHomePath, effectiveUid, effectiveGid);
        const name = containerNameFor(body.botId);
        const createdNetwork =
          screenNetworkMode === "internal"
            ? undefined
            : await ensureBotNetwork(body.botId, networkOwner);
        const options = containerCreateOptions({
          name,
          image: COMPUTER_IMAGE,
          botId: body.botId,
          spaceId: body.spaceId,
          ...storage,
          user: computerUser,
          networkMode,
          controlToken: randomUUID(),
          publishControlPort: controlViaLoopback,
          dns: computerDns,
          mounts: computerMounts,
        });
        let container: Docker.Container | undefined;
        const removeNamedComputer = () =>
          removeOwnedComputer(
            docker.getContainer(name),
            (id) => docker.getContainer(id).remove({ force: true }),
            (info) => isRakazoContainer(info, body.botId, body.spaceId),
            (id) => clearComputerScreenRegistry(computerScreens, computerScreenBoots, id),
          );
        try {
          if (existing) {
            await withComputerScreenLock(existing.id, async () => {
              try {
                await existing.remove({ force: true });
              } catch (error) {
                if (!(await removeNamedComputer())) {
                  throw new Error("Failed to remove existing computer; name fallback failed", {
                    cause: error,
                  });
                }
              }
              clearComputerScreenRegistry(computerScreens, computerScreenBoots, existing.id);
            });
          }
          container = await createComputerWithNameRetry(
            () => docker.createContainer(options),
            removeNamedComputer,
          );
          await container.start();
        } catch (error) {
          // Never force removal: a lost start response may hide a running computer.
          // Docker also refuses network removal while any endpoint is attached.
          await container?.remove().catch(() => undefined);
          await createdNetwork?.remove().catch(() => undefined);
          throw error;
        }
        return c.json({
          id: container.id,
          image: COMPUTER_IMAGE,
          resumed: false,
        });
      };

      if (spaceComputerLimit > 0) {
        return await withSpaceComputerLock(body.spaceId, createComputer);
      }
      return await createComputer();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.get("/computers/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const { info } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    return c.json({
      id,
      running: Boolean(info.State.Running),
      image: info.Config.Image,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 404);
  }
});

app.post("/computers/:id/exec", async (c) => {
  const id = c.req.param("id");
  const body = z
    .object({
      argv: z.array(z.string()),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .parse(await c.req.json());
  const timeoutMs = boundedSandboxCommandTimeoutMs(body.timeoutMs);
  let container: Docker.Container;
  let layout: ReturnType<typeof screenPorts>;
  try {
    const managed = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    // Docker would fail the exec inside the stream; answer up front so the caller can boot it.
    if (!managed.info.State.Running) return c.json({ error: "computer is not running" }, 409);
    container = managed.container;
    const screenId = c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || id;
    const screenIndex = computerScreens.get(id)?.get(screenId)?.index ?? 0;
    layout = screenPorts(screenIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ stdout: "", stderr: message, code: 1 }, 200);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: {
        type: "stdout" | "stderr" | "exit";
        data?: string;
        code?: number;
      }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      try {
        let streamedStderr = "";
        const result = await runContainerCommand(
          container,
          body.argv.length ? body.argv : ["/bin/echo", "ready"],
          {
            workingDir: body.cwd ?? "/home/rakazo",
            env: [
              ...computerCommandEnv(layout),
              ...Object.entries(body.env ?? {}).map(([k, v]) => `${k}=${v}`),
            ],
            timeoutMs,
            onOutput: (chunk) => {
              if (!chunk.data) return;
              if (chunk.stream === "stderr") streamedStderr += chunk.data;
              send({ type: chunk.stream, data: chunk.data });
            },
          },
        );
        const timeoutNote = `command timed out after ${timeoutMs} ms\n`;
        if (result.stderr.startsWith(streamedStderr)) {
          const extra = result.stderr.slice(streamedStderr.length);
          if (extra) send({ type: "stderr", data: extra });
        } else if (result.stderr.endsWith(timeoutNote) && !streamedStderr.endsWith(timeoutNote)) {
          send({ type: "stderr", data: timeoutNote });
        }
        send({ type: "exit", code: result.code });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "stderr", data: message });
        send({ type: "exit", code: 1 });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

// The bot's folder in the computer's home that files its page downloads, and PDFs its tabs show, are saved to.
const downloadFolder = z.string().min(1).max(1024).optional();

app.post("/computers/:id/browser", async (c) => {
  // Read eagerly so the Node HTTP adapter observes disconnects during screen setup too.
  const signal = c.req.raw.signal;
  signal.throwIfAborted();
  const parsed = z
    .discriminatedUnion("command", [
      z.object({
        command: z.literal("navigate"),
        url: z
          .string()
          .url()
          .max(8192)
          .refine((value) => {
            if (!URL.canParse(value)) return false;
            const url = new URL(value);
            return /^https?:$/.test(url.protocol) && !url.username && !url.password;
          }),
        downloads: downloadFolder,
      }),
      z.object({
        command: z.literal("snapshot"),
        query: z.string().max(200).optional(),
        downloads: downloadFolder,
      }),
      z.object({
        command: z.literal("purchase_check"),
        // Only clicks are looked at; `desktop` asks about a click or key on the screen instead.
        actions: z
          .array(z.object({ kind: z.string().max(40), ref: z.string().max(200).optional() }))
          .max(24)
          .optional(),
        desktop: z.boolean().optional(),
        enter: z.boolean().optional(),
        unplaced: z.boolean().optional(),
        points: z
          .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
          .max(24)
          .optional(),
      }),
      z.object({
        command: z.literal("act"),
        downloads: downloadFolder,
        actions: z
          .array(
            z.discriminatedUnion("kind", [
              z.object({
                kind: z.literal("click"),
                ref: z.string().min(1).max(200),
                // The user approved a purchase click on this site (see rakazo-page-browser).
                approved: z.boolean().optional(),
                // Empty for a page without a host (about:blank, data:, file:).
                site: z.string().max(253).optional(),
                label: z.string().max(200).optional(),
                amount: z.string().max(100).optional(),
              }),
              z.object({
                kind: z.literal("upload"),
                ref: z.string().min(1).max(200),
                paths: z.array(z.string().min(1).max(1024)).min(1).max(10),
                roots: z.array(z.string().min(1).max(1024)).max(2).optional(),
              }),
              z.object({
                kind: z.literal("pay_token"),
                text: z.string().min(1).max(4096),
                origin: z.string().url().max(2048),
                merchantAccountId: z.string().min(1).max(128),
              }),
              z
                .object({
                  kind: z.enum(["fill", "type"]),
                  ref: z.string().min(1).max(200).optional(),
                  text: z.string().max(32_000),
                  origin: z.string().url().max(2048).optional(),
                  field: z.enum(["username", "password", "card", "code"]).optional(),
                  cardField: z.enum(["number", "expiry", "cvc", "postal_code"]).optional(),
                })
                // The field decides which input types the helper accepts for a saved login or card.
                .refine((step) => !step.origin || step.field, "A saved login fill needs its field")
                // A card detail is hidden and checked only when bound to the merchant's origin.
                .refine(
                  (step) => step.field !== "card" || step.origin,
                  "A card fill needs its origin",
                )
                // A one-time code goes into one field of the site that asked for it.
                .refine(
                  (step) =>
                    step.field !== "code" || (step.kind === "fill" && step.ref && step.origin),
                  "A code fill needs its ref and origin",
                )
                .refine(
                  (step) =>
                    step.cardField
                      ? step.kind === "fill" && step.field === "card" && !step.ref
                      : Boolean(step.ref),
                  "A fill needs either its ref or, for a card, its card field",
                ),
            ]),
          )
          .min(1)
          .max(24),
      }),
    ])
    .safeParse(await c.req.json());
  // Refused here, before anything reaches the computer: the caller learns by this code alone that
  // nothing ran, and may keep a one-time code for another try. Keep in step with the adapters'
  // INVALID_BROWSER_REQUEST.
  if (!parsed.success) {
    return c.json(
      { ok: false, code: "invalid_browser_request", error: "Invalid page browser request" },
      400,
    );
  }
  const body = parsed.data;
  const carriesSavedLogin =
    body.command === "act" && body.actions.some((step) => "origin" in step && step.origin);
  const screen = (reuseRecent: boolean) =>
    managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
      true,
      reuseRecent,
    );
  const runHelper = ({ container, layout }: Awaited<ReturnType<typeof screen>>) =>
    runContainerCommand(
      container,
      // Arguments go over stdin: origin-bound fills carry saved logins and cards, and argv is
      // readable by any process in the computer, including the bot's own shell. Other commands
      // also keep the argv copy so a computer still on an older image keeps working until it is
      // replaced.
      [
        "/usr/local/bin/rakazo-page-browser",
        body.command,
        ...(carriesSavedLogin ? [] : [JSON.stringify(body)]),
      ],
      {
        env: [
          `DISPLAY=${layout.display}`,
          `RAKAZO_CDP_PORT=${layout.debugPort}`,
          "HOME=/home/rakazo",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "RAKAZO_BROWSER_WATCH_STDIN=1",
          "RAKAZO_BROWSER_ARGS_STDIN=1",
          ...(process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES !== undefined
            ? [`RAKAZO_BROWSER_UPLOAD_MAX_BYTES=${process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES}`]
            : []),
        ],
        timeoutMs: 25_000,
        signal,
        stdin: `${JSON.stringify(body)}\n`,
      },
    );
  // The browser may be intentionally stopped (browserAutostart off): opening a
  // screen must not pop a window, but a page-browser call starts it on demand.
  // Re-running over a live browser is a cheap profile scan that exits 0.
  const launchBrowser = ({ container, index, screenKey }: Awaited<ReturnType<typeof screen>>) =>
    runContainerCommand(container, ["bash", "-c", launchBrowserCommand(index, screenKey)], {
      timeoutMs: 30_000,
      signal,
    });
  try {
    const reusable = await screen(true);
    const launched = await launchBrowser(reusable);
    if (launched.code !== 0) {
      throw new Error(
        launched.stderr.trim() || `computer browser failed to start on ${reusable.layout.display}`,
      );
    }
    let result = await runHelper(reusable);
    // A reused screen skipped setup, so a browser that has since exited gets it before one retry. A
    // purchase check presses nothing and never starts the browser again: no browser has nothing to buy.
    if (reusable.reused && body.command !== "purchase_check" && pageBrowserNotReady(result))
      result = await runHelper(await screen(false));
    // Exit 2 is the page browser refusing the command before touching the page (an older
    // computer image does not know it). Pass its reply on, as LinuxDesktop does, so a caller
    // can tell "cannot check" from a check that failed.
    if (result.code === 2 && Buffer.byteLength(result.stdout) <= 512 * 1024) {
      const refused = refusedCommand(result.stdout);
      if (refused) return c.json(refused);
    }
    // A nonzero exit or malformed output cannot establish which mutations ran.
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024) {
      throw new Error(
        /command timed out/.test(result.stderr)
          ? `Page browser timed out; the page may be busy or blocked by a dialog. ${
              body.command === "act"
                ? "Inspect the screen before continuing."
                : "Retry once before using other tools."
            }`
          : "Page browser unavailable or interrupted",
      );
    }
    return c.json(JSON.parse(result.stdout));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return c.json({
      ok: false,
      fallback: "computer_act",
      uncertain: body.command === "act",
      error:
        detail && detail !== "Page browser unavailable or interrupted"
          ? detail
          : "Page browser unavailable or interrupted. Inspect the screen before continuing.",
    });
  }
});

app.post("/computers/:id/observe", async (c) => {
  try {
    const { container, info, layout, browserProfile } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const control = computerControlEndpoint(info);
    const observation = await preferComputerControl(
      control
        ? async () => {
            const result = await controlDesktop(
              control,
              [],
              layout.display,
              browserProfile,
              true,
              0,
            );
            if (!result.observation) throw new Error("computer control returned no observation");
            return result.observation;
          }
        : undefined,
      () => observeContainer(container, layout.display),
    );
    return c.json(observation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.post("/computers/:id/actions", async (c) => {
  const body = z
    .object({
      actions: z.array(computerActionSchema).max(24),
      observe: z.boolean().optional(),
      settleMs: z.number().min(0).max(5_000).optional(),
    })
    .parse(await c.req.json());
  try {
    const { container, info, layout, browserProfile } = await managedScreen(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const endpoint = computerControlEndpoint(info);
    const control =
      endpoint && controlHandlesActions(info.Config.Labels, body.actions) ? endpoint : undefined;
    const attempt = await attemptComputerControl(
      control
        ? () =>
            controlDesktop(
              control,
              body.actions,
              layout.display,
              browserProfile,
              body.observe !== false,
              body.settleMs ?? 0,
            )
        : undefined,
    );
    if (attempt.status === "failed") throw attempt.error;
    const controlResult = attempt.status === "ok" ? attempt.value : undefined;
    if (shouldReplayComputerActions(attempt) && body.actions.length)
      await applyContainerActions(container, body.actions, layout.display, browserProfile);
    if (shouldReplayComputerActions(attempt) && body.settleMs)
      await new Promise((resolve) => setTimeout(resolve, body.settleMs));
    return c.json({
      completed: controlResult?.completed ?? body.actions.length,
      ...(body.observe === false
        ? {}
        : {
            observation:
              controlResult?.observation ?? (await observeContainer(container, layout.display)),
          }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

app.get("/computers/:id/files", async (c) => {
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    const relative = normalizeWorkspaceRelative(c.req.query("path") ?? "");
    const target = workspaceTarget(relative);
    if (c.req.query("mode") === "read") {
      const maxBytesRaw = c.req.query("maxBytes");
      const maxBytes = maxBytesRaw === undefined ? undefined : Number(maxBytesRaw);
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
        return c.json({ error: "invalid maxBytes" }, 400);
      }
      const script = [
        "import base64, sys",
        "target, limit = sys.argv[1], int(sys.argv[2])",
        "with open(target, 'rb') as source:",
        "  content = source.read() if limit < 0 else source.read(limit + 1)",
        "if limit >= 0 and len(content) > limit: sys.exit(42)",
        "sys.stdout.write(base64.b64encode(content).decode())",
      ].join("\n");
      const result = await runContainerCommand(container, [
        "python3",
        "-c",
        script,
        target,
        String(maxBytes ?? -1),
      ]);
      if (result.code === 42) {
        return c.json({ error: `computer file exceeds ${maxBytes} bytes` }, 413);
      }
      if (result.code !== 0) return c.json({ error: result.stderr || "file not found" }, 404);
      return c.json({ content: result.stdout.trim() });
    }
    const script = [
      "import json, os, stat, sys",
      "root, rel = sys.argv[1], sys.argv[2]",
      "out = []",
      "for item in os.scandir(root):",
      "  if item.is_symlink(): continue",
      "  info = item.stat(follow_symlinks=False)",
      "  child = '/'.join(x for x in (rel, item.name) if x)",
      "  out.append({'path': child, 'kind': 'dir' if item.is_dir(follow_symlinks=False) else 'file', 'size': info.st_size, **({'executable': True} if item.is_file(follow_symlinks=False) and bool(info.st_mode & stat.S_IXUSR) else {})})",
      "print(json.dumps(sorted(out, key=lambda x: x['path'])))",
    ].join("\n");
    const result = await runContainerCommand(container, [
      "python3",
      "-c",
      script,
      target,
      relative,
    ]);
    if (result.code !== 0) return c.json({ error: result.stderr || "directory not found" }, 404);
    return c.json(JSON.parse(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.post("/computers/:id/files", async (c) => {
  const body = supervisorFileWriteSchema().parse(await c.req.json());
  try {
    const { container } = await managedContainer(
      c.req.param("id"),
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    const target = workspaceTarget(normalizeWorkspaceRelative(body.path));
    await writeContainerFile(
      container,
      target,
      Buffer.from(body.content, "base64"),
      body.executable,
    );
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.get("/computers/:id/screen", async (c) => {
  const id = c.req.param("id");
  try {
    const { container, info, layout, viewToken } = await managedScreen(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
      false,
    );
    const screenUrl = await publishedScreenUrl(container, info, layout.viewPort);
    return c.redirect(screenUrlWithToken(screenUrl, viewToken));
  } catch {
    return c.json({ error: "computer not found" }, 404);
  }
});

app.post("/computers/:id/screen-mode", async (c) => {
  const body = z
    .object({
      interactive: z.boolean(),
      controlToken: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .optional(),
      revokeControl: z.boolean().optional(),
    })
    .refine((value) => !value.interactive || value.controlToken, {
      message: "interactive screen requires a control token",
    })
    .parse(await c.req.json());
  try {
    const id = c.req.param("id");
    const botId = c.req.header("x-rakazo-bot-id");
    const spaceId = c.req.header("x-rakazo-space-id");
    const screenId = c.req.header("x-rakazo-screen-id");
    const screenLeaseId = c.req.header("x-rakazo-screen-lease-id");
    const { container, info } = await managedContainer(id, botId, spaceId);
    const { layout, viewToken } = await withComputerScreenLock(id, async () => {
      const screen = await ensureManagedScreen(
        id,
        container,
        botId,
        screenId,
        screenLeaseId,
        !body.interactive && body.revokeControl === false,
      );
      if (body.interactive || body.revokeControl !== false) {
        const changed = await setInteractiveScreen(
          container,
          body.interactive,
          body.controlToken,
          screen.layout,
        );
        const slot = computerScreens.get(id)?.get(screen.screenKey);
        if (slot && changed) {
          if (body.interactive) {
            slot.controlled = true;
            slot.controlToken = body.controlToken;
          } else {
            delete slot.controlled;
            delete slot.controlToken;
          }
        }
      }
      return screen;
    });
    const screenUrl = await publishedScreenUrl(
      container,
      info,
      body.interactive ? layout.controlPort : layout.viewPort,
    );
    return c.json({
      screenUrl: screenUrlWithToken(screenUrl, body.interactive ? body.controlToken! : viewToken),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.post("/computers/:id/terminal", async (c) => {
  const body = z
    .object({
      controlToken: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      cwd: z.string().max(4096).default(""),
    })
    .parse(await c.req.json());
  try {
    const id = c.req.param("id");
    const botId = c.req.header("x-rakazo-bot-id");
    const { container, info } = await managedContainer(
      id,
      botId,
      c.req.header("x-rakazo-space-id"),
    );
    const cwd = workspaceTarget(normalizeWorkspaceRelative(body.cwd));
    const terminalToken = randomUUID();
    const layout = await withComputerScreenLock(id, async () => {
      const screen = await ensureManagedScreen(
        id,
        container,
        botId,
        c.req.header("x-rakazo-screen-id"),
        c.req.header("x-rakazo-screen-lease-id"),
        false,
      );
      const result = await runContainerCommand(
        container,
        [
          "bash",
          "-c",
          terminalCommand(body.controlToken, terminalToken, cwd, undefined, screen.layout),
        ],
        { env: computerCommandEnv(screen.layout) },
      );
      if (result.code === 75) throw new TerminalControlReleasedError();
      if (result.code !== 0) throw new Error(result.stderr || "terminal failed to start");
      return screen.layout;
    });
    const screenUrl = await publishedScreenUrl(container, info, layout.controlPort);
    return c.json({ terminalUrl: screenUrlWithToken(screenUrl, terminalToken) });
  } catch (error) {
    if (error instanceof TerminalControlReleasedError) {
      return c.json({ error: "screen control is not active" }, 409);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

class TerminalControlReleasedError extends Error {}

app.post("/computers/:id/input", async (c) => {
  const id = c.req.param("id");
  const body = z
    .object({
      input: z.object({
        kind: z.enum(["key", "pointer", "clipboard"]),
        key: z.string().optional(),
        modifiers: z.array(z.string()).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(["left", "right"]).optional(),
        type: z.enum(["move", "down", "up", "click"]).optional(),
        text: z.string().optional(),
      }),
      leaseId: z.string().optional(),
    })
    .parse(await c.req.json());
  const input = toSandboxInput(body.input);
  try {
    const { container, layout } = await managedScreen(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
      c.req.header("x-rakazo-screen-id"),
      c.req.header("x-rakazo-screen-lease-id"),
    );
    const result = await runContainerCommand(container, [
      "env",
      `DISPLAY=${layout.display}`,
      ...xdotoolCommand(input),
    ]);
    if (result.code !== 0) {
      return c.json({ ok: false, error: "input failed" }, 500);
    }
    return c.json({ ok: true, leaseId: body.leaseId ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.delete("/computers/:id/screen", async (c) => {
  // A later exec 404 ("no such exec") is a failed stop, not a missing computer.
  let containerFound = false;
  try {
    const id = c.req.param("id");
    const { container } = await managedContainer(
      id,
      c.req.header("x-rakazo-bot-id"),
      c.req.header("x-rakazo-space-id"),
    );
    containerFound = true;
    const screenId = c.req.header("x-rakazo-screen-id") || c.req.header("x-rakazo-bot-id") || id;
    const cancelRunWork = c.req.header("x-rakazo-cancel-run-work") === "1";
    const keepScreenWarm = c.req.header("x-rakazo-preserve-screen") === "1" && !cancelRunWork;
    const screenLeaseId = c.req.header("x-rakazo-screen-lease-id");
    await withComputerScreenLock(id, async () => {
      const info = await container.inspect();
      const assigned = currentComputerScreens(
        computerScreens,
        computerScreenBoots,
        id,
        info.State?.StartedAt,
      );
      const index = assigned ? releaseAssignedScreen(assigned, screenId, screenLeaseId) : undefined;
      if (keepScreenWarm) {
        if (assigned && index !== undefined) {
          let controlReleased = false;
          try {
            const control = await runContainerCommand(container, [
              "bash",
              "-c",
              interactiveScreenCommand(false, undefined, screenPorts(index)),
            ]);
            controlReleased = control.code === 0;
          } catch {
            // If revocation is uncertain, full teardown is safer than retaining control.
          }
          if (controlReleased) {
            completeWarmReleasedScreen(assigned, screenId, index, Date.now());
          } else {
            await teardownReleasedScreen(assigned, screenId, index, () =>
              runContainerCommand(container, [
                "bash",
                "-c",
                stopExtraScreenCommand(index, screenId),
              ]),
            );
          }
        }
      } else {
        const stop = screenReleaseStopCommand(index, {
          hasRegistry: Boolean(assigned),
          cancelRunWork,
          screenId,
        });
        if (assigned && index !== undefined) {
          await teardownReleasedScreen(
            assigned,
            screenId,
            index,
            () => runContainerCommand(container, ["bash", "-c", stop]),
            { retainBrowser: !cancelRunWork },
          );
        } else if (stop) {
          const result = await runContainerCommand(container, ["bash", "-c", stop]);
          if (result.code !== 0) {
            throw new Error(result.stderr || "computer screen failed to stop");
          }
        }
      }
      // Ordinary release retains the browser's slot; cancellation can empty the registry.
      // Keep an emptied registry. A missing one means the supervisor lost track of the
      // container, and the next screen request then resets every desktop process in it.
    });
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof ComputerIdentityError)
      return c.json({ error: "invalid computer identity" }, 403);
    if (
      !containerFound &&
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 404
    )
      return c.json({ error: "computer not found" }, 404);
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message || "computer screen failed to stop" }, 500);
  }
});

app.post("/computers/:id/stop", async (c) => {
  const id = c.req.param("id");
  const botId = c.req.header("x-rakazo-bot-id");
  try {
    const { container } = await managedContainer(id, botId, c.req.header("x-rakazo-space-id"));
    await withComputerScreenLock(id, async () => {
      const info = await container.inspect();
      if (info.State.Running) {
        try {
          // Every profile on the home volume, not only screens still held in memory.
          const checkpoint = await runContainerCommand(container, [
            "bash",
            "-c",
            quiesceBrowserProfilesCommand(),
          ]);
          if (checkpoint.code !== 0)
            throw new Error(checkpoint.stderr || "bot browsers failed to stop");
        } finally {
          // Failed profiles remain on the durable home for recovery after restart.
          await container.stop();
          clearComputerScreenRegistry(computerScreens, computerScreenBoots, id);
        }
      }
      clearComputerScreenRegistry(computerScreens, computerScreenBoots, id);
    });
    if (botId && screenNetworkMode !== "internal") {
      await reclaimComputerNetwork(container, botId).catch((error) => {
        getLogger().error("computer network reclaim failed", error);
      });
    }
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof ComputerIdentityError)
      return c.json({ error: "invalid computer identity" }, 403);
    if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404)
      return c.json({ error: "computer not found" }, 404);
    return c.json({ error: "computer failed to stop" }, 500);
  }
});

app.delete("/computers/:id", async (c) => {
  const id = c.req.param("id");
  const botId = c.req.header("x-rakazo-bot-id");
  try {
    if (!botId) throw new Error("missing computer identity");
    return await withBotLifecycleLock(botId, async () => {
      const { container } = await managedContainer(id, botId, c.req.header("x-rakazo-space-id"));
      await withComputerScreenLock(id, async () => {
        await container.remove({ force: true }).catch((error) => {
          // Already gone is deleted; any other failure may leave the computer running.
          if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
        });
        clearComputerScreenRegistry(computerScreens, computerScreenBoots, id);
      });
      if (screenNetworkMode !== "internal") {
        await removeBotNetwork(botId);
      }
      return c.json({ ok: true });
    });
  } catch (error) {
    if (error instanceof ComputerIdentityError)
      return c.json({ error: "invalid computer identity" }, 403);
    if ((error as { statusCode?: number })?.statusCode === 404)
      return c.json({ error: "computer not found" }, 404);
    return c.json({ error: "computer failed to delete" }, 500);
  }
});
>>>>>>> 1b571f1db (computer: Thai fonts, Google Chrome and desktop launchers, no eager browser)

async function startSupervisor() {
  const logger = await createRootLogger(SERVICE_NAMES.supervisor);
  // Resolve the ceilings before binding the port. They are otherwise parsed inside
  // containerCreateOptions, so a malformed RAKAZO_COMPUTER_* value would let the supervisor start
  // and pass its healthcheck, then fail the first POST /computers with a 500 that reads like a
  // Docker problem. Failing here names the variable while the deployment is still coming up.
  computerResourceLimits();
  if (computerEgressSetting === "auto" && screenNetworkMode !== "internal") {
    // Settle the mode before the first provision rather than on it.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .catch((error) => logger.error("computer egress probe failed", error));
  } else if (computerEgressMode === "restricted" && screenNetworkMode !== "internal") {
    // Report a missing host ruleset at startup too, not only on the first provision.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .then(() => logger.info("restricted computer egress verified"))
      .catch((error) => logger.error("restricted computer egress unavailable", error));
  }
  void reclaimIdleComputerNetworks().catch((error) => {
    logger.error("computer network reclaim failed", error);
  });
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
  const server = serve({ fetch: supervisorApp.fetch, hostname, port }, () => {
    logger.info("supervisor listening", { "http.host": hostname, "http.port": port });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeListeningServer(server);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // A rejected startup keeps Node's default: the error is printed and the process exits.
  void startSupervisor();
}
