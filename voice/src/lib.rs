//! Client side of Hopp: identity, the TCP control connection and the realtime voice engine.

pub mod account;
pub mod capture;
pub mod control;
pub mod dsp;
pub mod engine;
pub mod identity;
pub mod jitter;
pub mod mesh;
pub mod turn;
pub mod settings;
pub mod soundboard;

pub use account::{connect_account, AccountLink};
pub use control::{connect, parse_invite, Control, Roster, Session, INVITE_SCHEME};
pub use engine::{list_devices, play_test_sound, DeviceChoice, DeviceList, EngineEvent, MicTest, VoiceEngine};
pub use settings::{AudioSettings, TransmitMode};
pub use identity::{Identity, StoredIdentity};
