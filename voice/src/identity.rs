//! Ström ID: an Ed25519 key pair that is the user's account on every server.
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

    /// Signs a server's login challenge.
    pub fn sign_challenge(&self, nonce: &[u8]) -> String {
        hex::encode(self.key.sign(&strom_shared::auth_message(nonce)).to_bytes())
    }
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
        let (created, stored) = Identity::create("Marcus", "hemligt lösen").unwrap();
        let unlocked = Identity::unlock(&stored, "hemligt lösen").unwrap();
        assert_eq!(unlocked.public_key(), created.public_key());
        assert_eq!(unlocked.name, "Marcus");

        let err = Identity::unlock(&stored, "fel lösen").err().unwrap();
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
}
