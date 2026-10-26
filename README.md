# companion-module-screenbird-signage

[Bitfocus Companion](https://bitfocus.io/companion) module for [Screenbird](https://screenbird.app), cloud digital signage.

- Switch all screens to a scene with one button, go to the next scene, or stop everything.
- Push content (files, designs, apps, split screens, playlists) to one screen or sub-screen.
- Buttons show what is live: scene live, partly live or changed since it went live, what a screen shows, screen online.
- Live updates over a WebSocket; no polling.

End-user documentation (setup, actions, feedbacks, variables, troubleshooting) is in [companion/HELP.md](./companion/HELP.md). The module talks to the [Screenbird API v1](https://api.screenbird.app/v1).

## Requirements

- Companion 4.3 or newer. The module depends on `@companion-module/base` ~2.0.4 on purpose: 2.1 and later require Companion 5.
- Node.js 22 (the `node22` runtime). Node's built-in `fetch` and `WebSocket` are used, so there are no HTTP or WebSocket dependencies.
- Yarn 4.
- A Screenbird API token with access "Control screens and scenes".

## Development

```sh
yarn install
yarn build       # compile TypeScript to dist/
yarn dev         # compile in watch mode
yarn typecheck
yarn lint
yarn format
yarn test        # build, package and run the end-to-end scenarios
yarn package     # build plus companion-module-build (pkg/ and a .tgz)
```

`yarn lint` (ESLint) and `yarn format` (Prettier) use the shared configuration from `@companion-module/tools`.

### Tests

`test/run-all.sh` builds and packages the module, then loads the packaged `main.js` the way Companion does, with a fake host context (`test/harness.mjs`) against a local mock of the Screenbird API over HTTPS and WSS (`test/mock.mjs`). Each scenario in `test/scenarios.mjs` covers one behavior: reconnects per close code, half-open connections, rate limiting, revoked tokens, out-of-order responses, preset contrast and more. A self-signed certificate is created once in the temporary directory; the full run takes a few minutes, because several scenarios wait for real timeouts.

Run a single scenario after a build with:

```sh
NODE_EXTRA_CA_CERTS=<work dir>/cert.pem TEST_WORK_DIR=<work dir> node test/scenarios.mjs basic
```

## Project layout

| File                      | Purpose                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `src/main.ts`             | Module instance: Companion lifecycle, status, state, variables and definitions       |
| `src/connection.ts`       | Connection state machine: loading state, refresh scheduling, reconnects and failures |
| `src/live-socket.ts`      | One WebSocket to `/v1/events` with handshake timeout and keepalive                   |
| `src/failures.ts`         | Maps API errors to a status and a retry strategy                                     |
| `src/api.ts`              | REST client and response validation                                                  |
| `src/actions.ts`          | Action definitions                                                                   |
| `src/feedbacks.ts`        | Feedback definitions                                                                 |
| `src/presets.ts`          | Preset definitions                                                                   |
| `src/variables.ts`        | Variable definitions                                                                 |
| `src/choices.ts`          | Dropdown choices for scenes, screens and content                                     |
| `src/colors.ts`           | Scene colors and contrast helpers for presets                                        |
| `src/config.ts`           | Connection settings                                                                  |
| `src/upgrades.ts`         | Upgrade scripts                                                                      |
| `companion/HELP.md`       | Help shown in Companion                                                              |
| `companion/manifest.json` | Module manifest                                                                      |

## Design notes

**State and events.** On start the module loads `/scenes` and `/screens`, then opens the live socket (`/v1/events`). The socket only announces that something changed; the module then loads both lists again. After the socket opens, the module always loads once more, because changes between the first load and the open produce no event. The content list for "Screen: push content" has no events: it is reloaded along with a refresh at most once a minute, and when a push action is added.

**Rate limiting.** The API allows 120 requests per minute per token. A refresh costs two requests, so refreshes are debounced (250 ms) and spaced at least 2 s apart, also during a burst of events. A 429 is retried after its `Retry-After`. Refreshes run one at a time; a refresh requested while one is running makes it run once more, so a slow, older response never overwrites newer state.

**Connection lifecycle.** Every start (init, config saved) creates a new `Connection` and stops the previous one. A stopped connection ignores its own timers, sockets and responses, so a late close event from an old socket cannot affect a new one. Each `LiveSocket` owns its own timers for the same reason.

**Close codes.**

| Code  | Meaning                                         | Reaction                                                                                                   |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 4011  | Access for this token ended                     | Check at once: a 401 halts, an inactive account is checked every 5 minutes, otherwise reconnect after 30 s |
| 4008  | Another socket with the same token took over    | Wait 30 s before reconnecting                                                                              |
| Other | Network loss, server restart, heartbeat timeout | Reconnect with backoff (1 s doubling to 30 s, reset after 30 s of stable connection)                       |

**Dead connections.** The module sends a ping every 30 s and gives the socket up when no message arrives within 10 s of a ping, because a half-open TCP connection may not report its close for minutes. Node's WebSocket (undici) reports a refused upgrade (for example 401 or 503) only as an `error` event, without a `close`, and the socket would otherwise stay connecting forever: an `error` before `open` is therefore treated as a lost socket.

**Status.** `Ok` requires both loaded state and an open live socket. While the socket is open, a failing refresh only raises a warning and the last known state stays in place. A 401 or a token without screen access halts the connection until the config is saved again. A 401 on a button press halts as well; any other failed press only fails that action, so Companion logs it.

**Definitions.** Action, feedback and preset definitions are only set again when the scene, screen or content list actually changes; setting them on every event makes the Companion UI flicker.

**Presets.** Companion rewrites `$(screenbird:...)` in preset text to the label of the connection, so presets refer to variables that way. Scene and screen names are passed through `buttonText()`, which neutralizes `$(` and `\n` so a name cannot inject a variable or a line break. Text color is black or white by WCAG contrast; the tests check that every preset state reaches at least 4.5:1.

**Security.** The API address must be `https://` and end in `/v1`, so the token never travels unencrypted; the config field regex and `parseApiUrl()` enforce the same rule. The token is stored as a Companion secret.

## License

MIT, see [LICENSE](./LICENSE).
