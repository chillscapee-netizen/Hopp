//! Hopp ID: an Ed25519 key pair that is the user's account on every server.
//!
//! The private key never leaves this computer and is stored encrypted with a
//! key derived from the user's password (Argon2id, then ChaCha20-Poly1305).
//! Servers only ever see the public key and signatures.
//!
//! There is no server that could reset a password. Instead the private key can
//! be written down as a 24-word recovery phrase (BIP-39): with the phrase you can
//! choose a new password or move the account to another computer.

use anyhow::Context;
use argon2::Argon2;
use bip39::Mnemonic;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use strom_shared::MAX_NAME_LEN;

pub const MIN_PASSWORD_LEN: usize = 8;

/// The encrypted form kept on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredIdentity {
    pub version: u32,
    pub name: String,
    pub public_key: String,
    salt: String,
    nonce: String,
    secret: String,
    /// Set once the user has proven they saved the recovery phrase.
    #[serde(default)]
    pub backed_up: bool,
}

/// An unlocked identity, able to sign server challenges.
#[derive(Clone)]
pub struct Identity {
    pub name: String,
    key: SigningKey,
}

fn derive_key(password: &str, salt: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}

pub fn validate_name(name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "Choose a name.");
    anyhow::ensure!(name.chars().count() <= MAX_NAME_LEN, "Names can be at most {MAX_NAME_LEN} characters.");
    Ok(name.to_string())
}

pub fn validate_password(password: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        password.chars().count() >= MIN_PASSWORD_LEN,
        "Your password must be at least {MIN_PASSWORD_LEN} characters."
    );
    Ok(())
}

impl Identity {
    /// Creates a new identity and its encrypted form for saving.
    pub fn create(name: &str, password: &str) -> anyhow::Result<(Identity, StoredIdentity)> {
        let identity = Identity { name: validate_name(name)?, key: SigningKey::from_bytes(&rand::random()) };
        let stored = identity.encrypt(password)?;
        Ok((identity, stored))
    }

    /// Rebuilds an identity from its recovery phrase, protected by a new password.
    pub fn restore(name: &str, phrase: &str, password: &str) -> anyhow::Result<(Identity, StoredIdentity)> {
        let identity = Identity { name: validate_name(name)?, key: SigningKey::from_bytes(&parse_phrase(phrase)?) };
        let stored = identity.encrypt(password)?;
        Ok((identity, stored))
    }

    /// Rebuilds an identity from the raw key, e.g. one remembered by the OS credential store.
    pub fn from_secret(name: &str, secret_hex: &str) -> anyhow::Result<Identity> {
        let bytes: [u8; 32] = hex::decode(secret_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .context("invalid saved login")?;
        Ok(Identity { name: name.to_string(), key: SigningKey::from_bytes(&bytes) })
    }

    /// The encrypted form of this identity under `password`; also how a password is changed.
    pub fn encrypt(&self, password: &str) -> anyhow::Result<StoredIdentity> {
        validate_password(password)?;
        let salt: [u8; 16] = rand::random();
        let nonce: [u8; 12] = rand::random();
        let cipher = ChaCha20Poly1305::new(&derive_key(password, &salt)?.into());
        let secret = cipher
            .encrypt(Nonce::from_slice(&nonce), self.key.to_bytes().as_slice())
            .map_err(|_| anyhow::anyhow!("encryption failed"))?;
        Ok(StoredIdentity {
            version: 1,
            name: self.name.clone(),
            public_key: self.public_key(),
            salt: hex::encode(salt),
            nonce: hex::encode(nonce),
            secret: hex::encode(secret),
            backed_up: false,
        })
    }

    /// Checks a "type word #n" quiz against the recovery phrase. Positions are 1-based.
    pub fn check_phrase_words(&self, answers: &[(usize, String)]) -> bool {
        let phrase = self.recovery_phrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        answers.len() >= 3
            && answers.iter().all(|(position, word)| {
                (1..=words.len()).contains(position) && words[position - 1] == word.trim().to_lowercase()
            })
    }

    /// Decrypts a stored identity. Fails on a wrong password.
    pub fn unlock(stored: &StoredIdentity, password: &str) -> anyhow::Result<Identity> {
        let salt = hex::decode(&stored.salt).context("damaged account file")?;
        let nonce = hex::decode(&stored.nonce).context("damaged account file")?;
        let secret = hex::decode(&stored.secret).context("damaged account file")?;
        let cipher = ChaCha20Poly1305::new(&derive_key(password, &salt)?.into());
        let bytes = cipher
            .decrypt(Nonce::from_slice(&nonce), secret.as_slice())
            .map_err(|_| anyhow::anyhow!("Wrong password."))?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| anyhow::anyhow!("damaged account file"))?;
        let key = SigningKey::from_bytes(&bytes);
        anyhow::ensure!(hex::encode(key.verifying_key().as_bytes()) == stored.public_key, "damaged account file");
        Ok(Identity { name: stored.name.clone(), key })
    }

