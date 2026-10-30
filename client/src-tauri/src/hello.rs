//! Windows Hello: confirms it's really you (PIN, fingerprint or face) when you're
//! logged in but have forgotten your password.

#[cfg(windows)]
mod imp {
    use windows::core::{factory, HSTRING};
    use windows_future::IAsyncOperation;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.join())
            .is_ok_and(|a| a == UserConsentVerifierAvailability::Available)
    }

    /// Shows the Windows Hello prompt over `window` and blocks until it's answered.
    pub fn verify(window: isize, message: &str) -> anyhow::Result<bool> {
        anyhow::ensure!(
            available(),
            "Windows Hello isn't set up on this computer. Add a PIN under Settings → Accounts → Sign-in options."
        );
        // Desktop apps must say which window the prompt belongs to.
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        let op: IAsyncOperation<UserConsentVerificationResult> =
            unsafe { interop.RequestVerificationForWindowAsync(HWND(window as _), &HSTRING::from(message))? };
        Ok(op.join()? == UserConsentVerificationResult::Verified)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn available() -> bool {
        false
    }

    pub fn verify(_window: isize, _message: &str) -> anyhow::Result<bool> {
        anyhow::bail!("Windows Hello is only available on Windows.")
    }
}

pub use imp::{available, verify};
