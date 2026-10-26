## Screenbird

Control your [Screenbird](https://screenbird.app) digital signage screens from Companion: switch all screens to a scene with one button, push content to a single screen or sub-screen, and see on the button what is live.

Requires Companion 4.3 or newer.

### Setup

1. In Screenbird, go to **Settings > Connections > API tokens** and create a token with access **Control screens and scenes**.
2. In Companion, add the Screenbird connection and paste the token.
3. Open the presets: there is a button for every scene in your team.

The token works in the team that was active when you created it. To control screens of another team, create a token while that team is active. Use one token per Companion connection.

The computer running Companion needs outgoing HTTPS and secure WebSocket (WSS) access on port 443 to `api.screenbird.app`. Leave the API address as it is, unless Screenbird support gives you another one. Only `https://` addresses work, so the token never travels unencrypted.

### Actions

- **Scene: go**: show the scene on all its screens. If the scene changed since it went live, pressing it again puts the changes live.
- **Scene: stop**: stop this scene; its screens return to their own content.
- **Scene: next**: go to the scene after the one that was activated last, in the order of the Scenes page.
- **Stop all**: stop all scenes and pushed content. Screen mirroring keeps running.
- **Screen: push content**: show content on one screen or sub-screen, for a number of minutes or until stopped. Pick the content from the list: files, designs, apps, split screens and playlists of the team, newest first.
- **Screen: stop**: stop pushed content or a scene on one screen or sub-screen.

When an action fails (for example because the token has no permission for it), Companion shows it in the connection log.

### Feedbacks

- **Scene is live**, **Scene is partly live**, **Scene changed since it went live**
- **Screen shows**: a scene, pushed content, screen mirroring or normal content
- **Screen is online**

### Button colors of the presets

- **Scene buttons** use the color of the scene in Screenbird:
  - dark: the scene is off
  - full color: the scene is live on all its screens
  - half bright: the scene is partly live (some of its screens show something else)
  - amber with "(changed)": the scene was edited after it went live; press it again to put the changes live
- **Stop per scene**: dark, with the scene name in a light version of its color.
- **Stop per screen**: dark red while a scene or pushed content shows on that screen.
- **STOP ALL** is dark red, **NEXT** shows the name of the scene that comes next.

### Variables

Use them in button text as `$(screenbird:last_scene)` (with the name of your connection if you renamed it):

- `last_scene`: the scene activated last
- `next_scene`: the scene that **Scene: next** starts
- `live_scenes`: the scenes that are live
- `screens_online`, `screens_total`: screens online and in total

Button states update right away through a live connection; the module does not poll. The list of content to push refreshes when you add a push action and after changes on your screens.

### Troubleshooting

- **Authentication failure**: the token is invalid or was revoked. Create a new token in Screenbird and paste it in the connection settings.
- **Insufficient permissions**: the token has no access to screens, or the person who created it lost access. Create a token with access **Control screens and scenes**.
- **Connection failure** that mentions the API address: something answers that is not Screenbird, for example a Wi-Fi login page or a wrong address. Check the network and the API address.
- **Waiting for the live connection** that does not go away: a firewall or proxy may block WebSocket traffic to `api.screenbird.app`. Buttons still work, but their colors only update after a press.
- **No active subscription**: the Screenbird account is inactive. The module checks again every 5 minutes.
- **Bad configuration**: the token or the API address is missing or has the wrong format. Paste the token again; only `https://` addresses ending in `/v1` are accepted.

Scenes are not available for every Screenbird account. Without scenes, the module works with screens only.

More help: [screenbird.app](https://screenbird.app).
