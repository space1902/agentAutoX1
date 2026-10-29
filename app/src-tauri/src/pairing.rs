//! Parses the warm-up engine's log lines to surface WhatsApp pairing codes in the UI.
//!
//! Engine formats (engines/warmup/lib.js):
//!   `[bot] Pairing code: 4VCA-D52H`
//!   `On the phone for "bot" (+573167585233): WhatsApp > Linked devices > ...`
//!   `[bot] ready`

use serde::Serialize;

#[derive(Debug, PartialEq, Eq)]
pub enum PairingEvent {
    Code { id: String, code: String },
    Phone { id: String, phone: String },
    Ready { id: String },
}

/// One pairing code waiting to be typed on a phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCard {
    pub id: String,
    pub code: String,
    pub phone: Option<String>,
}

/// Recognizes the pairing-related engine lines; anything else returns `None`.
pub fn parse_line(line: &str) -> Option<PairingEvent> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix('[') {
        let (id, tail) = rest.split_once(']')?;
        let id = id.trim();
        if id.is_empty() || id.contains(char::is_whitespace) {
            return None;
        }
        let tail = tail.trim();
        if tail == "ready" {
            return Some(PairingEvent::Ready { id: id.to_string() });
        }
        let code = tail.strip_prefix("Pairing code:")?.trim();
        if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        return Some(PairingEvent::Code { id: id.to_string(), code: code.to_string() });
    }
    let rest = line.strip_prefix("On the phone for \"")?;
    let (id, tail) = rest.split_once('"')?;
    let tail = tail.trim().strip_prefix("(+")?;
    let (phone, _) = tail.split_once(')')?;
    if id.is_empty() || phone.is_empty() || !phone.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(PairingEvent::Phone { id: id.to_string(), phone: phone.to_string() })
}

/// Current set of visible pairing cards, in the order they first appeared.
#[derive(Default, Debug)]
pub struct PairingTracker {
    cards: Vec<PairingCard>,
}

impl PairingTracker {
    pub fn cards(&self) -> Vec<PairingCard> {
        self.cards.clone()
    }

    pub fn clear(&mut self) -> bool {
        let changed = !self.cards.is_empty();
        self.cards.clear();
        changed
    }

    /// Feeds one stdout line; returns true when the visible cards changed.
    pub fn feed(&mut self, line: &str) -> bool {
        let Some(event) = parse_line(line) else { return false };
        match event {
            PairingEvent::Code { id, code } => {
                match self.cards.iter_mut().find(|c| c.id == id) {
                    Some(card) if card.code == code => return false,
                    Some(card) => card.code = code,
                    None => self.cards.push(PairingCard { id, code, phone: None }),
                }
                true
            }
            PairingEvent::Phone { id, phone } => match self.cards.iter_mut().find(|c| c.id == id) {
                Some(card) if card.phone.as_deref() != Some(phone.as_str()) => {
                    card.phone = Some(phone);
                    true
                }
                _ => false,
            },
            PairingEvent::Ready { id } => {
                let before = self.cards.len();
                self.cards.retain(|c| c.id != id);
                self.cards.len() != before
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(id: &str, code: &str) -> PairingEvent {
        PairingEvent::Code { id: id.into(), code: code.into() }
    }

    #[test]
    fn parses_pairing_code_for_bot_and_testers() {
        assert_eq!(parse_line("[bot] Pairing code: 4VCA-D52H"), Some(code("bot", "4VCA-D52H")));
        assert_eq!(parse_line("[tester15] Pairing code: ABCD-1234\r"), Some(code("tester15", "ABCD-1234")));
        assert_eq!(parse_line("  [bot]   Pairing code:   4VCA-D52H  "), Some(code("bot", "4VCA-D52H")));
    }

    #[test]
    fn parses_phone_line() {
        let line = "On the phone for \"bot\" (+573167585233): WhatsApp > Linked devices > Link a device > Link with phone number instead, then type the code.";
        assert_eq!(parse_line(line), Some(PairingEvent::Phone { id: "bot".into(), phone: "573167585233".into() }));
    }

    #[test]
    fn parses_ready() {
        assert_eq!(parse_line("[tester3] ready"), Some(PairingEvent::Ready { id: "tester3".into() }));
    }

    #[test]
    fn ignores_unrelated_or_malformed_lines() {
        for l in [
            "",
            "[bot] disconnected: 428",
            "[bot] Pairing code:",
            "[bot] Pairing code: not a code!",
            "[bot] readyness",
            "[] ready",
            "[two words] ready",
            "Pairing code: 4VCA-D52H",
            "On the phone for \"bot\" (no phone)",
            "On the phone for \"bot\" (+abc): x",
            "[bot] Scan this QR from WhatsApp",
        ] {
            assert_eq!(parse_line(l), None, "line: {l:?}");
        }
    }

    #[test]
    fn tracker_shows_code_then_phone() {
        let mut t = PairingTracker::default();
        assert!(t.feed("[bot] Pairing code: AAAA-1111"));
        assert!(t.feed("On the phone for \"bot\" (+573167585233): WhatsApp > Linked devices"));
        assert_eq!(t.cards(), vec![PairingCard { id: "bot".into(), code: "AAAA-1111".into(), phone: Some("573167585233".into()) }]);
    }

    #[test]
    fn tracker_replaces_code_for_same_number_and_keeps_phone() {
        let mut t = PairingTracker::default();
        t.feed("[bot] Pairing code: AAAA-1111");
        t.feed("On the phone for \"bot\" (+573167585233): x");
        assert!(t.feed("[bot] Pairing code: BBBB-2222"));
        assert!(!t.feed("[bot] Pairing code: BBBB-2222"), "same code is not a change");
        let cards = t.cards();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].code, "BBBB-2222");
        assert_eq!(cards[0].phone.as_deref(), Some("573167585233"));
    }

    #[test]
    fn tracker_stacks_several_numbers_and_hides_on_ready() {
        let mut t = PairingTracker::default();
        t.feed("[bot] Pairing code: AAAA-1111");
        t.feed("[tester2] Pairing code: CCCC-3333");
        assert_eq!(t.cards().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["bot", "tester2"]);
        assert!(t.feed("[bot] ready"));
        assert_eq!(t.cards().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["tester2"]);
        assert!(!t.feed("[bot] ready"), "ready without a card is not a change");
    }

    #[test]
    fn tracker_ignores_phone_without_card_and_clears() {
        let mut t = PairingTracker::default();
        assert!(!t.feed("On the phone for \"bot\" (+573167585233): x"));
        t.feed("[bot] Pairing code: AAAA-1111");
        assert!(t.clear());
        assert!(!t.clear());
        assert!(t.cards().is_empty());
    }
}