    pub fn public_key(&self) -> String {
        hex::encode(self.key.verifying_key().as_bytes())
    }

    /// The raw private key, for the OS credential store. Never send this anywhere.
    pub fn secret_hex(&self) -> String {
        hex::encode(self.key.to_bytes())
    }

    /// The private key as 24 words. Whoever has these words *is* this account.
    pub fn recovery_phrase(&self) -> String {
        Mnemonic::from_entropy(&self.key.to_bytes()).expect("32 bytes is valid BIP-39 entropy").to_string()
    }

    /// What sending `text` would give away: this account's own recovery words (six or more
    /// of them in order), or what looks like a recovery phrase (twelve or more recovery words
    /// in a row; ordinary sentences never manage that, since words like "the" aren't in the list).
    pub fn phrase_leak(&self, text: &str) -> Option<PhraseLeak> {
        let runs = recovery_word_runs(text);
        let phrase = self.recovery_phrase();
        let mine: Vec<&str> = phrase.split(' ').collect();
        let leaks_mine = runs.iter().any(|run| run.windows(MINE_RUN).any(|w| mine.windows(MINE_RUN).any(|m| m.iter().zip(w).all(|(a, b)| a == b))));
        if leaks_mine {
            Some(PhraseLeak::Mine)
        } else if runs.iter().any(|run| run.len() >= PHRASE_RUN) {
            Some(PhraseLeak::Phrase)
        } else {
            None
        }
    }

    /// Signs a server's login challenge.
    pub fn sign_challenge(&self, nonce: &[u8]) -> String {
        hex::encode(self.key.sign(&strom_shared::auth_message(nonce)).to_bytes())
    }

    /// Signs a picture for a cloud server: proof that this Hopp ID uploads exactly these
    /// bytes to that server around this time (milliseconds since 1970).
    pub fn sign_image(&self, server_id: &str, data: &[u8], time_ms: u64) -> String {
        use sha2::{Digest, Sha256};
        let digest = hex::encode(Sha256::digest(data));
        let message = format!("hopp-image-v1\0{server_id}\0{digest}\0{time_ms}");
        hex::encode(self.key.sign(message.as_bytes()).to_bytes())
    }

    /// A key only this Hopp ID has, for data it stores in the cloud for itself
    /// (the synced server list and settings). Every device with the same ID can read it.
    fn private_data_key(&self) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"strom-private-data-v1\0");
        h.update(self.key.to_bytes());
        h.finalize().into()
    }

    /// Encrypts `plaintext` for this Hopp ID alone: hex of nonce and ciphertext.
    pub fn seal_private(&self, plaintext: &[u8]) -> String {
        let cipher = ChaCha20Poly1305::new(&self.private_data_key().into());
        let nonce_bytes: [u8; 12] = rand::random();
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext).expect("encryption cannot fail");
        let mut out = nonce_bytes.to_vec();
        out.extend(sealed);
        hex::encode(out)
    }

    /// The key two Hopp IDs share for direct messages: X25519 between our keys,
    /// so only the two of us can work it out. The cloud never can.
    fn shared_key(&self, their_public_key: &str) -> anyhow::Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let bytes: [u8; 32] = hex::decode(their_public_key)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("not a Hopp ID"))?;
        let theirs = ed25519_dalek::VerifyingKey::from_bytes(&bytes)?.to_montgomery();
        let secret = theirs.mul_clamped(self.key.to_scalar_bytes());
        let mut h = Sha256::new();
        h.update(b"strom-dm-v1\0");
        h.update(secret.as_bytes());
        Ok(h.finalize().into())
    }

    /// Encrypts a direct message for `their_public_key` (and us): hex of nonce and ciphertext.
    pub fn seal_for(&self, their_public_key: &str, plaintext: &[u8]) -> anyhow::Result<String> {
        let cipher = ChaCha20Poly1305::new(&self.shared_key(their_public_key)?.into());
        let nonce_bytes: [u8; 12] = rand::random();
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext).map_err(|_| anyhow::anyhow!("encryption failed"))?;
        let mut out = nonce_bytes.to_vec();
        out.extend(sealed);
        Ok(hex::encode(out))
    }

    pub fn open_from(&self, their_public_key: &str, sealed: &str) -> anyhow::Result<Vec<u8>> {
        let bytes = hex::decode(sealed)?;
        anyhow::ensure!(bytes.len() > 12, "sealed message is too short");
        let cipher = ChaCha20Poly1305::new(&self.shared_key(their_public_key)?.into());
        cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| anyhow::anyhow!("this message can't be read"))
    }

    pub fn open_private(&self, sealed: &str) -> anyhow::Result<Vec<u8>> {
        let bytes = hex::decode(sealed)?;
        anyhow::ensure!(bytes.len() > 12, "sealed data is too short");
        let cipher = ChaCha20Poly1305::new(&self.private_data_key().into());
        cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| anyhow::anyhow!("this data belongs to another Hopp ID or is damaged"))
    }
}

