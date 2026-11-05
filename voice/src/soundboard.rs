//! The soundboard: short sounds everyone in the voice channel or call hears, made here
//! (no files to download), at the voice rate.

use strom_shared::SAMPLE_RATE;

/// The sounds, by name: (name, what it's called in the app, its emoji).
pub const SOUNDS: &[(&str, &str, &str)] = &[
    ("ding", "Ding", "🔔"),
    ("tada", "Ta-da", "🎉"),
    ("horn", "Air horn", "📯"),
    ("drums", "Ba-dum-tss", "🥁"),
    ("boing", "Boing", "🌀"),
    ("sad", "Sad trombone", "🎺"),
    ("cheer", "Cheer", "👏"),
    ("pop", "Pop", "🫧"),
];

const RATE: f32 = SAMPLE_RATE as f32;

fn samples(seconds: f32) -> usize {
    (seconds * RATE) as usize
}

/// A note: a tone with a soft start and a fade, added into `out` from `at` seconds.
fn note(out: &mut [f32], at: f32, freq: f32, length: f32, volume: f32, wave: fn(f32) -> f32) {
    let start = samples(at);
    for i in 0..samples(length) {
        let Some(s) = out.get_mut(start + i) else { break };
        let t = i as f32 / RATE;
        let attack = (t / 0.01).min(1.0);
        let fade = (-t * 4.0 / length).exp();
        *s += wave(t * freq) * volume * attack * fade;
    }
}

fn sine(phase: f32) -> f32 {
    (phase * std::f32::consts::TAU).sin()
}

fn saw(phase: f32) -> f32 {
    2.0 * (phase - phase.floor()) - 1.0
}

/// A little random noise, the same every time.
fn noise(seed: &mut u32) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// A sound by name, ready to play: mono samples at the voice rate, never louder than 0.8.
pub fn clip(name: &str) -> Option<Vec<f32>> {
    let mut out;
    match name {
        "ding" => {
            out = vec![0.0; samples(1.2)];
            note(&mut out, 0.0, 1318.5, 1.2, 0.35, sine);
            note(&mut out, 0.0, 2637.0, 0.6, 0.1, sine);
        }
        "tada" => {
            out = vec![0.0; samples(1.3)];
            for (i, f) in [523.25, 659.25, 783.99].iter().enumerate() {
                note(&mut out, i as f32 * 0.08, *f, 0.25, 0.22, saw);
            }
            for f in [523.25, 659.25, 783.99, 1046.5] {
                note(&mut out, 0.3, f, 1.0, 0.14, saw);
            }
        }
        "horn" => {
            out = vec![0.0; samples(1.1)];
            for (start, length) in [(0.0, 0.18), (0.24, 0.18), (0.48, 0.6)] {
                for f in [466.16, 587.33, 698.46] {
                    let begin = samples(start);
                    for i in 0..samples(length) {
                        let Some(s) = out.get_mut(begin + i) else { break };
                        let t = i as f32 / RATE;
                        // A held blast with a little wobble.
                        let wobble = 1.0 + 0.006 * (t * 6.0 * std::f32::consts::TAU).sin();
                        *s += saw(t * f * wobble) * 0.11 * (t / 0.02).min(1.0);
                    }
                }
            }
        }
        "drums" => {
            out = vec![0.0; samples(1.4)];
            let mut seed = 7;
            // Ba, dum: low thumps falling in pitch.
            for at in [0.0, 0.22] {
                let begin = samples(at);
                for i in 0..samples(0.25) {
                    let t = i as f32 / RATE;
                    let f = 120.0 - 60.0 * t * 4.0;
                    out[begin + i] += (t * f * std::f32::consts::TAU).sin() * 0.6 * (-t * 14.0).exp();
                }
            }
            // Tss: a cymbal of bright noise.
            let begin = samples(0.5);
            let mut last = 0.0;
            for i in 0..samples(0.9) {
                let t = i as f32 / RATE;
                let n = noise(&mut seed);
                let bright = n - last;
                last = n;
                out[begin + i] += bright * 0.25 * (-t * 4.0).exp();
            }
        }
        "boing" => {
            out = vec![0.0; samples(0.8)];
            let mut phase = 0.0;
            for (i, s) in out.iter_mut().enumerate() {
                let t = i as f32 / RATE;
                let f = 180.0 + 260.0 * (t * 9.0).sin().abs() * (-t * 3.0).exp();
                phase += f / RATE;
                *s = sine(phase) * 0.5 * (-t * 3.5).exp();
            }
        }
        "sad" => {
            out = vec![0.0; samples(2.2)];
            for (i, f) in [311.13, 293.66, 277.18].iter().enumerate() {
                note(&mut out, i as f32 * 0.45, *f, 0.45, 0.25, saw);
            }
            // The last note droops and wobbles.
            let begin = samples(1.35);
            let mut phase = 0.0;
            for i in 0..samples(0.85) {
                let t = i as f32 / RATE;
                let f = 261.63 * (1.0 - 0.04 * t) * (1.0 + 0.02 * (t * 7.0 * std::f32::consts::TAU).sin());
                phase += f / RATE;
                out[begin + i] += saw(phase) * 0.22 * (-t * 2.0).exp();
            }
        }
        "cheer" => {
            out = vec![0.0; samples(1.8)];
            let mut seed = 99;
            let mut low = 0.0;
            for (i, s) in out.iter_mut().enumerate() {
                let t = i as f32 / RATE;
                // Soft, swelling noise like a small crowd, with claps on top.
                low += (noise(&mut seed) - low) * 0.08;
                let swell = (t / 0.4).min(1.0) * (-((t - 1.2).max(0.0)) * 3.0).exp();
                let clap = if (t * 9.0).fract() < 0.03 { noise(&mut seed) * 0.5 } else { 0.0 };
                *s = (low * 1.6 + clap) * 0.5 * swell;
            }
        }
        "pop" => {
            out = vec![0.0; samples(0.25)];
            let mut phase = 0.0;
            for (i, s) in out.iter_mut().enumerate() {
                let t = i as f32 / RATE;
                phase += (400.0 + 900.0 * (-t * 40.0).exp()) / RATE;
                *s = sine(phase) * 0.6 * (-t * 25.0).exp();
            }
        }
        _ => return None,
    }
    // Never louder than the voice around it.
    let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak > 0.8 {
        out.iter_mut().for_each(|s| *s *= 0.8 / peak);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sound_is_short_audible_and_never_too_loud() {
        for (name, _, _) in SOUNDS {
            let c = clip(name).unwrap_or_else(|| panic!("{name} missing"));
            let seconds = c.len() as f32 / RATE;
            assert!(seconds > 0.1 && seconds <= 2.5, "{name}: {seconds}s");
            let peak = c.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!(peak > 0.1 && peak <= 0.8001, "{name}: peak {peak}");
            assert!(c.iter().all(|s| s.is_finite()), "{name}");
        }
        assert!(clip("nope").is_none());
    }
}
