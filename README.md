# Hopp

Low-latency voice and text chat on servers you run yourself. No central service, no tracking.

## Getting started

```sh
# 1. Start a server (TCP + UDP on port 7777, data saved in ./strom-data)
cargo run -p strom-server --release -- --name "My server"

# 2. Start the desktop app
cd client
npm install
npm run dev
```

In the app, create your Hopp ID, then **+ → Run your own server → Connect to my server**.
The first person to connect from the server's own computer becomes the owner. Everyone
else needs an invite link (`strom://host:port/CODE`) from the owner.

To claim ownership from another computer, use the setup link the server prints when it
starts without an owner.

Headless test client: `cargo run -p strom-voice --example cli -- localhost name [seconds] [--raw] [--mic-test]`

## Security model

- **Hopp ID**: an Ed25519 key pair, encrypted on disk with your password (Argon2id +
  ChaCha20-Poly1305). Servers verify a signed challenge; passwords never leave the computer.
- **Invite-only servers**: invites can expire and have a use limit; the owner can revoke
  them, kick people and ban Hopp IDs.
- **Flood limits**: chat messages, connection attempts per IP and voice packets are rate
  limited; chat files are compacted at startup.
- Not yet: transport encryption (TLS / encrypted voice). People who connect see the
  server's IP address.

## Architecture

| Part | What it does |
|---|---|
| `shared/` | The protocol: JSON lines over TCP for control, binary UDP packets for voice. |
| `server/` | Accounts, invites, bans, channels and chat on disk; relays Opus packets without decoding them. |
| `voice/` | Client library: Hopp ID, control connection, and the audio engine (cpal → RNNoise → Opus, 10 ms frames, FEC → UDP → jitter buffer → mixer). |
| `client/` | Tauri 2 desktop app. Audio runs entirely in Rust; the web view is only UI. |

## Tests

```sh
cargo test --workspace
```

## Code signing

Hopp isn't code-signed yet: signing costs money, and free signing for open-source projects asks for a project that more people already know. The Windows installer is built by [GitHub Actions](.github/workflows/release.yml) from this repository, ready to be signed when that changes. Committer, reviewer and approver: [Marcus](https://github.com/chillscapee-netizen). What Hopp connects to: [Code signing policy](https://hopp-cloud.hoppchat.workers.dev/code-signing.html).

## Licence

Hopp is free software under the [GNU General Public License v3.0](LICENSE): you may use, study, change and share it, and anything you hand out that is built from it stays open under the same licence.
