//! Per-speaker jitter buffer: reorders packets and decides, once per 10 ms frame, whether to
//! play a packet, recover it with Opus FEC, conceal it, or quietly change how much is waiting.
//!
//! Built after WebRTC's NetEQ (its source and design notes), the state of the art:
//!
//! - **How much to wait** comes from how late packets have really been, not from an average:
//!   each packet's delay over the quickest of the last two seconds goes into a histogram that
//!   slowly forgets, and the buffer covers the 97th percentile. A network that is usually
//!   smooth with the odd late burst gets a small buffer and few gaps; a rough one gets what it
//!   needs. From 20 ms on a quiet network up to 200 ms on a very bad one.
//! - **Getting there without a pause.** The old way changed the buffer only between talk
//!   spurts, and threw packets away when far behind (heard as a skip). Now, during speech,
//!   the buffer grows or shrinks by one 10 ms frame at a time, and only in the quiet moments
//!   between sounds (the mixer says which frames are quiet): too much waiting, a quiet frame is
//!   left out; too little, a quiet moment is held a frame longer. Nobody hears it.

use std::collections::{BTreeMap, VecDeque};
use std::time::Instant;

/// Fewest frames buffered before playback starts (20 ms).
const MIN_TARGET: usize = 2;
/// Most frames we'll wait for, however bad the network (200 ms).
const MAX_TARGET: usize = 20;
/// Before anything is known about the network: a little extra, so the first words don't break up.
const START_TARGET: usize = 4;
/// A gap this long between packets is a pause in speech, not jitter.
const SPURT_GAP_MS: f64 = 250.0;
const FRAME_MS: f64 = 10.0;
/// Consecutive missing frames before we assume the speaker stopped.
const MAX_CONCEAL: u32 = 5;
/// Hard cap so a misbehaving sender cannot grow memory without bound.
const CAPACITY: usize = 64;
/// How far back the quickest packet is looked for (the "no delay" reference).
const BASE_WINDOW_MS: f64 = 2000.0;
/// The histogram: 10 ms buckets up to a second.
const BUCKET_MS: f64 = 10.0;
const BUCKETS: usize = 100;
/// The share of packets the buffer is sized to cover.
const QUANTILE: f64 = 0.97;
/// How slowly old measurements fade, per packet (about 14 s at 100 packets a second).
const FORGET: f64 = 0.9993;
/// Packets seen before the histogram is trusted over the start value.
const TRUSTED_AFTER: u32 = 50;
/// Frames over the target before a quiet frame is left out, and under it before one is held.
const HIGH_SLACK: f64 = 2.0;
const LOW_SLACK: f64 = 1.0;
/// At least this many frames between two such changes, so they stay rare and inaudible.
const STRETCH_EVERY: u32 = 4;
/// So far behind that waiting for a quiet moment would take too long: catch up at once.
const CATCH_UP_OVER: usize = 30;

#[derive(Debug, PartialEq)]
pub enum Playout {
    /// Decode this packet normally.
    Packet(Vec<u8>),
    /// Decode this packet; if it turns out quiet, leave it out and ask again (the buffer is
    /// fuller than needed). If it isn't quiet, play it as usual.
    Shorten(Vec<u8>),
    /// The current packet is lost; decode the *next* one with FEC to recover it.
    Fec(Vec<u8>),
    /// Lost with nothing to recover from; let the decoder conceal.
    Conceal,
    /// The buffer is emptier than it should be and the last frame was quiet: hold this quiet
    /// moment one frame longer (the decoder continues it), without using up a packet.
    Lengthen,
    /// Nothing to play.
    Idle,
}

pub struct JitterBuffer {
    packets: BTreeMap<u32, Vec<u8>>,
    next: Option<u32>,
    missing_run: u32,
    clock: Instant,
    /// Arrival time of the last packet (for telling pauses from jitter).
    last_arrival: Option<f64>,
    /// Recent (arrival, transit) pairs: the quickest is the reference for "no delay".
    recent: VecDeque<(f64, f64)>,
    /// How late packets have been: weights per 10 ms bucket, slowly forgetting.
    histogram: [f64; BUCKETS],
    measured: u32,
    /// The buffer level, smoothed (frames).
    level: f64,
    since_stretch: u32,
}

