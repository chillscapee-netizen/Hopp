//! Per-speaker jitter buffer: reorders packets and decides, once per 10 ms
//! frame, whether to play a packet, recover it via Opus FEC, or conceal it.
//!
//! How much it buffers adapts to the network: it tracks how unevenly packets
//! arrive (the RFC 3550 interarrival jitter) and waits just long enough at the
//! start of each talk spurt to ride that out, from 20 ms on a quiet network
//! up to 120 ms on a bad one.

use std::collections::BTreeMap;
use std::time::Instant;

/// Fewest frames buffered before playback starts (20 ms).
const MIN_TARGET: usize = 2;
/// Most frames we'll wait for, however bad the network (120 ms).
const MAX_TARGET: usize = 12;
/// Beyond the target plus this many frames we drop the oldest to cap latency.
const SLACK: usize = 6;
/// A gap this long between packets is a pause in speech, not jitter.
const SPURT_GAP_MS: f64 = 250.0;
const FRAME_MS: f64 = 10.0;
/// Consecutive missing frames before we assume the speaker stopped.
const MAX_CONCEAL: u32 = 5;
/// Hard cap so a misbehaving sender cannot grow memory without bound.
const CAPACITY: usize = 64;

#[derive(Debug, PartialEq)]
pub enum Playout {
    /// Decode this packet normally.
    Packet(Vec<u8>),
    /// The current packet is lost; decode the *next* one with FEC to recover it.
    Fec(Vec<u8>),
    /// Lost with nothing to recover from; let the decoder conceal.
    Conceal,
    /// Nothing to play.
    Idle,
}

pub struct JitterBuffer {
    packets: BTreeMap<u32, Vec<u8>>,
    next: Option<u32>,
    missing_run: u32,
    clock: Instant,
    /// Arrival time and transit time (arrival minus send time) of the last packet.
    last: Option<(f64, f64)>,
    /// Smoothed interarrival jitter in milliseconds.
    jitter_ms: f64,
}

impl Default for JitterBuffer {
    fn default() -> Self {
        JitterBuffer { packets: BTreeMap::new(), next: None, missing_run: 0, clock: Instant::now(), last: None, jitter_ms: 0.0 }
    }
}

impl JitterBuffer {
    pub fn push(&mut self, seq: u32, data: Vec<u8>) {
        let now = self.clock.elapsed().as_secs_f64() * 1000.0;
        self.push_at(seq, data, now);
    }

    /// Like `push`, with the arrival time given (milliseconds on any steady clock).
    pub fn push_at(&mut self, seq: u32, data: Vec<u8>, arrived_ms: f64) {
        let transit = arrived_ms - seq as f64 * FRAME_MS;
        if let Some((last_arrival, last_transit)) = self.last {
            if arrived_ms - last_arrival < SPURT_GAP_MS {
                self.jitter_ms += ((transit - last_transit).abs() - self.jitter_ms) / 16.0;
            }
        }
        self.last = Some((arrived_ms, transit));

        if self.next.is_some_and(|n| seq < n) || self.packets.len() >= CAPACITY {
            return;
        }
        self.packets.insert(seq, data);
    }

    /// Frames to collect before starting playback: enough to cover about 2.5 times the jitter.
    pub fn target(&self) -> usize {
        let frames = 1 + (2.5 * self.jitter_ms / FRAME_MS).ceil() as usize;
        frames.clamp(MIN_TARGET, MAX_TARGET)
    }

    pub fn pop(&mut self) -> Playout {
        let target = self.target();
        let next = match self.next {
            Some(n) if self.packets.len() <= target + SLACK => n,
            Some(_) => {
                while self.packets.len() > target {
                    self.packets.pop_first();
                }
                *self.packets.keys().next().expect("target > 0")
            }
            None if self.packets.len() >= target => *self.packets.keys().next().expect("target > 0"),
            None => return Playout::Idle,
        };
        self.next = Some(next + 1);

        if let Some(p) = self.packets.remove(&next) {
            self.missing_run = 0;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(seq: u32) -> Vec<u8> {
        vec![seq as u8]
    }

    #[test]
    fn waits_for_target_then_plays_in_order() {
        let mut jb = JitterBuffer::default();
        jb.push(11, pkt(11));
        assert_eq!(jb.pop(), Playout::Idle);
        jb.push(10, pkt(10));
        assert_eq!(jb.pop(), Playout::Packet(pkt(10)));
        assert_eq!(jb.pop(), Playout::Packet(pkt(11)));
    }

    #[test]
    fn recovers_single_loss_with_fec() {
        let mut jb = JitterBuffer::default();
        jb.push(1, pkt(1));
        jb.push(3, pkt(3));
        assert_eq!(jb.pop(), Playout::Packet(pkt(1)));
        assert_eq!(jb.pop(), Playout::Fec(pkt(3)));
        assert_eq!(jb.pop(), Playout::Packet(pkt(3)));
    }

    #[test]
    fn conceals_then_goes_idle() {
        let mut jb = JitterBuffer::default();
        jb.push(1, pkt(1));
        jb.push(2, pkt(2));
        jb.pop();
        jb.pop();
        for _ in 0..MAX_CONCEAL {
            assert_eq!(jb.pop(), Playout::Conceal);
        }
        assert_eq!(jb.pop(), Playout::Idle);
        assert_eq!(jb.pop(), Playout::Idle);
    }

    #[test]
    fn late_packets_are_dropped() {
        let mut jb = JitterBuffer::default();
        jb.push(5, pkt(5));
        jb.push(6, pkt(6));
        jb.pop();
        jb.push(4, pkt(4));
        assert_eq!(jb.pop(), Playout::Packet(pkt(6)));
    }

    #[test]
    fn buffers_more_on_a_jittery_network() {
        let mut steady = JitterBuffer::default();
        for seq in 0..200 {
            steady.push_at(seq, pkt(seq), seq as f64 * 10.0);
        }
        assert_eq!(steady.target(), MIN_TARGET);

        // Packets arriving up to 30 ms late, unevenly.
        let mut bumpy = JitterBuffer::default();
        for seq in 0..200 {
            let late = [0.0, 30.0, 5.0, 22.0, 0.0, 15.0][seq as usize % 6];
            bumpy.push_at(seq, pkt(seq), seq as f64 * 10.0 + late);
        }
        assert!(bumpy.target() >= 5, "target {} should cover the jitter", bumpy.target());
        assert!(bumpy.target() <= MAX_TARGET);

        // Pauses between talk spurts aren't jitter.
        let mut talky = JitterBuffer::default();
        for seq in 0..200 {
            let pause = (seq / 50) as f64 * 2000.0;
            talky.push_at(seq, pkt(seq), seq as f64 * 10.0 + pause);
        }
        assert_eq!(talky.target(), MIN_TARGET);
    }

    #[test]
    fn skips_ahead_when_too_far_behind() {
        let mut jb = JitterBuffer::default();
        jb.push(0, pkt(0));
        jb.push(1, pkt(1));
        jb.pop();
        for s in 1..=20 {
            jb.push(s, pkt(s));
        }
        // A burst like this is jitter, so the target grows; we keep exactly that much.
        let first = 21 - jb.target() as u32;
        assert_eq!(jb.pop(), Playout::Packet(pkt(first)));
        assert_eq!(jb.pop(), Playout::Packet(pkt(first + 1)));
    }
}
