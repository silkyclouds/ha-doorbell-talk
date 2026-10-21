# ha-doorbell-talk

A Home Assistant dashboard card with live view and hold-to-talk two-way audio for a doorbell camera. It speaks WebRTC to the go2rtc that ships with Home Assistant, from the browser, through the normal websocket. No add-on, no YAML, no extra server.

I built it for a Reolink Video Doorbell WiFi, after finding that the official app was the only place where I could talk to the person at the door.

## Install

Open the Terminal & SSH add-on (Settings > Add-ons) and run:

```sh
curl -fsSL https://raw.githubusercontent.com/silkyclouds/ha-doorbell-talk/main/install.sh | sh
```

The script copies one file into `/config/www/ha-doorbell-talk/` and prints the URL to register. It is about 100 lines: read it first if you like, and pin a release with `| sh -s -- --ref v1.0.0`.

Then, two steps in the interface:

1. Settings > Dashboards > three dots > Resources > Add resource. Paste the URL the script printed (it ends with `?v=` and a short hash) and choose "JavaScript module".
2. Edit a dashboard, add a manual card:

```yaml
type: custom:doorbell-talk-card
entity: camera.front_fluent
quick_replies: select.front_play_quick_reply_message
```

Prefer to skip step 1? Add `--register` (`sh -s -- --register`): the script stops Home Assistant, adds the resource to `.storage/lovelace_resources` (a backup is kept next to it) and starts Home Assistant again. That is a restart, so choose a quiet moment. It does nothing for dashboards in YAML mode.

Update by running the same command again. Remove with `sh -s -- --uninstall`.

## Options

| Option | Required | What it does |
| --- | --- | --- |
| `entity` | yes | The camera. Use the stream entity of your doorbell. |
| `name` | no | Card title. Defaults to the entity's name. |
| `quick_replies` | no | A `select` entity listing prerecorded replies (Reolink: `select.<name>_play_quick_reply_message`). Each option becomes a button. |

## What you need

- A camera that go2rtc can serve over WebRTC. Home Assistant OS ships go2rtc, and `default_config:` turns the integration on by itself. I never wrote a go2rtc configuration.
- To talk, a camera whose RTSP stream offers a backchannel. Mine does (audio, sendonly, PCMU/8000). The live view works with any camera WebRTC can serve; the voice part depends on the camera.
- HTTPS for the microphone. Browsers only expose `navigator.mediaDevices` in a secure context, so over `http://192.168.x.x` the live view works and the Talk button explains why it cannot open the microphone. Open Home Assistant through your https address (Nabu Casa, a reverse proxy, a tunnel). On the iPhone I point the Companion app at that address.

Tested with: Home Assistant 2026.10.2, the Reolink integration with the stream protocol set to RTSP, a Reolink Video Doorbell WiFi on firmware v3.0.0.6460. The call logic is the one my own dashboard runs every day on an iPhone (Companion app). This card was checked in desktop Chrome over http (live view, then reconnecting with the return channel and a silent microphone) and by the unit tests. Nothing else has been tried.

## How it works

The card asks Home Assistant for the camera's WebRTC configuration (`camera/webrtc/get_client_config`), sends an offer through `camera/webrtc/offer`, and passes ICE candidates with `camera/webrtc/candidate`. Home Assistant forwards everything to go2rtc, which pulls the camera's RTSP stream.

Voice goes the other way through the same connection. The offer contains an audio sender holding a silent track; pressing Talk swaps the microphone into it with `replaceTrack`, releasing swaps the silence back. No renegotiation happens during a conversation.

Two details cost me time:

- On the Reolink doorbell, opening the return channel puts it in talk mode, and in that mode its quick replies fail with `QuickReplyPlay ... -17`. So the call starts listen-only. The first press on Talk reconnects with the return channel, which takes about two seconds. If you tap a quick reply while talk mode is on, the card drops the return channel, waits 1.5 seconds, retries the reply up to four times, then goes back to listen-only.
- Safari leaves an AudioContext suspended unless it is created during a tap, so the card creates it inside the Talk press.

## Limits

- I only use it at home. The media goes directly between your device and go2rtc, so away from home it needs go2rtc's WebRTC port to be reachable or a TURN server. I have not set either up (I use the Reolink app when I am out), so I cannot say how that goes.
- The call is started by hand with the Live button. It does not pop up when someone rings.
- Other doorbells and cameras may behave differently around talk mode and the backchannel.

## Troubleshooting

- "The microphone needs https": open Home Assistant through an https address, see above.
- The card is unknown: the resource is missing or the browser cached the old page. Check Settings > Dashboards > Resources, then reload with the cache bypassed. If `/config/www` did not exist before the install, restart Home Assistant once so it serves `/local/`.
- Picture but no voice at the door: check that your camera's stream has a backchannel, and that the integration uses its RTSP stream.
- A quick reply fails once with `-17` and works on the second try: that is the talk-mode behaviour above, handled by the retries.

## Development

```sh
npm test
```

Runs the card's unit tests with Node's built-in runner (no dependencies) and the installer tests (needs `jq`).

## License

MIT
