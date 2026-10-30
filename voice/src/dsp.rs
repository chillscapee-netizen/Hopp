//! Small signal-processing helpers that run on the audio path.

/// Linear-interpolating resampler for streaming audio. Plenty for voice, and
/// it adds no latency beyond one sample.
pub struct Resampler {
    step: f64,
    pos: f64,
    last: f32,
}

impl Resampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        Resampler { step: from_rate as f64 / to_rate as f64, pos: 0.0, last: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut impl Extend<f32>) {
        if self.step == 1.0 {
            out.extend(input.iter().copied());
            return;
        }
        if input.is_empty() {
            return;
        }
        // Index 0 is the last sample of the previous chunk, index k is input[k - 1].
        let len = input.len() as f64;
        let (last, step) = (self.last, self.step);
        let mut pos = self.pos;
        out.extend(std::iter::from_fn(|| {
            if pos >= len {
                return None;
            }
            let i = pos as usize;
            let a = if i == 0 { last } else { input[i - 1] };
            let b = input[i];
            let s = a + (b - a) * (pos - i as f64) as f32;
            pos += step;
            Some(s)
        }));
        self.pos = pos - len;
        self.last = input[input.len() - 1];
    }
}

/// RMS level of a frame in dBFS, floored at -100.
pub fn level_db(frame: &[f32]) -> f32 {
    let mean_sq = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
    (10.0 * mean_sq.log10()).max(-100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_rate_is_passthrough() {
        let mut r = Resampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn output_length_tracks_rate_ratio() {
        let mut r = Resampler::new(44_100, 48_000);
        let mut out = Vec::new();
        for _ in 0..100 {
            r.process(&[0.0; 441], &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 1, "got {}", out.len());
    }

    #[test]
    fn interpolates_between_chunks() {
        let mut r = Resampler::new(1, 2);
        let mut out = Vec::new();
        r.process(&[1.0], &mut out);
        r.process(&[3.0], &mut out);
        assert_eq!(out, vec![0.0, 0.5, 1.0, 2.0]);
    }

    #[test]
    fn level_of_full_scale_square_is_zero_db() {
        assert!(level_db(&[1.0, -1.0, 1.0, -1.0]).abs() < 1e-4);
        assert_eq!(level_db(&[0.0; 10]), -100.0);
    }
}
