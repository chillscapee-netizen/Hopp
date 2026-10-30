# Fix the seams, not the codecs

The audio stack already has the right parts: RNNoise, AEC3/AGC2 via sonora, Opus with FEC, and an adaptive jitter buffer. Most of the remaining gains come from how those parts connect to Windows, to each other and to the user. Four changes matter most:

- **Read push-to-talk through Raw Input with `RIDEV_INPUTSINK`**, not through Tauri's `RegisterHotKey`-based global-shortcut plugin.
- **Make voice activity a "hybrid" gate** that opens only when the RNNoise speech probability and the signal level agree. Default thresholds: 0.6/0.4 probability hysteresis, 20–30 ms confirmation, 50–100 ms pre-roll, 300 ms hangover.
- **Feed Opus the measured packet loss** instead of a fixed 10%. Also reconsider 10 ms frames: at 100 packets/s they roughly double header overhead and rule out Opus 1.5's LACE/NoLACE decoder enhancement.
- **Choose the Windows audio device yourself.** cpal 0.15 always opens the eConsole default in shared mode, with no hot-plug following and no OS-side resampling.

Most of the remaining recommendations prevent known failures that users notice and blame on the app:

- PTT stops working in admin-elevated games.
- The PTT release delay clips word endings.
- Windows lowers game audio by 80% when the app opens a communications stream.
- A Bluetooth headset drops into "AM radio" hands-free mode.
- A volume change makes echo leak through.
- Unmuting after undeafen does the wrong thing.

Each section gives defaults you can ship. A priority table at the end orders the work. Many Discord defaults could not be checked against primary sources because Discord's help center blocked automated fetches. Where a value rests on third-party guides, the text says so.

## Push-to-talk needs Raw Input, a 200 ms release delay and an elevation warning