/// Six of your own recovery words in order can't happen by chance.
const MINE_RUN: usize = 6;
/// Twelve recovery words in a row is a phrase, or half of one.
const PHRASE_RUN: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhraseLeak {
    /// Words from this account's own recovery phrase.
    Mine,
    /// Something that looks like a recovery phrase (someone else's, or ours mistyped).
    Phrase,
}

/// The stretches of recovery-list words in a text, however they're written down
/// (numbered, with commas, on several lines, in capitals).
fn recovery_word_runs(text: &str) -> Vec<Vec<String>> {
    let english = bip39::Language::English;
    let mut runs = vec![Vec::new()];
    for word in text.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()) {
        let word = word.to_ascii_lowercase();
        if english.find_word(&word).is_some() {
            runs.last_mut().unwrap().push(word);
        } else if !runs.last().unwrap().is_empty() {
            runs.push(Vec::new());
        }
    }
    runs.retain(|r| !r.is_empty());
    runs
}

/// The public key a recovery phrase belongs to, to check it before overwriting anything.
pub fn public_key_of_phrase(phrase: &str) -> anyhow::Result<String> {
    Ok(hex::encode(SigningKey::from_bytes(&parse_phrase(phrase)?).verifying_key().as_bytes()))
}

fn parse_phrase(phrase: &str) -> anyhow::Result<[u8; 32]> {
    // Be forgiving about how people copy the words: case, commas, line breaks, numbering.
    let words: Vec<String> = phrase
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|w| w.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')').to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    anyhow::ensure!(words.len() == 24, "A recovery phrase has 24 words; that was {}.", words.len());
    let mnemonic = Mnemonic::parse_normalized(&words.join(" "))
        .map_err(|_| anyhow::anyhow!("That recovery phrase isn't valid. Check for typos."))?;
    mnemonic.to_entropy().try_into().map_err(|_| anyhow::anyhow!("That recovery phrase isn't valid."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn unlocks_with_the_right_password_only() {
        let (created, stored) = Identity::create("Marcus", "secret password").unwrap();
        let unlocked = Identity::unlock(&stored, "secret password").unwrap();
        assert_eq!(unlocked.public_key(), created.public_key());
        assert_eq!(unlocked.name, "Marcus");

        let err = Identity::unlock(&stored, "wrong password").err().unwrap();
        assert_eq!(err.to_string(), "Wrong password.");
    }

    #[test]
    fn stored_form_does_not_contain_the_private_key() {
        let (id, stored) = Identity::create("a", "password1").unwrap();
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains(&hex::encode(id.key.to_bytes())));
    }

    #[test]
    fn signatures_verify_against_the_public_key() {
        let (id, _) = Identity::create("a", "password1").unwrap();
        let nonce = [7u8; 32];
        let sig: [u8; 64] = hex::decode(id.sign_challenge(&nonce)).unwrap().try_into().unwrap();
        let key: [u8; 32] = hex::decode(id.public_key()).unwrap().try_into().unwrap();
        let key = VerifyingKey::from_bytes(&key).unwrap();
        assert!(key.verify(&strom_shared::auth_message(&nonce), &Signature::from_bytes(&sig)).is_ok());
    }

    #[test]
    fn rejects_weak_input() {
        assert!(Identity::create("", "password1").is_err());
        assert!(Identity::create("a", "short").is_err());
    }

    #[test]
    fn recovery_phrase_restores_the_same_account_with_a_new_password() {
        let (original, _) = Identity::create("Marcus", "forgotten-password").unwrap();
        let phrase = original.recovery_phrase();
        assert_eq!(phrase.split(' ').count(), 24);
        assert_eq!(public_key_of_phrase(&phrase).unwrap(), original.public_key());

        let (restored, stored) = Identity::restore("Marcus", &phrase, "a-brand-new-one").unwrap();
        assert_eq!(restored.public_key(), original.public_key());
        assert!(Identity::unlock(&stored, "a-brand-new-one").is_ok());
        assert!(Identity::unlock(&stored, "forgotten-password").is_err());
    }

    #[test]
    fn recovery_phrase_parsing_is_forgiving_but_checked() {
        let (id, _) = Identity::create("a", "password1").unwrap();
        let phrase = id.recovery_phrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        // Numbered, comma-separated, mixed case and on several lines, as people write them down.
        let messy: String = words
            .iter()
            .enumerate()
            .map(|(i, w)| format!("{}. {}{}", i + 1, w.to_uppercase(), if i % 6 == 5 { ",\n" } else { ", " }))
            .collect();
        assert_eq!(public_key_of_phrase(&messy).unwrap(), id.public_key());

        let mut wrong = words.clone();
        wrong.swap(0, 1);
        assert!(public_key_of_phrase(&wrong.join(" ")).is_err(), "the checksum must catch swapped words");
        assert!(public_key_of_phrase(&words[..23].join(" ")).is_err());
    }

    #[test]
    fn recovery_phrases_are_caught_before_they_are_sent() {
        let (id, _) = Identity::create("a", "password1").unwrap();
        let phrase = id.recovery_phrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        // Our own, whole or in part, however it's written.
        assert_eq!(id.phrase_leak(&phrase), Some(PhraseLeak::Mine));
        let numbered: String = words.iter().enumerate().map(|(i, w)| format!("{}) {}\n", i + 1, w.to_uppercase())).collect();
        assert_eq!(id.phrase_leak(&numbered), Some(PhraseLeak::Mine));
        assert_eq!(id.phrase_leak(&format!("here you go: {}", words[8..14].join(", "))), Some(PhraseLeak::Mine));
        // Someone else's phrase.
        let (other, _) = Identity::create("b", "password1").unwrap();
        assert_eq!(id.phrase_leak(&other.recovery_phrase()), Some(PhraseLeak::Phrase));
        // Ordinary chat, even full of words that happen to be on the list.
        for text in [
            "Ready for tonight? Join the lobby in five",
            "good game, that was a great match, see you tomorrow at the usual time",
            "I think the best way to win is to stay together and push the middle",
            "apple banana orange", // three list words in a row is nothing
            "",
        ] {
            assert_eq!(id.phrase_leak(text), None, "{text}");
        }
    }

    #[test]
    fn changing_the_password_keeps_the_account() {
        let (id, _) = Identity::create("a", "old-password").unwrap();
        let stored = id.encrypt("new-password").unwrap();
        assert_eq!(Identity::unlock(&stored, "new-password").unwrap().public_key(), id.public_key());
        assert!(id.encrypt("short").is_err());
    }

    #[test]
    fn phrase_quiz_needs_three_right_words() {
        let (id, _) = Identity::create("a", "password1").unwrap();
        let phrase = id.recovery_phrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        let answer = |p: usize| (p, format!(" {} ", words[p - 1].to_uppercase()));
        assert!(id.check_phrase_words(&[answer(4), answer(11), answer(19)]));
        assert!(!id.check_phrase_words(&[answer(4), answer(11)]), "two words aren't enough");
        assert!(!id.check_phrase_words(&[answer(4), answer(11), (19, words[0].to_string())]) || words[0] == words[18]);
        assert!(!id.check_phrase_words(&[answer(4), answer(11), (25, "x".into())]));
    }

    #[test]
    fn old_account_files_count_as_not_backed_up() {
        let (_, stored) = Identity::create("a", "password1").unwrap();
        let mut json: serde_json::Value = serde_json::to_value(&stored).unwrap();
        json.as_object_mut().unwrap().remove("backed_up");
        let old: StoredIdentity = serde_json::from_value(json).unwrap();
        assert!(!old.backed_up);
    }

    #[test]
    fn remembered_logins_rebuild_the_same_key() {
        let (id, _) = Identity::create("a", "password1").unwrap();
        assert_eq!(Identity::from_secret("a", &id.secret_hex()).unwrap().public_key(), id.public_key());
    }

    #[test]
    fn private_data_opens_only_for_the_same_id() {
        let (a, _) = Identity::create("a", "password1").unwrap();
        let (b, _) = Identity::create("b", "password1").unwrap();
        let sealed = a.seal_private(b"servers");
        assert_eq!(a.open_private(&sealed).unwrap(), b"servers");
        assert!(b.open_private(&sealed).is_err());
        // Another device restored from the same phrase reads it too.
        let again = Identity::restore("a", &a.recovery_phrase(), "password2").unwrap().0;
        assert_eq!(again.open_private(&sealed).unwrap(), b"servers");
    }

    #[test]
    fn direct_messages_open_only_for_the_two_people() {
        let (a, _) = Identity::create("a", "password1").unwrap();
        let (b, _) = Identity::create("b", "password1").unwrap();
        let (eve, _) = Identity::create("eve", "password1").unwrap();
        let sealed = a.seal_for(&b.public_key(), b"hello").unwrap();
        assert_eq!(b.open_from(&a.public_key(), &sealed).unwrap(), b"hello");
        // The sender can read their own copy on any device.
        assert_eq!(a.open_from(&b.public_key(), &sealed).unwrap(), b"hello");
        assert!(eve.open_from(&a.public_key(), &sealed).is_err());
        assert!(eve.open_from(&b.public_key(), &sealed).is_err());
    }
}
