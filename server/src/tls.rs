//! The server's TLS identity. Made once, the first time the server starts, and kept in its data
//! folder: the app knows the server by this key (its pin is in every invite link), so the
//! connection can't be read or taken over on the way, with no certificate authority involved.

use std::path::Path;
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;

pub struct Tls {
    pub acceptor: TlsAcceptor,
    /// What goes before the address in invite links (`strom_shared::cert_pin`).
    pub pin: String,
}

const CERT_FILE: &str = "tls-cert.der";
const KEY_FILE: &str = "tls-key.der";

/// Loads the server's key from `dir`, or makes one and saves it there.
pub fn load_or_create(dir: &Path) -> anyhow::Result<Tls> {
    let (cert_path, key_path) = (dir.join(CERT_FILE), dir.join(KEY_FILE));
    let (cert, key) = match (std::fs::read(&cert_path), std::fs::read(&key_path)) {
        (Ok(cert), Ok(key)) => (cert, key),
        _ => {
            let made = rcgen::generate_simple_self_signed(vec!["hopp-server".to_string()])?;
            let cert = made.cert.der().to_vec();
            let key = made.key_pair.serialize_der();
            std::fs::create_dir_all(dir)?;
            std::fs::write(&cert_path, &cert)?;
            std::fs::write(&key_path, &key)?;
            (cert, key)
        }
    };
    let pin = strom_shared::cert_pin(&cert);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))?;
    Ok(Tls { acceptor: TlsAcceptor::from(Arc::new(config)), pin })
}