The obvious Tauri route is the wrong one for PTT. The `global-hotkey` crate behind `tauri-plugin-global-shortcut` calls `RegisterHotKey`. That API fires only on key-down, so the crate fakes key-up by spawning a thread that polls `GetAsyncKeyState` every 50 ms. Release can therefore lag by **up to ~50 ms**, and each press spawns a thread ([tauri-apps/global-hotkey](https://raw.githubusercontent.com/tauri-apps/global-hotkey/dev/src/platform_impl/windows/mod.rs)). `RegisterHotKey` has three more problems for PTT:

- It fails if another app already owns the same key combination.
- Windows reserves F12 and Win-key combinations ([Microsoft Learn: RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)).
- It takes keyboard virtual-key codes only, so it cannot bind mouse side buttons.

The notes also say the hotkey is consumed, so the game never receives it. That behaviour is widely reported, but no Microsoft documentation states it. Low-level hooks (`WH_KEYBOARD_LL`) are not much better. If the callback exceeds `LowLevelHooksTimeout` (capped at 1000 ms since Windows 10 1709), Windows 7 and later silently remove the hook, with "no way for the application to know". Microsoft's own advice is that such applications "should monitor raw input instead" ([Microsoft Learn: LowLevelKeyboardProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)).

**Copy Mumble's design.** Current Mumble registers keyboard, mouse, joystick and gamepad usages with `RegisterRawInputDevices` and `RIDEV_INPUTSINK`, and polls Xbox controllers through XInput. It installs no hook and consumes no input ([Mumble GlobalShortcut_win.cpp](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/GlobalShortcut_win.cpp)). Do the same:

- Run a dedicated input thread that owns a message-only window.
- Register with `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY`, so input arrives in the background and hot-plug events are reported.
- Do not use `RIDEV_EXINPUTSINK`. It delivers background input only when the foreground app has not registered for raw input itself, and many games do register ([Microsoft Learn: RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)).
- Poll XInput every 10–16 ms for Xbox pads.

Raw Input only observes. It cannot swallow the game's key, cannot slow the system's input chain, and injects nothing into the game. That also makes it the lowest-risk option with kernel anti-cheats. No credible source shows Vanguard, EAC, BattlEye or FACEIT objecting to voice-app input listeners; Vanguard's 2020 blocking dispute was about vulnerable kernel drivers ([PC Gamer](https://www.pcgamer.com/the-controversy-over-riots-vanguard-anti-cheat-software-explained)). The real risks are DLL-injected overlays and synthetic input ([DEF CON 33 slides](https://game-research.github.io/presentations/2025-08-10-defcon33-playing-dirty-without-cheating.pdf)), so never call `SendInput`.

**Store keyboard binds as scan code plus the E0 flag.** At display time, name them with `GetKeyNameText`, so a Swedish layout shows "Ö" where a US layout shows ";". Mumble does this, and it hand-maps `VK_PAUSE` because `MapVirtualKey` cannot map it ([Mumble GlobalShortcut_win.cpp](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/GlobalShortcut_win.cpp)). For the bind model and capture flow:

- Let one action have several binds (a key and Mouse 4, for example).
- Treat modifiers as ordinary inputs.
- Process every button transition in each `RAWMOUSE` message.
- Warn when the user binds Left or Right click.
- Rebuild the pressed-key set when the app regains focus or a device changes, and periodically check it against `GetAsyncKeyState`. A key-up missed during Alt-Tab or a UAC prompt otherwise leaves the mic stuck open.

**Elevated games are the most common real failure.** Windows' User Interface Privilege Isolation (UIPI) stops a normal-privilege process from seeing input aimed at a higher-integrity window. Raw Input, hooks and `GetAsyncKeyState` are all blocked. The only fixes are to run the voice app as administrator or to ship a signed `uiAccess=true` build installed under Program Files ([Microsoft Q&A](https://learn.microsoft.com/en-in/answers/questions/2259268/blocking-mouse-hook-for-a-vb-net-application-when); [UAC UIAccess policy](https://technet.microsoft.com/en-us/library/jj852244.aspx)). Discord's standard advice is to run Discord as administrator too ([DriverEasy](https://www.drivereasy.com/knowledge/solved-discord-push-to-talk-not-working)). Don't fail silently. Detect when the foreground process runs at a higher integrity level; access denied on `OpenProcess` is itself a signal. Then show a notice with a "Restart as administrator" button. Don't elevate by default: a networked app that hosts a WebView should not run elevated.

**Release delay should default to about 200 ms, adjustable from 0 to 2000 ms.** Discord's RPC API caps the delay at 2000 ms ([discord-api-types](https://discord-api-types.dev/api/discord-api-types-v10/interface/RPCVoiceSettingsMode)). Third-party guides put Discord's default at **20 ms** ([Beebom](https://beebom.com/how-enable-configure-push-to-talk-discord/)), and a Discord-like client has an open bug that "end of phrase gets cut off" without a longer delay ([syrnike13-app #163](https://github.com/syrnike13/syrnike13-app/issues/163)). The 200 ms figure is a design choice, not a sourced default. To avoid clipping the first syllable:

- Keep the capture stream open while the user is in a channel and gate it, rather than opening the device on press.
- Send a 40–100 ms pre-roll buffer when PTT goes down.
- Encode one more frame and apply a short fade at release.

Mumble enables PTT on/off click cues by default but not voice-activity cues, and it plays a separate cue when you talk while muted ([Mumble Settings.h](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/Settings.h)). Copy both, and play the cues locally only.

Offer separate bindable actions, as Discord does: PTT, priority PTT (Discord's priority speaker works only in PTT mode ([Discord](https://support.discord.com/hc/da/articles/360011876531-Setting-up-Priority-Speaker))), push-to-mute, toggle mute, toggle deafen and toggle input mode. Mumble's optional double-tap latch is another option ([Mumble Settings.h](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/Settings.h)).

Finally, treat the listener as the keylogger it technically is:

- Register for keyboard input only while a global bind or bind capture is active.
- Check each event against a small set of bound codes and discard everything else at once.
- Send only `ptt_state_changed(bool)` across Tauri's IPC.
- Say so plainly in settings.

## A hybrid gate fixes both failure modes of voice activity

Every major app layers a level gate on top of a speech classifier. TeamSpeak names the combination: "Automatic" detects voice regardless of loudness, "Volume Gate" is a plain level threshold, and "Hybrid" requires both ([TeamSpeak 3.5.1 notes](https://community.teamspeak.com/t/teamspeak-3-client-3-5-1/4360/2)). The app already has the two halves: RNNoise's per-frame speech probability, and a manual dB threshold with 6 dB hysteresis. Each half fails differently. A probability-only gate opens for a TV or a roommate talking quietly in the background. A level-only gate opens for keyboard clacks and desk bumps. Requiring both closes both holes, so **make Hybrid the default**. Discord's "automatic sensitivity" reportedly struggles with heavy background noise and large swings in speaking volume ([TheWindowsClub](https://www.thewindowsclub.com/discord-automatically-determines-input-sensitivity-of-mic)). In Hybrid mode, set the level half relative to a slowly tracked noise floor, for example the 10th percentile of frame RMS over 5–10 s plus about 10 dB, and not as a fixed number.

**No published standard threshold exists for RNNoise's VAD.** The defaults below therefore borrow from Silero VAD's streaming logic: enter at 0.5 and exit 0.15 lower, with 100 ms minimum silence and 30 ms of speech padding ([silero-vad utils_vad.py](https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/utils_vad.py)). They also borrow Mumble's 200 ms voice hold ([Mumble Settings.h](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/Settings.h)). RNNoise's per-frame probability is spiky, so smooth it before thresholding, and require a few consecutive frames before opening; that rejects single-frame keyboard clicks, which are a known VAD false positive ([VAD troubleshooting notes](https://notebook-dg9.pages.dev/kb/ai/vad/troubleshooting/)). The current 30 ms pre-roll leaves almost no margin once 20–30 ms of confirmation is added, and soft fricative onsets such as "s" and "f" get clipped. Raise it. Validate the probability thresholds against recordings of your own users' rooms; they are starting points.

| Parameter | Current | Recommended default | User range |
|---|---|---|---|
| Mode | Auto (probability) or manual dB | **Hybrid** (probability AND level ≥ noise floor + ~10 dB) | Auto / Hybrid / Manual |
| Probability open / close | n/a | **0.6 / 0.4**, after an EMA with α ≈ 0.3–0.5 | Advanced only |
| Confirmation before opening | n/a | **2–3 frames (20–30 ms)** | — |
| Pre-roll | 30 ms | **50–100 ms** | — |
| Hangover | 300 ms | **300 ms** (Mumble uses 200) | 100–1000 ms |
| Manual threshold hysteresis | 6 dB | 6 dB | — |

**Keep RNNoise as the VAD and as the default noise suppressor.** A second ML VAD buys little, since RNNoise's probability comes free with noise suppression at 48 kHz. Silero is the accuracy reference. It is MIT-licensed, about 2 MB, and processes a chunk in under 1 ms on one thread ([silero-vad](https://github.com/snakers4/silero-vad)), and it has a Rust wrapper on `ort` ([voice_activity_detector](https://docs.rs/crate/voice_activity_detector)). Using it would add ONNX Runtime and a 48→16 kHz resampler. TEN VAD is smaller and faster by its vendor's own numbers, but its license is "Apache 2.0 with additional conditions", including a non-compete clause ([TEN VAD](https://github.com/TEN-framework/ten-vad); [wavekat-vad docs](https://docs.rs/wavekat-vad)). Avoid it unless legal review clears it.

**The quality upgrade is DeepFilterNet3, offered as an opt-in "High" mode.** It is native Rust, dual MIT/Apache, full-band 48 kHz, and runs at a real-time factor of 0.19 on a single notebook core ([arXiv 2305.08227](https://arxiv.org/abs/2305.08227); [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)). One study measured RNNoise at about 0.001 RTF against 0.081–0.088 for DeepFilterNet3 ([Sinergi](https://publikasi.mercubuana.ac.id/index.php/sinergi/article/view/21917/11680)), so RNNoise is roughly two orders of magnitude cheaper. DeepFilterNet3's reported quality advantage, about 3.17 wideband PESQ against roughly 2.8–3.0 for RNNoise-era models, comes from an aggregator, not from the paper's own table ([EmergentMind](https://www.emergentmind.com/topics/deepfilternet-framework)). That mirrors Discord's split between "Standard" suppression and Krisp. Discord turns Krisp off silently when the CPU can't keep up, and users dislike that ([Discord Krisp FAQ](https://support.discord.com/hc/hi-in/articles/360040843952-Krisp-FAQ); [community thread](https://support.discord.com/hc/sv/community/posts/1500000524582-Option-to-stop-Krisp-Noise-suppression-turning-off-automatically?page=2)). Time each DeepFilterNet3 frame, and if it overruns, fall back to RNNoise with a visible notice.

Add a suppression-strength control that caps attenuation, defaulting to about 30–40 dB. Mumble's Speex default is −30 dB ([Mumble Settings.h](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/Settings.h)), and capping attenuation reduces "underwater" artefacts.

**"You're muted" detection should be stricter, slower and quieter than Zoom's or Teams'.** Both show the warning when you speak while muted, and users complain they cannot turn it off ([Zoom community](https://community.zoom.com/t5/Meetings/Hide-microphone-muted-notification/td-p/19879); [Tech Community](https://techcommunity.microsoft.com/discussions/microsoftteams/false-positive-teams-cant-hear-you/2876577)). Recommended behaviour:

- Keep capture and RNNoise running while muted, but transmit nothing.
- Trigger only when the smoothed probability is at least 0.7 and the level clears the user's threshold for 500–1000 ms within a 2 s window.
- Show a non-modal toast, at most once per 30–60 s.
- Make it possible to switch the notice off.

There is a trade-off: keeping capture open holds a classic-Bluetooth headset in hands-free mode (see the device section).

## AEC3, AGC2 and the processing order are mostly right, but four integration details decide quality

**Leave AEC3 on all the time.** Its transparent-mode classifier "reduces echo suppression" when there is no echo path, as with a headset ([WebRTC transparent_mode.cc](https://webrtc.googlesource.com/src/+/main/modules/audio_processing/aec3/transparent_mode.cc)). sonora exposes the conservative `Legacy` classifier as default and an `Hmm` variant documented as "generally more responsive" ([sonora config.rs](https://docs.rs/sonora/latest/src/sonora/config.rs.html)). Start with Legacy, try Hmm, and keep a user toggle for people who hear artefacts on headsets. sonora is a port of WebRTC M145 with later fixes, and it does **not** include the neural residual echo estimator ([sonora](https://github.com/dignifiedquire/sonora)). Its impact is unmeasured, so test echo with laptop speakers specifically.

AEC3 quality depends on four integration details:

1. **Feed AEC3 the final, post-mix, post-volume render signal.** AEC3 models a linear echo path. If the reference is taken before per-user volume or the app's own output volume, every slider move looks like a sudden echo-path change and echo leaks until the filter re-converges. sonora keeps WebRTC's `set_playout_volume` hook for this case ([sonora AudioProcessing](https://docs.rs/sonora/latest/sonora/struct.AudioProcessing.html)).
2. **Call `set_stream_delay_ms` on every capture frame with a stable estimate.** sonora says the call is "required when echo cancellation is enabled" and clamps values to 0–500 ms ([sonora AudioProcessing](https://docs.rs/sonora/latest/sonora/struct.AudioProcessing.html)). Use output buffer latency plus input buffer latency plus any queue in between. A constant 40–80 ms is a workable fallback on Windows shared mode, because the matched-filter estimator refines the value you give it ([echo_canceller3_config.h](https://webrtc.googlesource.com/src/+/main/api/audio/echo_canceller3_config.h)). A value that jumps around forces repeated re-convergence.
3. **Feed render frames continuously, including silence, in 480-sample frames, and never concurrently with capture.** The API takes `&mut self` ([sonora docs](https://docs.rs/sonora/latest/sonora/)).
4. **Set `maximum_internal_processing_rate` to `Rate48kHz`.** sonora defaults to `Rate32kHz` ([sonora config.rs](https://docs.rs/sonora/latest/src/sonora/config.rs.html)), so a 48 kHz pipeline otherwise goes through the band-split for content above 16 kHz.

When the mic and speakers are on different devices, say a USB mic with HDMI audio, their clocks drift apart. sonora's docs say nothing about drift compensation, so rate-match the render FIFO with an adaptive resampler or rubato's `Slip` mode.

**For AGC2, use the stock adaptive-digital defaults and leave the OS microphone volume alone.** Upstream WebRTC and sonora agree on these values ([WebRTC audio_processing.h](https://webrtc.googlesource.com/src/+/main/api/audio/audio_processing.h); [sonora config.rs](https://docs.rs/sonora/latest/src/sonora/config.rs.html)):

- headroom 5 dB
- maximum gain 50 dB
- initial gain 15 dB
- at most 6 dB/s of gain change
- output noise capped at −50 dBFS

sonora ships `adaptive_digital: None`, so it must be enabled explicitly. Keep `input_volume_controller: false`. Turning it on lets the app change the Windows mic level, which affects every other app and fights users' manual settings. Implement the user's "input gain" slider as a constant `capture_level_adjustment.pre_gain_factor`, not as a time-varying gain before AEC. If quiet rooms show noise being amplified, lower maximum gain to about 30 dB.

**Run noise suppression once.** WebRTC's documented capture order is high-pass → AEC3 → noise suppression → AGC2 ([Fora Soft](https://www.forasoft.com/learn/audio-for-video/articles-audio/webrtc-audio-pipeline-end-to-end)). The upstream source was not checked directly. RNNoise belongs in the noise-suppression slot, after echo cancellation, so it never sees far-end echo as speech. sonora also has its own Wiener-filter suppressor, defaulting to Moderate (about 12 dB) ([sonora config.rs](https://docs.rs/sonora/latest/src/sonora/config.rs.html)). Stacking it on RNNoise is unvalidated double processing, and the research suggests disabling it. Measure the voice-activity gate level **after noise suppression but before AGC**. Otherwise AGC lifts quiet noise above the threshold and defeats the gate. The chain is:

capture → HPF → AEC3 → RNNoise (NS + VAD probability) → AGC2 → gate → Opus

## Opus should adapt to measured loss, and 20 ms frames deserve a fresh look

The current encoder settings are 64 kbps mono, VOIP, voice signal, complexity 10, in-band FEC = 1 and `packet_loss_perc` = 10. Tracing the libopus encoder source shows these settings do what you intend. A 10 ms frame costs 3000 bps of "equivalent rate", which leaves about 61 kbps. The VOIP bias raises the CELT-only threshold to 72 kbps, so the encoder stays in **SILK/hybrid mode**. A 10% expected loss also clears the rule that forces SILK when FEC is enabled. The low-bitrate redundancy (LBRR) stream, Opus's in-band FEC, is therefore active. With FEC on, hybrid mode gives SILK **50 kbps of the 64**, against 38 without FEC ([libopus opus_encoder.c](https://github.com/xiph/opus/blob/main/src/opus_encoder.c)). Ignore secondary sites that claim CELT-only above 32 kbps; the source code contradicts them.

**The fixed 10% loss figure is the weak point.** LBRR covers only the immediately preceding frame ([RFC 8854](https://www.muonics.com/rfc/rfc8854.php)). Its rate thresholds scale with the stated loss, and above 5% loss the encoder lowers audio bandwidth until FEC fits ([opus_encoder.c](https://github.com/xiph/opus/blob/main/src/opus_encoder.c)). A fixed 10% wastes bits on clean links and under-protects on bad ones. libwebrtc sends FEC only after RTCP reports loss and sets the expected loss in libopus; until then, "no FEC data is ever sent even if FEC is enabled" ([discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/aMKG3AQVLd8)). Drive `OPUS_SET_PACKET_LOSS_PERC` from receiver reports, smoothed over 1–2 s and clamped to 0–25%. Then lower the bitrate when loss or RTT signals congestion. 64 kbps is generous for speech; 40–48 kbps loses nothing audible, and the extra mainly buys redundancy.

**The 10 ms frame size has costs.** It saves about 10 ms of latency. Against that:

- **Packet overhead roughly doubles.** About 40 bytes of IPv4/UDP/RTP header per packet comes to roughly 32 kbps at 100 packets/s, against 16 kbps at 50 packets/s. This is the research team's own arithmetic, and the app's actual header size will differ.
- **Opus 1.5's LACE/NoLACE decoder enhancement is "currently only applied when the frame size is 20 ms"** ([Opus 1.5 demo](https://opus-codec.org/demo/opus-1.5/)).

20 ms is the WebRTC norm. Keep 10 ms only if the end-to-end latency budget really needs it, and measure before deciding.

**Deep PLC is the cheapest real upgrade, and DRED is the bigger one.** libopus 1.5 added Deep PLC, a neural loss concealment that runs only in the decoder. It needs a build with `--enable-deep-plc` (about 1 MB) and decoder complexity of at least 5, costs about 1% of a laptop core at high loss, and changes nothing in the bitstream, so it has no compatibility risk ([libopus 1.5 release](https://opus-codec.org/release/stable/2024/03/04/libopus-1_5.html)). DRED (Deep REDundancy) carries up to about a second of neural redundancy for 12–32 kbps of overhead. The Opus team says that "when DRED is combined with LBRR, the quality approaches that of the no-loss case" ([Opus 1.5 demo](https://opus-codec.org/demo/opus-1.5/)). libopus 1.6 (December 2025) brought a "significant improvement" to DRED, and 1.6.1 shipped in January 2026 ([opus-codec.org news](https://www.opus-codec.org/news)). DRED was not standardised in 1.5, so pin the same libopus version on every client. `opusic-c` exposes the DRED API ([opusic-c dred.rs](https://docs.rs/opusic-c/1.5.5/src/opusic_c/dred.rs.html)). It was not verified whether the common `opus`/`audiopus` crates bundle libopus 1.5 or later, or whether they expose decoder complexity; check the binding before planning this work.

Leave DTX off while the app already gates transmission with VAD or PTT; it adds little and complicates loss accounting. Music should get its own encoder (Audio application, music signal, stereo, 96–128 kbps, 20 ms frames, FEC = 2 or off) and should bypass AEC, noise suppression and AGC.

## The jitter buffer needs a percentile, asymmetric adaptation and gentle drops

The planned target is 1 + ceil(2.5·J/10 ms) frames, clamped to 2–12 frames (20–120 ms), where J is the RFC 3550 jitter estimate. That sits in the same range as WebRTC NetEQ, which starts at **80 ms**. But NetEQ sets its target as the **95th percentile of a forgetting histogram** of arrival delays (forget factor 0.983), plus a reorder optimizer ([delay_manager.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/neteq/delay_manager.cc)). RFC 3550's jitter is a smoothed mean deviation, so it underestimates the heavy-tailed bursts typical of Wi-Fi. Track a decaying p95 of arrival delay over the last 2–10 s and use the larger of the two estimates. Make adaptation asymmetric: raise the target immediately on an underrun, and lower it only after several seconds of stable jitter. Mumble's defaults show how far down this can go on good links: a 1-frame (10 ms) jitter margin and 5 frames of output delay ([Mumble Settings.h](https://github.com/mumble-voip/mumble/blob/master/src/mumble/Settings.h)). A start target of 2–4 frames is reasonable.

**Shed excess delay one frame at a time, preferably in silence.** NetEQ never dumps a whole backlog. When the buffer runs above target plus its window it "accelerates", removing a pitch period, and it fast-accelerates only at 4× that limit. It never time-stretches right after a concealment, and it decodes from the buffer only once the buffer reaches 50% of target ([decision_logic.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/neteq/decision_logic.cc)). The current "drop to target when above target + 6" should instead work like this:

1. **Drop one low-energy frame** (below about −50 dBFS) when the buffer is above target. This is inaudible in conversation.
2. **Drop with a 2–5 ms crossfade** only if the buffer stays high for more than about 1 s of continuous speech.
3. **Pitch-synchronous accelerate and expand**, about 150–300 lines of Rust, only if clicks are still audible.

The `wsola` crate exists but is young ([docs.rs wsola](https://docs.rs/crate/wsola/0.1.0)). The same mechanism absorbs clock drift between sender and receiver for free, as long as the output device callback pulls one frame per tick. NetEQ likewise measures arrival times in its own playout ticks for exactly this reason ([NetEQ g3doc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_coding/neteq/g3doc/index.md)). At 100 ppm of drift, that is about one dropped frame per 100 s.

**Concealment order: FEC first, then decoder PLC, then a fade.** If packet n is missing and n+1 is already buffered, decode n+1 with `decode_fec=1`, passing a `frame_size` equal to exactly the missing duration. Otherwise decode with NULL data. Always feed the decoder every lost frame in order ([Opus decoder API](https://opus-codec.org/docs/opus_api-1.5/group__opus__decoder.html)). The 2-frame minimum target is what keeps one frame of look-ahead available for FEC. That already puts the app ahead of Mumble, which passes FEC = 0 and never uses in-band FEC ([AudioOutputSpeech.cpp](https://github.com/mumble-voip/mumble/blob/master/src/mumble/AudioOutputSpeech.cpp)). After about 5 consecutive concealed frames, fade out and reset. Opus's own PLC already attenuates over consecutive losses.

**Playback features.** Recommended defaults:

| Feature | Default | Basis |
|---|---|---|
| Per-user volume | 0–200%, dB-mapped (200% = +6 dB), smoothed over 10–20 ms, separate per-user mute | Discord's 200% cap ([community](https://support.discord.com/hc/fr/community/posts/360031044891-Allow-Discord-volume-to-be-increased-beyond-what-s-currently-possible)) |
| Mixing | Sum in f32 with no 1/N scaling; soft limiter at −1 dBFS on the master bus only when two or more streams are active | WebRTC FrameCombiner ([frame_combiner.cc](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_mixer/frame_combiner.cc)); AGC2 limiter threshold ([agc2_common.h](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/agc2/agc2_common.h)) |
| Attenuate other apps | Off; 50% when enabled | Mumble's `fOtherVolume` ([Settings.h](https://github.com/mumble-voip/mumble/blob/master/src/mumble/Settings.h)) |
| Resampling | Mix at 48 kHz; one high-quality resampler at the end, not one per peer | Mumble resamples per speaker with Speex quality 3 ([AudioOutputSpeech.cpp](https://github.com/mumble-voip/mumble/blob/master/src/mumble/AudioOutputSpeech.cpp)) |
| Auto-level other speakers | Off. Optional, speech-gated, target −23 to −20 dBFS, clamped to ±12 dB, 2–5 s smoothing | Engineering inference |
| Stereo seating | Constant-power pan per user, later | Engineering inference |

## Windows device handling is where cpal leaves the most work

**cpal 0.15.3 opens the eConsole default device, in shared mode, without the auto-convert flag.** The research team confirmed this in the local registry source. Three consequences follow:

- Requesting any sample rate other than the device's mix format fails.
- Removing a device surfaces only as a `DeviceNotAvailable` stream error.
- A change of Windows default device is never followed. The cpal pull request for automatic stream routing was closed unmerged ([cpal PR #754](https://github.com/RustAudio/cpal/pull/754)).

Microsoft assigns "Chat and VoIP" to the eCommunications role ([Microsoft Learn: Device Roles](https://learn.microsoft.com/en-us/windows/win32/coreaudio/device-roles)). cpal 0.17.0 exposes `IMMDevice` ([cpal CHANGELOG](https://raw.githubusercontent.com/RustAudio/cpal/master/CHANGELOG.md)), and the `windows` crate can resolve any role directly. The device list should have three kinds of entry:

- "Default (Windows)", which follows the eConsole default.
- "Default communication device", which follows eCommunications.
- Explicit devices, stored by endpoint ID, with the friendly name as a fallback.

**Opening the communications device has a side effect users hate.** Windows treats that stream as a "communication stream" and, by default, lowers every other app's volume by **80%** ([Microsoft Learn: Default Ducking Experience](https://learn.microsoft.com/en-us/windows/win32/coreaudio/stream-attenuation)). This is the familiar complaint that "Discord lowers my game volume". Call `IAudioSessionControl2::SetDuckingPreference(TRUE)` to opt out, and offer the in-app attenuation from the playback table instead. It is unverified whether Windows ducks only for streams opened through the eCommunications role, or for any stream on whichever device holds that role. Test both.

For hot-plug, implement `IMMNotificationClient`. Its callbacks "must be nonblocking" ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient)), so post a message only and rebuild the cpal stream on another thread. Debounce for 250–500 ms, because Bluetooth devices fire several events per change. Run the internal pipeline at 48 kHz mono f32, and convert from the device mix format with rubato. Use its `Fft` resampler for a fixed 44.1→48 kHz ratio, or its `Async` resampler when the ratio must track drift. Its realtime-safe `process_into_buffer` path allocates nothing ([docs.rs rubato](https://docs.rs/rubato/latest/rubato/)).

**Classic Bluetooth headsets need a warning, not a fix.** Opening a classic-Bluetooth headset's microphone forces the hands-free profile, and all output from that headset drops to mono, low-quality audio that Microsoft compares to "AM radio". Windows 11 24H2 with LE Audio hardware avoids this: stereo output stays on and the mic runs at 32 kHz ([TechRadar](https://www.techradar.com/computing/windows/windows-11-is-finally-fixing-poor-sound-quality-with-bluetooth-headphones-and-pc-gamers-will-be-particularly-happy)). The app should:

- Warn when the selected input is a hands-free endpoint.
- Suggest a separate mic, with output on the headset's "Headphones" endpoint.
- Never open capture before the user joins voice.

**The settings and audio UX should copy established conventions:**

- **Mute and deafen semantics.** Deafen implies mute. Undeafen restores the mic only if the deafen caused the mute. Unmuting while deafened also undeafens. This is Mumble's `unmuteOnUndeaf` logic ([Mumble MainWindow.cpp](https://raw.githubusercontent.com/mumble-voip/mumble/master/src/mumble/MainWindow.cpp)). Server mute and server deafen are separate states that the user cannot override.
- **Mic test.** Offer two modes. The first is live loopback through the full processing chain, as Discord's "Let's Check" does ([Discord support](https://support.discord.com/hc/en-us/articles/360020641332)), with a "use headphones" warning, since loopback through speakers feeds back ([technobezz](https://www.technobezz.com/how-to-fix-discord-mic-not-working-when-the-test-works)). The second is "record 5 s, then play back" through Opus encode and decode, which is safe on speakers.
- **Level meter.** Use a dBFS scale from −60 to 0 with the threshold marker dragged on the same scale. Use fast attack with about 300 ms release, a 1 s peak hold and a clip mark above −1 dBFS. Show the gate state as a label as well as a color. In PTT mode, show a hint, because "the mic test works but nobody hears me" is a classic PTT confusion ([discordlabs FAQ](https://discordlabs.pages.dev/faqs/why-cant-my-friends-hear-me-on-discord)).
- **Notification sounds.** Give each sound its own toggle, add a master switch, and add the separate notification-volume slider that Discord users keep asking for ([Discord feedback](https://support.discord.com/hc/de/community/posts/4579320100631--Request-Setting-to-Mute-All-Notification-Sounds-At-Once)). Silence join and leave sounds while deafened by default.
- **QoS toggle.** Mark voice packets through qWAVE's `QOSTrafficTypeVoice` (DSCP 56) ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/desktop/api/qos2/ne-qos2-qos_traffic_type)). Windows ignores raw `IP_TOS` settings, and Group Policy can zero app-set markings ([Microsoft](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/cc736031(v=ws.10))). Make it fail silently, and expect no benefit across the public internet.

## Prioritized recommendations

| Priority | Change | Why |
|---|---|---|
| **P0** | Raw Input + XInput for PTT; drop `RegisterHotKey` | Up to 50 ms release lag, no mouse buttons, hotkey conflicts |
| **P0** | Elevated-game detection with a "Restart as administrator" prompt | Most common PTT failure; otherwise silent |
| **P0** | Feed AEC3 the post-mix, post-volume reference; stable `set_stream_delay_ms`; 48 kHz internal rate | Echo leaks on volume changes; needless band-split |
| **P0** | Opt out of Windows ducking; resolve devices yourself; `IMMNotificationClient` hot-plug | 80% game-volume drop; devices not followed |
| **P0** | Correct mute/deafen semantics; PTT release delay 200 ms (0–2000) | User expectations; clipped word endings |
| **P1** | Hybrid VAD (0.6/0.4, 20–30 ms confirmation, 50–100 ms pre-roll, 300 ms hangover) | Keyboard and background-voice false triggers |
| **P1** | Dynamic `packet_loss_perc` from receiver reports, plus bitrate adaptation | Fixed 10% mis-sizes FEC |
| **P1** | p95 jitter target, asymmetric adaptation, single-frame silence-aware drops | Wi-Fi bursts, audible drops |
| **P1** | AGC2 adaptive digital on; OS mic volume untouched; sonora NS off when RNNoise runs | Natural levels without side effects |
| **P1** | Mic test (loopback and record) and dBFS meter with threshold | Self-service setup |
| **P2** | Libopus ≥1.5 with Deep PLC (decoder complexity ≥5) | Cheap, compatible loss concealment |
| **P2** | Evaluate 20 ms frames | Lower overhead; enables LACE/NoLACE |
| **P2** | DeepFilterNet3 "High" noise suppression with visible fallback | Quality tier above RNNoise |
| **P2** | Bluetooth hands-free warning; "speaking while muted" toast; notification-sound matrix; QoS toggle | Polish |
| **P3** | DRED (same libopus 1.6 on all clients), pitch-synchronous time-stretch, stereo seating, auto-levelling | Further gains, more effort |

## Conclusion

This stack does not need better algorithms. It needs its algorithms connected to each other correctly. Five such connections recur through this report: the AEC reference and the volume sliders, the VAD gate and AGC, FEC and the measured loss rate, the jitter target and Wi-Fi's long tail, and cpal's device role and Windows ducking. Each is a place where a well-chosen component underperforms because of what sits next to it. The same holds on the input side. PTT reliability depends on Windows integrity levels and the choice of input API, and has little to do with the hotkey library.

Three uncertainties should shape testing:

- Discord's exact defaults remain third-party claims.
- Whether the missing neural residual echo estimator in sonora matters is unmeasured.
- The 0.6/0.4 RNNoise thresholds are transplanted from Silero.

Build a small corpus before tuning: speaker-echo, keyboard and quiet-speaker recordings, plus lossy-link traces. On these questions it will outperform any further literature review.