impl Default for JitterBuffer {
    fn default() -> Self {
        JitterBuffer {
            packets: BTreeMap::new(),
            next: None,
            missing_run: 0,
            clock: Instant::now(),
            last_arrival: None,
            recent: VecDeque::new(),
            histogram: [0.0; BUCKETS],
            measured: 0,
            level: 0.0,
            since_stretch: STRETCH_EVERY,
        }
    }
}

impl JitterBuffer {
    pub fn push(&mut self, seq: u32, data: Vec<u8>) {
        let now = self.clock.elapsed().as_secs_f64() * 1000.0;
        self.push_at(seq, data, now);
    }

    /// Like `push`, with the arrival time given (milliseconds on any steady clock).
    pub fn push_at(&mut self, seq: u32, data: Vec<u8>, arrived_ms: f64) {
        self.measure(seq, arrived_ms);
        if self.next.is_some_and(|n| seq < n) || self.packets.len() >= CAPACITY {
            return;
        }
        self.packets.insert(seq, data);
    }

    /// How late this packet is compared with the quickest lately, into the histogram.
    fn measure(&mut self, seq: u32, arrived_ms: f64) {
        // The sender only numbers what it sends, so after a pause in speech the numbers and
        // the clock no longer line up: the reference starts over (a pause isn't lateness).
        if self.last_arrival.is_some_and(|last| arrived_ms - last >= SPURT_GAP_MS) {
            self.recent.clear();
        }
        self.last_arrival = Some(arrived_ms);
        let transit = arrived_ms - seq as f64 * FRAME_MS;
        while self.recent.front().is_some_and(|&(at, _)| arrived_ms - at > BASE_WINDOW_MS) {
            self.recent.pop_front();
        }
        self.recent.push_back((arrived_ms, transit));
        let quickest = self.recent.iter().map(|&(_, t)| t).fold(f64::INFINITY, f64::min);
        let late_ms = (transit - quickest).max(0.0);
        let bucket = ((late_ms / BUCKET_MS) as usize).min(BUCKETS - 1);
        for w in &mut self.histogram {
            *w *= FORGET;
        }
        self.histogram[bucket] += 1.0 - FORGET;
        self.measured = self.measured.saturating_add(1);
    }

    /// A frame repeated inside a later packet: fills its gap if it's still missing and not
    /// yet played. It arrives late by design, so it doesn't count toward the lateness.
    pub fn fill_in(&mut self, seq: u32, data: Vec<u8>) {
        if self.next.is_some_and(|n| seq < n) || self.packets.len() >= CAPACITY {
            return;
        }
        self.packets.entry(seq).or_insert(data);
    }

    /// Frames to keep waiting: enough to cover 97% of how late packets have been, plus the frame itself.
    pub fn target(&self) -> usize {
        if self.measured < TRUSTED_AFTER {
            return START_TARGET;
        }
        let total: f64 = self.histogram.iter().sum();
        if total <= 0.0 {
            return START_TARGET;
        }
        let mut sum = 0.0;
        let mut bucket = BUCKETS - 1;
        for (i, w) in self.histogram.iter().enumerate() {
            sum += w;
            if sum >= QUANTILE * total {
                bucket = i;
                break;
            }
        }
        // The bucket's upper edge, in frames, plus one for the frame being played.
        let late_frames = ((bucket + 1) as f64 * BUCKET_MS / FRAME_MS).ceil() as usize;
        (late_frames + 1).clamp(MIN_TARGET, MAX_TARGET)
    }

    /// Frames waiting from the next one to play to the newest (gaps included).
    fn span(&self) -> usize {
        match (self.next, self.packets.keys().next_back()) {
            (Some(n), Some(&last)) if last >= n => (last - n + 1) as usize,
            _ => 0,
        }
    }

