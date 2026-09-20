//! API key storage.
//!
//! Keys go to the OS keyring (Secret Service on Linux, Credential Manager on
//! Windows, Keychain on macOS) and never to Forge's config file, which is
//! plain JSON. The keyring is unavailable on some headless Linux setups; that
//! is reported rather than silently falling back to writing the key to disk.

use keyring::Entry;

const SERVICE: &str = "forge";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|error| format!("keyring unavailable: {error}"))
}

pub fn set(account: &str, key: &str) -> Result<(), String> {
    let entry = entry(account)?;
    if key.trim().is_empty() {
        return delete(account);
    }
    entry
        .set_password(key.trim())
        .map_err(|error| format!("could not store the key: {error}"))
}

pub fn get(account: &str) -> Option<String> {
    entry(account)
        .ok()?
        .get_password()
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        // Clearing a key that was never set is success, not failure.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("could not clear the key: {error}")),
    }
}

pub fn has(account: &str) -> bool {
    get(account).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests run in parallel against one real keyring, so each owns an account.
    const ROUND_TRIP: &str = "forge-selftest-round-trip";
    const BLANK: &str = "forge-selftest-blank";

    #[test]
    fn keys_round_trip_when_a_keyring_is_available() {
        let account = ROUND_TRIP;
        match set(account, "  secret-value  ") {
            Ok(()) => {
                // Stored trimmed, so a pasted key with whitespace still works.
                assert_eq!(get(account).as_deref(), Some("secret-value"));
                assert!(has(account));

                delete(account).expect("delete");
                assert!(!has(account));
                // Deleting twice is not an error.
                delete(account).expect("idempotent delete");
            }
            Err(message) => {
                // No Secret Service (headless Linux, CI). Degradation must be
                // reported, never a silent fallback to writing the key to disk.
                assert!(
                    message.contains("keyring") || message.contains("could not store"),
                    "unhelpful error: {message}"
                );
                eprintln!("keyring unavailable on this host: {message}");
            }
        }
    }

    #[test]
    fn an_empty_key_clears_rather_than_storing_blank() {
        if set(BLANK, "value").is_err() {
            return; // no keyring here
        }
        set(BLANK, "   ").expect("blank clears");
        assert!(!has(BLANK), "a blank key must not be stored");
    }

    #[test]
    fn a_missing_key_reads_as_absent() {
        assert!(get("forge-account-that-does-not-exist").is_none());
    }
}