    /// The next frame to play. `quiet` says whether the last frame played was quiet: the
    /// buffer only grows in such moments, where holding the sound a little longer can't be heard.
    pub fn pop(&mut self, quiet: bool) -> Playout {
        let target = self.target();
        let next = match self.next {
            Some(n) => n,
            None if self.packets.len() >= target => *self.packets.keys().next().expect("target > 0"),
            None => return Playout::Idle,
        };
        if self.next.is_none() {
            self.next = Some(next);
            self.level = target as f64;
        }

        // Far too much waiting (a long freeze just ended): catch up at once.
        if self.span() > target + CATCH_UP_OVER {
            while self.packets.len() > target {
                self.packets.pop_first();
            }
            self.next = self.packets.keys().next().copied();
            self.level = target as f64;
        }
        let Some(next) = self.next else { return Playout::Idle };

        // How full it's been lately, against what's needed.
        self.level += (self.span() as f64 - self.level) * 0.1;
        self.since_stretch = self.since_stretch.saturating_add(1);
        let may_stretch = self.since_stretch >= STRETCH_EVERY && self.missing_run == 0;
        let too_full = may_stretch && self.level > target as f64 + HIGH_SLACK && self.span() > target;
        let too_empty = may_stretch && quiet && self.level < target as f64 - LOW_SLACK;

        if too_empty && self.packets.contains_key(&next) {
            self.since_stretch = 0;
            self.level += 1.0;
            return Playout::Lengthen;
        }

        self.next = Some(next + 1);
        if let Some(p) = self.packets.remove(&next) {
            self.missing_run = 0;
            if too_full {
                self.since_stretch = 0;
                self.level -= 1.0;
                return Playout::Shorten(p);
            }
            return Playout::Packet(p);
        }
        self.missing_run += 1;
        if self.missing_run > MAX_CONCEAL {
            self.next = None;
            self.missing_run = 0;
            return Playout::Idle;
        }
        match self.packets.get(&(next + 1)) {
            Some(p) => Playout::Fec(p.clone()),
            None => Playout::Conceal,
        }
    }

    /// The Shorten frame turned out quiet and was left out: what's in its place.
    pub fn after_shortened(&mut self) -> Playout {
        // One more pop, without another change right away.
        self.pop(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(seq: u32) -> Vec<u8> {
        vec![seq as u8]
    }

    /// A steady stream at the given lateness pattern (ms added per packet, cycling).
    fn stream(jb: &mut JitterBuffer, from: u32, count: u32, late: &[f64]) {
        for seq in from..from + count {
            let extra = late[(seq as usize) % late.len()];
            jb.push_at(seq, pkt(seq), seq as f64 * 10.0 + extra);
        }
    }

    #[test]
    fn waits_for_target_then_plays_in_order() {
        let mut jb = JitterBuffer::default();
        jb.push(11, pkt(11));
        assert_eq!(jb.pop(false), Playout::Idle);
        for s in [10, 12, 13] {
            jb.push(s, pkt(s));
        }
        assert_eq!(jb.pop(false), Playout::Packet(pkt(10)));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(11)));
    }

    #[test]
    fn repeated_frames_fill_gaps_but_never_replay() {
        let mut jb = JitterBuffer::default();
        jb.push(1, pkt(1));
        jb.push(4, pkt(4));
        jb.fill_in(2, pkt(2));
        jb.fill_in(3, pkt(3));
        jb.fill_in(4, vec![99]);
        assert_eq!(jb.pop(false), Playout::Packet(pkt(1)));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(2)));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(3)));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(4)), "the original wins over a repeat");
        jb.fill_in(2, pkt(2));
        assert_eq!(jb.pop(false), Playout::Conceal);
    }

    #[test]
    fn recovers_single_loss_with_fec() {
        let mut jb = JitterBuffer::default();
        for s in [1, 3, 4, 5] {
            jb.push(s, pkt(s));
        }
        assert_eq!(jb.pop(false), Playout::Packet(pkt(1)));
        assert_eq!(jb.pop(false), Playout::Fec(pkt(3)));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(3)));
    }

    #[test]
    fn conceals_then_goes_idle() {
        let mut jb = JitterBuffer::default();
        for s in 1..=4 {
            jb.push(s, pkt(s));
        }
        for _ in 0..4 {
            jb.pop(false);
        }
        for _ in 0..MAX_CONCEAL {
            assert_eq!(jb.pop(false), Playout::Conceal);
        }
        assert_eq!(jb.pop(false), Playout::Idle);
        assert_eq!(jb.pop(false), Playout::Idle);
    }

    #[test]
    fn late_packets_are_dropped() {
        let mut jb = JitterBuffer::default();
        for s in 5..=8 {
            jb.push(s, pkt(s));
        }
        jb.pop(false);
        jb.push(4, pkt(4));
        assert_eq!(jb.pop(false), Playout::Packet(pkt(6)));
    }

    #[test]
    fn small_on_a_smooth_network_and_sized_to_the_late_ones_on_a_rough_one() {
        let mut steady = JitterBuffer::default();
        stream(&mut steady, 0, 500, &[0.0]);
        assert_eq!(steady.target(), MIN_TARGET);

        // Usually on time, but every tenth packet 45 ms late: the buffer covers it.
        let mut bursty = JitterBuffer::default();
        stream(&mut bursty, 0, 1000, &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 45.0]);
        let t = bursty.target();
        assert!((5..=7).contains(&t), "covers the 45 ms ones: {t}");

        // Rarely late (one in a hundred): not worth waiting for every time.
        let mut rare = JitterBuffer::default();
        let mut late = vec![0.0; 100];
        late[50] = 80.0;
        stream(&mut rare, 0, 1000, &late);
        assert!(rare.target() <= 3, "{}", rare.target());

        // Pauses between talk spurts aren't lateness.
        let mut talky = JitterBuffer::default();
        for seq in 0..400u32 {
            let pause = (seq / 50) as f64 * 2000.0;
            talky.push_at(seq, pkt(seq), seq as f64 * 10.0 + pause);
        }
        assert_eq!(talky.target(), MIN_TARGET);
    }

    #[test]
    fn too_full_shortens_only_in_quiet_frames_and_too_empty_lengthens() {
        // A steady network (small target), played as it arrives; then a burst comes at once.
        let mut jb = JitterBuffer::default();
        for s in 0..300 {
            jb.push_at(s, pkt(s), s as f64 * 10.0);
            jb.pop(false);
        }
        for s in 300..325 {
            jb.push_at(s, pkt(s), 3000.0);
        }
        let mut shortened = 0;
        for _ in 0..60 {
            match jb.pop(false) {
                Playout::Shorten(_) => {
                    shortened += 1;
                    // The mixer finds it quiet and leaves it out.
                    jb.after_shortened();
                }
                Playout::Lengthen => panic!("never lengthens while too full"),
                _ => {}
            }
        }
        assert!(shortened >= 3, "brings the waiting down, a frame at a time: {shortened}");

        // Too empty: only a quiet moment is held longer, and never two frames in a row.
        let mut thin = JitterBuffer::default();
        stream(&mut thin, 0, 100, &[0.0, 0.0, 0.0, 0.0, 30.0]);
        thin.level = 0.0;
        thin.next = thin.packets.keys().next().copied();
        assert_ne!(thin.pop(false), Playout::Lengthen, "not while it's loud");
        thin.since_stretch = STRETCH_EVERY;
        thin.level = 0.0;
        assert_eq!(thin.pop(true), Playout::Lengthen);
        assert_ne!(thin.pop(true), Playout::Lengthen, "not twice in a row");
    }

    #[test]
    fn a_long_freeze_catches_up_at_once() {
        let mut jb = JitterBuffer::default();
        stream(&mut jb, 0, 10, &[0.0]);
        jb.pop(false);
        for s in 10..70 {
            jb.push_at(s, pkt(s), 1000.0);
        }
        // Far more waiting than needed: the oldest go, and it plays near the newest.
        let first = match jb.pop(false) {
            Playout::Packet(p) | Playout::Shorten(p) => p[0] as u32,
            other => panic!("{other:?}"),
        };
        assert!(first >= 60, "{first}");
    }
}
